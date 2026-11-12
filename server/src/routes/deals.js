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

const isAgent = (req) => req.user.role === 'agent';

// Agents may only touch their own deals (agent_id = self).
function assertDealVisible(req, row) {
  if (isAgent(req) && row.agent_id !== req.user.sub) {
    throw httpError(403, 'Deal not assigned to you.');
  }
}

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
  if (isAgent(req)) {
    // Agent scoping is server-side and not overridable by query params.
    where.push('d.agent_id = ?'); params.push(req.user.sub);
  } else if (agentId) {
    where.push('d.agent_id = ?'); params.push(agentId);
  }
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
//
// Rental deals: the deal value IS the first month's rent (taken from the
// property's rent_per_month — any passed dealValue is ignored), bayana is
// forced to 0, and the commission is a manual amount, not the auto
// percent/fixed calculation: `commissionPick` ('half' | 'full' month of
// rent) or a free `commissionAmount` (>= 0). One of them is required.
// The commission row is stored with manual=1 and audit-logged
// COMMISSION_MANUAL, exactly like an admin manual override.
router.post('/', ah(async (req, res) => {
  const { leadId, propertyId, dealValue, bayanaAmount = 0, commissionType = 'percent',
    commissionValue = 0, notes = '', agentId, commissionPick, commissionAmount: manualComm,
    agentShareAmount, agentSharePercent } = req.body || {};
  if (!propertyId) throw httpError(400, 'propertyId is required.');
  const propRow = await db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  if (!propRow) throw httpError(404, 'Property not found.');
  const isRental = propRow.listing_type === 'rent';
  let value;
  let commType = commissionType;
  let commValue = Number(commissionValue) || 0;
  let commAmount;
  if (isRental) {
    if (!(Number(propRow.rent_per_month) > 0)) throw httpError(400, 'Rental property has no rent per month set.');
    value = Number(propRow.rent_per_month);
    const hasAmount = manualComm !== undefined && manualComm !== null && manualComm !== '';
    if (!commissionPick && !hasAmount) {
      throw httpError(400, 'Rental deals need a commission: commissionPick ("half" or "full") or a manual commissionAmount.');
    }
    if (commissionPick && !['half', 'full'].includes(commissionPick)) {
      throw httpError(400, 'commissionPick must be "half" or "full".');
    }
    if (hasAmount && !(Number(manualComm) >= 0)) throw httpError(400, 'commissionAmount must be zero or more.');
    commAmount = hasAmount ? Number(manualComm)
      : commissionPick === 'full' ? value : value / 2;
    commType = 'fixed';
    commValue = commAmount;
  } else {
    if (!(Number(dealValue) > 0)) throw httpError(400, 'dealValue must be a positive number.');
    if (!VALID_COMMISSION_TYPES.includes(commissionType)) {
      throw httpError(400, `commissionType must be one of: ${VALID_COMMISSION_TYPES.join(', ')}.`);
    }
    value = Number(dealValue);
    commAmount = commissionAmount(value, commType, commValue);
  }
  // Agent share: the agent's manual portion of the owner's total commission.
  // `agentShareAmount` (>= 0) wins when both are given; otherwise
  // `agentSharePercent` (0–100) computes amount = total × percent/100 and
  // only the AMOUNT is stored. No share given → agent_amount = 0.
  const hasShareAmount = agentShareAmount !== undefined && agentShareAmount !== null && agentShareAmount !== '';
  const hasSharePercent = agentSharePercent !== undefined && agentSharePercent !== null && agentSharePercent !== '';
  if (hasShareAmount && !(Number(agentShareAmount) >= 0)) throw httpError(400, 'agentShareAmount must be zero or more.');
  if (hasSharePercent && !(Number(agentSharePercent) >= 0 && Number(agentSharePercent) <= 100)) {
    throw httpError(400, 'agentSharePercent must be between 0 and 100.');
  }
  // commAmount (the owner total) is fixed by the rental/sale branch above.
  const agentShare = hasShareAmount ? Number(agentShareAmount)
    : hasSharePercent ? (commAmount * Number(agentSharePercent)) / 100 : 0;
  if (leadId) {
    const lead = await db.prepare('SELECT id, assigned_to FROM leads WHERE id = ?').get(leadId);
    if (!lead) throw httpError(400, 'Lead not found.');
    if (isAgent(req) && lead.assigned_to !== req.user.sub) throw httpError(403, 'Lead not assigned to you.');
  }
  // Agents create deals for themselves; manager/admin may pick the agent.
  const agent = isAgent(req) ? req.user.sub : (agentId || req.user.sub);
  const agentRow = await db.prepare('SELECT id FROM users WHERE id = ?').get(agent);
  if (!agentRow) throw httpError(400, 'Agent not found.');

  const dealId = uid();

  await withTransaction(async (tx) => {
    const prop = await tx.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
    if (!prop) throw httpError(404, 'Property not found.');
    if (prop.status !== 'Available') {
      throw httpError(409, `Property is not available (current status: ${prop.status}).`);
    }
    await tx.prepare(`INSERT INTO deals (id, lead_id, property_id, agent_id, stage, deal_value,
        bayana_amount, commission_type, commission_value, notes)
      VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`)
      .run(dealId, leadId || null, propertyId, agent, value, isRental ? 0 : (Number(bayanaAmount) || 0),
        commType, commValue, String(notes));
    await tx.prepare(`UPDATE properties SET status = 'Booked', updated_at = datetime('now') WHERE id = ?`)
      .run(propertyId);
    const commId = uid();
    await tx.prepare(`INSERT INTO commissions (id, deal_id, agent_id, amount, status, manual,
        agent_amount, agent_status, agent_paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`)
      .run(commId, dealId, agent, commAmount, 'pending', isRental ? 1 : 0, agentShare);
    if (isRental) {
      await auditReq(req, 'COMMISSION_MANUAL', { entityType: 'commission', entityId: commId,
        details: `Rental commission set manually (deal ${dealId}, agent ${agent}): ${commAmount}${commissionPick ? ` (${commissionPick} month of rent)` : ' (manual amount)'}.` }, tx);
    }
    if (agentShare > 0) {
      await auditReq(req, 'COMMISSION_AGENT_SHARE', { entityType: 'commission', entityId: commId,
        details: `Agent share set at deal creation (deal ${dealId}, agent ${agent}): ${agentShare} of owner total ${commAmount}.` }, tx);
    }
    await auditReq(req, 'DEAL_CREATE', { entityType: 'deal', entityId: dealId, details: `Deal created: ${prop.code} @ ${value}${isRental ? ' (rental, first month rent)' : ''} (agent ${agent}).` }, tx);
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
  assertDealVisible(req, row);
  const deal = camel(row);
  deal.lead = row.lead_id ? camel(await db.prepare('SELECT * FROM leads WHERE id = ?').get(row.lead_id)) : null;
  deal.property = row.property_id ? camel(await db.prepare('SELECT * FROM properties WHERE id = ?').get(row.property_id)) : null;
  deal.commissions = (await db.prepare(`SELECT c.*, u.name AS agent_name FROM commissions c
    LEFT JOIN users u ON u.id = c.agent_id WHERE c.deal_id = ?`).all(req.params.id)).map(camel);
  // Agents see only their share of a deal's commission, never the owner's
  // totals — strip the owner fields from the embedded rows server-side
  // (the Commissions page already omits the owner summary for agents).
  if (isAgent(req)) {
    deal.commissions = deal.commissions.map((c) => ({
      id: c.id, dealId: c.dealId, agentId: c.agentId, agentName: c.agentName,
      agentAmount: c.agentAmount, agentStatus: c.agentStatus, agentPaidAt: c.agentPaidAt,
      createdAt: c.createdAt,
    }));
  }
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
  assertDealVisible(req, row);
  if (['closed_won', 'closed_lost', 'cancelled'].includes(row.stage)) {
    throw httpError(400, `Deal is ${row.stage} and can no longer be edited.`);
  }
  const { leadId, dealValue, bayanaAmount, commissionType, commissionValue, notes, agentId } = req.body || {};
  if (isAgent(req) && agentId && agentId !== req.user.sub) throw httpError(403, 'Agents cannot reassign deals.');
  // Rental deal value is the monthly rent — it is set from the property at
  // creation and is not editable.
  if (dealValue !== undefined) {
    const prop = row.property_id
      ? await db.prepare('SELECT listing_type FROM properties WHERE id = ?').get(row.property_id) : null;
    if (prop?.listing_type === 'rent') throw httpError(400, 'Rental deal value is the monthly rent and cannot be changed.');
  }
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
  // Keep the pending commission in sync with edited terms — except a
  // manually overridden commission (manual=1), which the admin set
  // deliberately and which term edits must not overwrite.
  const updated = await db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  const newComm = commissionAmount(updated.deal_value, updated.commission_type, updated.commission_value);
  await db.prepare(`UPDATE commissions SET amount = ?, agent_id = ? WHERE deal_id = ? AND status = 'pending' AND manual = 0`)
    .run(newComm, updated.agent_id, req.params.id);
  auditReq(req, 'DEAL_UPDATE', { entityType: 'deal', entityId: req.params.id, details: `Updated deal terms.` });
  res.json(camel(await db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id)));
}));

// POST /api/deals/:id/stage { stage }
// closed_won -> property Sold (sale) or Rented (rental); closed_lost/
// cancelled -> property Available; token_paid/in_progress keep Booked.
router.post('/:id/stage', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM deals WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Deal not found.');
  assertDealVisible(req, row);
  const { stage } = req.body || {};
  if (!VALID_STAGES.includes(stage)) throw httpError(400, `Stage must be one of: ${VALID_STAGES.join(', ')}.`);
  if (stage === row.stage) return res.json(camel(row));

  await withTransaction(async (tx) => {
    await tx.prepare(`UPDATE deals SET stage = ?, updated_at = datetime('now') WHERE id = ?`).run(stage, req.params.id);
    const prop = row.property_id ? await tx.prepare('SELECT * FROM properties WHERE id = ?').get(row.property_id) : null;
    if (prop) {
      if (stage === 'closed_won' && prop.status !== 'Sold' && prop.status !== 'Rented') {
        const isRental = prop.listing_type === 'rent';
        const nextStatus = isRental ? 'Rented' : 'Sold';
        await tx.prepare(`UPDATE properties SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(nextStatus, prop.id);
        await auditReq(req, 'PROPERTY_ASSIGN', { entityType: 'property', entityId: prop.id, details: `Property ${prop.code} ${isRental ? 'rented' : 'sold'} via deal ${req.params.id}.` }, tx);
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
