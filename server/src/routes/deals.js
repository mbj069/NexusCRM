// Deals: creation runs in a transaction that books the property, so a
// double-booking attempt fails atomically with 409.

import { Router } from 'express';
import { db, camel, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

const VALID_STAGES = ['proposed', 'token_paid', 'in_progress', 'closed_won', 'closed_lost', 'cancelled'];
const VALID_COMMISSION_TYPES = ['percent', 'fixed'];

function commissionAmount(dealValue, type, value) {
  return type === 'percent' ? (dealValue * value) / 100 : value;
}

// GET /api/deals?stage=&agentId=
router.get('/', ah(async (req, res) => {
  const { stage, agentId } = req.query;
  const where = [];
  const params = [];
  if (stage) {
    if (!VALID_STAGES.includes(stage)) throw httpError(400, `Invalid stage. Use one of: ${VALID_STAGES.join(', ')}.`);
    where.push('d.stage = ?'); params.push(stage);
  }
  if (agentId) { where.push('d.agent_id = ?'); params.push(agentId); }
  const sql = `SELECT d.*, l.name AS lead_name, p.code AS property_code, p.title AS property_title,
      u.name AS agent_name FROM deals d
    LEFT JOIN leads l ON l.id = d.lead_id
    LEFT JOIN properties p ON p.id = d.property_id
    LEFT JOIN users u ON u.id = d.agent_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.updated_at DESC`;
  res.json((await db.prepare(sql).all(...params)).map(camel));
}));

// POST /api/deals — transactional: property must be Available; on success it
// becomes Booked and a pending commission row is created.
router.post('/', ah(async (req, res) => {
  const { leadId, propertyId, dealValue, bayanaAmount = 0, commissionType = 'percent',
    commissionValue = 0, notes = '', agentId } = req.body || {};
  if (!propertyId) throw httpError(400, 'propertyId is required.');
  if (!(Number(dealValue) > 0)) throw httpError(400, 'dealValue must be a positive number.');
  if (!VALID_COMMISSION_TYPES.includes(commissionType)) {
    throw httpError(400, `commissionType must be one of: ${VALID_COMMISSION_TYPES.join(', ')}.`);
  }
  if (leadId) {
    const lead = await db.prepare('SELECT id FROM leads WHERE id = ?').get(leadId);
    if (!lead) throw httpError(400, 'Lead not found.');
  }
  const agent = agentId || req.user.sub;
  const agentRow = await db.prepare('SELECT id FROM users WHERE id = ?').get(agent);
  if (!agentRow) throw httpError(400, 'Agent not found.');

  const dealId = uid();
  const value = Number(dealValue);
  const commValue = Number(commissionValue) || 0;
  const commAmount = commissionAmount(value, commissionType, commValue);

  await withTransaction(async (tx) => {
    const prop = await tx.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
    if (!prop) throw httpError(404, 'Property not found.');
    if (prop.status !== 'Available') {
      throw httpError(409, `Property is not available (current status: ${prop.status}).`);
    }
    await tx.prepare(`INSERT INTO deals (id, lead_id, property_id, agent_id, stage, deal_value,
        bayana_amount, commission_type, commission_value, notes)
      VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`)
      .run(dealId, leadId || null, propertyId, agent, value, Number(bayanaAmount) || 0,
        commissionType, commValue, String(notes));
    await tx.prepare(`UPDATE properties SET status = 'Booked', updated_at = datetime('now') WHERE id = ?`)
      .run(propertyId);
    const commId = uid();
    await tx.prepare('INSERT INTO commissions (id, deal_id, agent_id, amount, status) VALUES (?, ?, ?, ?, ?)')
      .run(commId, dealId, agent, commAmount, 'pending');
    await auditReq(req, 'DEAL_CREATE', { entityType: 'deal', entityId: dealId, details: `Deal created: ${prop.code} @ ${value} (agent ${agent}).` }, tx);
    await auditReq(req, 'PROPERTY_ASSIGN', { entityType: 'property', entityId: propertyId, details: `Property ${prop.code} booked by deal ${dealId}.` }, tx);
  });

  const deal = await db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
  res.status(201).json(camel(deal));
}));

// GET /api/deals/:id — embeds lead, property, plan summary, payments
router.get('/:id', ah(async (req, res) => {
  const row = await db.prepare(`SELECT d.*, l.name AS lead_name, u.name AS agent_name FROM deals d
    LEFT JOIN leads l ON l.id = d.lead_id LEFT JOIN users u ON u.id = d.agent_id
    WHERE d.id = ?`).get(req.params.id);
  if (!row) throw httpError(404, 'Deal not found.');
  const deal = camel(row);
  deal.lead = row.lead_id ? camel(await db.prepare('SELECT * FROM leads WHERE id = ?').get(row.lead_id)) : null;
  deal.property = row.property_id ? camel(await db.prepare('SELECT * FROM properties WHERE id = ?').get(row.property_id)) : null;
  deal.commissions = (await db.prepare(`SELECT c.*, u.name AS agent_name FROM commissions c
    LEFT JOIN users u ON u.id = c.agent_id WHERE c.deal_id = ?`).all(req.params.id)).map(camel);
  const plans = (await db.prepare('SELECT * FROM payment_plans WHERE deal_id = ?').all(req.params.id)).map(camel);
  for (const plan of plans) {
    plan.schedule = (await db.prepare('SELECT * FROM payment_schedule WHERE plan_id = ? ORDER BY seq').all(plan.id)).map(camel);
    plan.payments = (await db.prepare('SELECT * FROM payments WHERE plan_id = ? ORDER BY created_at').all(plan.id)).map(camel);
    plan.totalPaid = plan.payments.reduce((s, p) => s + p.amount, 0);
  }
  deal.plans = plans;
  deal.activities = (await db.prepare(`SELECT a.*, u.name AS actor_name FROM activities a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.entity_type = 'deal' AND a.entity_id = ? ORDER BY a.created_at DESC`)
    .all(req.params.id)).map(camel);
  res.json(deal);
}));

// PUT /api/deals/:id — update terms (not stage; use /stage)
router.put('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Deal not found.');
  if (['closed_won', 'closed_lost', 'cancelled'].includes(row.stage)) {
    throw httpError(400, `Deal is ${row.stage} and can no longer be edited.`);
  }
  const { leadId, dealValue, bayanaAmount, commissionType, commissionValue, notes, agentId } = req.body || {};
  if (commissionType !== undefined && !VALID_COMMISSION_TYPES.includes(commissionType)) {
    throw httpError(400, `commissionType must be one of: ${VALID_COMMISSION_TYPES.join(', ')}.`);
  }
  if (dealValue !== undefined && !(Number(dealValue) > 0)) throw httpError(400, 'dealValue must be positive.');
  await db.prepare(`UPDATE deals SET lead_id = COALESCE(?, lead_id), deal_value = COALESCE(?, deal_value),
    bayana_amount = COALESCE(?, bayana_amount), commission_type = COALESCE(?, commission_type),
    commission_value = COALESCE(?, commission_value), notes = COALESCE(?, notes),
    agent_id = COALESCE(?, agent_id), updated_at = datetime('now') WHERE id = ?`)
    .run(leadId ?? null, dealValue !== undefined ? Number(dealValue) : null,
      bayanaAmount !== undefined ? Number(bayanaAmount) || 0 : null,
      commissionType ?? null, commissionValue !== undefined ? Number(commissionValue) || 0 : null,
      notes !== undefined ? String(notes) : null, agentId ?? null, req.params.id);
  // Keep the pending commission in sync with edited terms.
  const updated = await db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  const newComm = commissionAmount(updated.deal_value, updated.commission_type, updated.commission_value);
  await db.prepare(`UPDATE commissions SET amount = ?, agent_id = ? WHERE deal_id = ? AND status = 'pending'`)
    .run(newComm, updated.agent_id, req.params.id);
  auditReq(req, 'DEAL_UPDATE', { entityType: 'deal', entityId: req.params.id, details: `Updated deal terms.` });
  res.json(camel(await db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id)));
}));

// POST /api/deals/:id/stage { stage }
// closed_won -> property Sold; closed_lost/cancelled -> property Available;
// token_paid/in_progress keep Booked.
router.post('/:id/stage', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Deal not found.');
  const { stage } = req.body || {};
  if (!VALID_STAGES.includes(stage)) throw httpError(400, `Stage must be one of: ${VALID_STAGES.join(', ')}.`);
  if (stage === row.stage) return res.json(camel(row));

  await withTransaction(async (tx) => {
    await tx.prepare(`UPDATE deals SET stage = ?, updated_at = datetime('now') WHERE id = ?`).run(stage, req.params.id);
    const prop = row.property_id ? await tx.prepare('SELECT * FROM properties WHERE id = ?').get(row.property_id) : null;
    if (prop) {
      if (stage === 'closed_won' && prop.status !== 'Sold') {
        await tx.prepare(`UPDATE properties SET status = 'Sold', updated_at = datetime('now') WHERE id = ?`).run(prop.id);
        await auditReq(req, 'PROPERTY_ASSIGN', { entityType: 'property', entityId: prop.id, details: `Property ${prop.code} sold via deal ${req.params.id}.` }, tx);
      } else if ((stage === 'closed_lost' || stage === 'cancelled') && prop.status === 'Booked') {
        await tx.prepare(`UPDATE properties SET status = 'Available', updated_at = datetime('now') WHERE id = ?`).run(prop.id);
        await auditReq(req, 'PROPERTY_ASSIGN', { entityType: 'property', entityId: prop.id, details: `Property ${prop.code} released (deal ${req.params.id} ${stage}).` }, tx);
      }
    }
    await tx.prepare(`INSERT INTO activities (id, entity_type, entity_id, actor_id, kind, text)
      VALUES (?, 'deal', ?, ?, 'stage_change', ?)`)
      .run(uid(), req.params.id, req.user.sub, `Stage changed: ${row.stage} → ${stage}`);
    await auditReq(req, 'DEAL_STAGE', { entityType: 'deal', entityId: req.params.id, details: `Deal ${req.params.id}: ${row.stage} → ${stage}.` }, tx);
  });
  res.json(camel(await db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id)));
}));

export default router;
