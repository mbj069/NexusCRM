// Leads CRUD + pipeline stage moves + rules-based scoring.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid, daysBetween, todayStr } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

const VALID_SOURCES = ['website', 'WhatsApp', 'social', 'manual', 'referral'];
const VALID_STAGES = ['new', 'contacted', 'viewing', 'negotiating', 'won', 'lost'];

// GET /api/leads?stage=&q=
router.get('/', ah(async (req, res) => {
  const { stage, q } = req.query;
  const where = [];
  const params = [];
  if (stage) {
    if (!VALID_STAGES.includes(stage)) throw httpError(400, `Invalid stage. Use one of: ${VALID_STAGES.join(', ')}.`);
    where.push('stage = ?'); params.push(stage);
  }
  if (q?.trim()) {
    const like = `%${q.trim()}%`;
    where.push('(name LIKE ? OR phone LIKE ? OR whatsapp LIKE ? OR interest LIKE ?)');
    params.push(like, like, like, like);
  }
  const sql = `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
  res.json(db.prepare(sql).all(...params).map(camel));
}));

// POST /api/leads
router.post('/', ah(async (req, res) => {
  const { contactId = null, name, phone = '', whatsapp = '', source = 'manual', interest = '',
    budgetMin = 0, budgetMax = 0, stage = 'new', ownerId, notes = '' } = req.body || {};
  if (!name?.trim()) throw httpError(400, 'Name is required.');
  if (!VALID_SOURCES.includes(source)) throw httpError(400, `Source must be one of: ${VALID_SOURCES.join(', ')}.`);
  if (!VALID_STAGES.includes(stage)) throw httpError(400, `Stage must be one of: ${VALID_STAGES.join(', ')}.`);
  if (contactId) {
    const c = db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId);
    if (!c) throw httpError(400, 'Linked contact not found.');
  }
  const id = uid();
  db.prepare(`INSERT INTO leads (id, contact_id, name, phone, whatsapp, source, interest,
      budget_min, budget_max, stage, owner_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, contactId, name.trim(), String(phone).trim(), String(whatsapp).trim(), source,
      String(interest), Number(budgetMin) || 0, Number(budgetMax) || 0, stage,
      ownerId || req.user.sub, String(notes));
  auditReq(req, 'LEAD_CREATE', { entityType: 'lead', entityId: id, details: `Created lead ${name.trim()} (stage: ${stage}).` });
  res.status(201).json(camel(db.prepare('SELECT * FROM leads WHERE id = ?').get(id)));
}));

// GET /api/leads/:id (with contact, activities, follow-ups)
router.get('/:id', ah(async (req, res) => {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  const lead = camel(row);
  lead.contact = row.contact_id ? camel(db.prepare('SELECT * FROM contacts WHERE id = ?').get(row.contact_id)) : null;
  lead.activities = db.prepare(`SELECT a.*, u.name AS actor_name FROM activities a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.entity_type = 'lead' AND a.entity_id = ? ORDER BY a.created_at DESC`)
    .all(req.params.id).map(camel);
  lead.followups = db.prepare(`SELECT * FROM followups
    WHERE entity_type = 'lead' AND entity_id = ? ORDER BY due_date`).all(req.params.id).map(camel);
  res.json(lead);
}));

// PUT /api/leads/:id
router.put('/:id', ah(async (req, res) => {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  const { contactId, name, phone, whatsapp, source, interest, budgetMin, budgetMax, stage, ownerId, notes } = req.body || {};
  if (name !== undefined && !String(name).trim()) throw httpError(400, 'Name cannot be empty.');
  if (source !== undefined && !VALID_SOURCES.includes(source)) throw httpError(400, `Source must be one of: ${VALID_SOURCES.join(', ')}.`);
  if (stage !== undefined && !VALID_STAGES.includes(stage)) throw httpError(400, `Stage must be one of: ${VALID_STAGES.join(', ')}.`);
  if (contactId !== undefined && contactId !== null) {
    const c = db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId);
    if (!c) throw httpError(400, 'Linked contact not found.');
  }
  const oldStage = row.stage;
  db.prepare(`UPDATE leads SET
      contact_id = ?, name = COALESCE(?, name), phone = COALESCE(?, phone),
      whatsapp = COALESCE(?, whatsapp), source = COALESCE(?, source), interest = COALESCE(?, interest),
      budget_min = COALESCE(?, budget_min), budget_max = COALESCE(?, budget_max),
      stage = COALESCE(?, stage), owner_id = COALESCE(?, owner_id), notes = COALESCE(?, notes),
      updated_at = datetime('now') WHERE id = ?`)
    .run(
      contactId === undefined ? row.contact_id : contactId,
      name !== undefined ? String(name).trim() : null,
      phone !== undefined ? String(phone).trim() : null,
      whatsapp !== undefined ? String(whatsapp).trim() : null,
      source ?? null, interest !== undefined ? String(interest) : null,
      budgetMin !== undefined ? Number(budgetMin) || 0 : null,
      budgetMax !== undefined ? Number(budgetMax) || 0 : null,
      stage ?? null, ownerId ?? null, notes !== undefined ? String(notes) : null,
      req.params.id
    );
  if (stage && stage !== oldStage) {
    db.prepare(`INSERT INTO activities (id, entity_type, entity_id, actor_id, kind, text)
      VALUES (?, 'lead', ?, ?, 'stage_change', ?)`)
      .run(uid(), req.params.id, req.user.sub, `Stage changed: ${oldStage} → ${stage}`);
    auditReq(req, 'LEAD_STAGE', { entityType: 'lead', entityId: req.params.id, details: `Lead ${row.name}: ${oldStage} → ${stage}.` });
  } else {
    auditReq(req, 'LEAD_UPDATE', { entityType: 'lead', entityId: req.params.id, details: `Updated lead ${row.name}.` });
  }
  res.json(camel(db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)));
}));

// POST /api/leads/:id/stage { stage } — explicit pipeline move
router.post('/:id/stage', ah(async (req, res) => {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  const { stage } = req.body || {};
  if (!VALID_STAGES.includes(stage)) throw httpError(400, `Stage must be one of: ${VALID_STAGES.join(', ')}.`);
  if (stage === row.stage) return res.json(camel(row));
  db.prepare(`UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE id = ?`).run(stage, req.params.id);
  db.prepare(`INSERT INTO activities (id, entity_type, entity_id, actor_id, kind, text)
    VALUES (?, 'lead', ?, ?, 'stage_change', ?)`)
    .run(uid(), req.params.id, req.user.sub, `Stage changed: ${row.stage} → ${stage}`);
  auditReq(req, 'LEAD_STAGE', { entityType: 'lead', entityId: req.params.id, details: `Lead ${row.name}: ${row.stage} → ${stage}.` });
  res.json(camel(db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)));
}));

// POST /api/leads/:id/score — rules-based score, stored on the lead
router.post('/:id/score', ah(async (req, res) => {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  const breakdown = [];
  let score = 0;
  const add = (pts, label) => { score += pts; breakdown.push(`+${pts} ${label}`); };

  if (row.phone?.trim()) add(10, 'has phone number');
  if (row.whatsapp?.trim()) add(10, 'has WhatsApp number');
  if (row.source === 'website' || row.source === 'WhatsApp') add(10, `source: ${row.source}`);
  else if (row.source === 'referral') add(15, 'source: referral');
  const stagePts = { contacted: 10, viewing: 20, negotiating: 30 }[row.stage] || 0;
  if (stagePts) add(stagePts, `pipeline stage: ${row.stage}`);
  const recent = db.prepare(`SELECT COUNT(*) AS n FROM activities
    WHERE entity_type = 'lead' AND entity_id = ? AND created_at >= datetime('now', '-7 days')`)
    .get(req.params.id).n;
  if (recent > 0) add(10, 'recent activity (< 7 days)');
  if ((row.budget_min || 0) > 0 || (row.budget_max || 0) > 0) add(10, 'budget specified');
  score = Math.min(100, score);

  db.prepare('UPDATE leads SET score = ?, updated_at = datetime(\'now\') WHERE id = ?').run(score, req.params.id);
  auditReq(req, 'LEAD_SCORE', { entityType: 'lead', entityId: req.params.id, details: `Rules-based score for ${row.name}: ${score}/100.` });
  res.json({ score, breakdown });
}));

// DELETE /api/leads/:id
router.delete('/:id', ah(async (req, res) => {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  const dealCount = db.prepare('SELECT COUNT(*) AS n FROM deals WHERE lead_id = ?').get(req.params.id).n;
  if (dealCount > 0) throw httpError(409, `Cannot delete: lead has ${dealCount} deal(s).`);
  db.prepare('DELETE FROM activities WHERE entity_type = ? AND entity_id = ?').run('lead', req.params.id);
  db.prepare('DELETE FROM followups WHERE entity_type = ? AND entity_id = ?').run('lead', req.params.id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  auditReq(req, 'LEAD_DELETE', { entityType: 'lead', entityId: req.params.id, details: `Deleted lead ${row.name}.` });
  res.json({ ok: true });
}));

export default router;
