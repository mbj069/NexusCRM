// Leads CRUD + pipeline stage moves + rules-based scoring + assignment.
//
// Scoping: agents only ever see leads assigned to them (assigned_to = self).
// Unassigned leads are visible to manager/admin only. Assignment is done by
// manager/admin via POST /:id/assign.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, can } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid, daysBetween, todayStr } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

const VALID_SOURCES = ['website', 'WhatsApp', 'social', 'manual', 'referral'];
const VALID_STAGES = ['new', 'contacted', 'viewing', 'negotiating', 'won', 'lost'];
const VALID_INTENTS = ['buy', 'rent'];

const isAgent = (req) => req.user.role === 'agent';

// Agents may only touch leads assigned to them; everyone else sees all.
function assertLeadVisible(req, row) {
  if (isAgent(req) && row.assigned_to !== req.user.sub) {
    throw httpError(403, 'Lead not assigned to you.');
  }
}

// Validate an assignee id: must be an existing agent user (or null to
// unassign). Throws 400 on a bad id.
async function resolveAssignee(assignedTo) {
  if (assignedTo === undefined || assignedTo === null || assignedTo === '') return null;
  const user = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(assignedTo);
  if (!user) throw httpError(400, 'Assignee not found.');
  if (user.role !== 'agent') throw httpError(400, 'Leads can only be assigned to agents.');
  return user.id;
}

// GET /api/leads?stage=&intent=&society=&assignedTo=&q=
router.get('/', ah(async (req, res) => {
  const { stage, intent, society, assignedTo, q } = req.query;
  const where = [];
  const params = [];
  if (isAgent(req)) {
    // Agent scoping is server-side and not overridable by query params.
    where.push('l.assigned_to = ?'); params.push(req.user.sub);
  } else if (assignedTo) {
    where.push('l.assigned_to = ?'); params.push(assignedTo);
  }
  if (stage) {
    if (!VALID_STAGES.includes(stage)) throw httpError(400, `Invalid stage. Use one of: ${VALID_STAGES.join(', ')}.`);
    where.push('l.stage = ?'); params.push(stage);
  }
  if (intent) {
    if (!VALID_INTENTS.includes(intent)) throw httpError(400, `Invalid intent. Use one of: ${VALID_INTENTS.join(', ')}.`);
    where.push('l.intent = ?'); params.push(intent);
  }
  if (society) {
    where.push('l.society = ?'); params.push(society);
  }
  if (q?.trim()) {
    const like = `%${q.trim()}%`;
    where.push('(l.name LIKE ? OR l.phone LIKE ? OR l.whatsapp LIKE ? OR l.interest LIKE ? OR l.society LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const sql = `SELECT l.*, u.name AS assigned_name FROM leads l
    LEFT JOIN users u ON u.id = l.assigned_to
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.updated_at DESC`;
  res.json((await db.prepare(sql).all(...params)).map(camel));
}));

// POST /api/leads
router.post('/', ah(async (req, res) => {
  const { contactId = null, name, phone = '', whatsapp = '', source = 'manual', interest = '',
    intent = 'buy', society = '', budgetMin = 0, budgetMax = 0, stage = 'new', ownerId,
    assignedTo, notes = '' } = req.body || {};
  if (!name?.trim()) throw httpError(400, 'Name is required.');
  if (!VALID_SOURCES.includes(source)) throw httpError(400, `Source must be one of: ${VALID_SOURCES.join(', ')}.`);
  if (!VALID_STAGES.includes(stage)) throw httpError(400, `Stage must be one of: ${VALID_STAGES.join(', ')}.`);
  if (!VALID_INTENTS.includes(intent)) throw httpError(400, `Intent must be one of: ${VALID_INTENTS.join(', ')}.`);
  if (contactId) {
    const c = await db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId);
    if (!c) throw httpError(400, 'Linked contact not found.');
  }
  // Agents create leads for themselves; manager/admin may assign at creation.
  const assignee = isAgent(req) ? req.user.sub : await resolveAssignee(assignedTo);
  const id = uid();
  await db.prepare(`INSERT INTO leads (id, contact_id, name, phone, whatsapp, source, interest,
      intent, society, budget_min, budget_max, stage, owner_id, assigned_to, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, contactId, name.trim(), String(phone).trim(), String(whatsapp).trim(), source,
      String(interest), intent, String(society).trim(), Number(budgetMin) || 0, Number(budgetMax) || 0, stage,
      ownerId || req.user.sub, assignee, String(notes));
  auditReq(req, 'LEAD_CREATE', { entityType: 'lead', entityId: id, details: `Created lead ${name.trim()} (intent: ${intent}, stage: ${stage}${assignee ? ', assigned' : ''}).` });
  res.status(201).json(camel(await db.prepare('SELECT * FROM leads WHERE id = ?').get(id)));
}));

// GET /api/leads/:id (with contact, assignee, activities, follow-ups)
router.get('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  assertLeadVisible(req, row);
  const lead = camel(row);
  lead.contact = row.contact_id ? camel(await db.prepare('SELECT * FROM contacts WHERE id = ?').get(row.contact_id)) : null;
  lead.assignedAgent = row.assigned_to ? camel(await db.prepare('SELECT id, name, username FROM users WHERE id = ?').get(row.assigned_to)) : null;
  lead.activities = (await db.prepare(`SELECT a.*, u.name AS actor_name FROM activities a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.entity_type = 'lead' AND a.entity_id = ? ORDER BY a.created_at DESC`)
    .all(req.params.id)).map(camel);
  lead.followups = (await db.prepare(`SELECT * FROM followups
    WHERE entity_type = 'lead' AND entity_id = ? ORDER BY due_date`).all(req.params.id)).map(camel);
  res.json(lead);
}));

// PUT /api/leads/:id
router.put('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  assertLeadVisible(req, row);
  const { contactId, name, phone, whatsapp, source, interest, intent, society, budgetMin, budgetMax, stage, ownerId, assignedTo, notes } = req.body || {};
  if (name !== undefined && !String(name).trim()) throw httpError(400, 'Name cannot be empty.');
  if (source !== undefined && !VALID_SOURCES.includes(source)) throw httpError(400, `Source must be one of: ${VALID_SOURCES.join(', ')}.`);
  if (stage !== undefined && !VALID_STAGES.includes(stage)) throw httpError(400, `Stage must be one of: ${VALID_STAGES.join(', ')}.`);
  if (intent !== undefined && !VALID_INTENTS.includes(intent)) throw httpError(400, `Intent must be one of: ${VALID_INTENTS.join(', ')}.`);
  if (contactId !== undefined && contactId !== null) {
    const c = await db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId);
    if (!c) throw httpError(400, 'Linked contact not found.');
  }
  // Only manager/admin may (re)assign; an agent passing assignedTo is a 403.
  let nextAssignee = null;
  let assigneeChanged = false;
  if (assignedTo !== undefined) {
    if (isAgent(req)) throw httpError(403, 'Agents cannot reassign leads.');
    nextAssignee = await resolveAssignee(assignedTo);
    assigneeChanged = nextAssignee !== row.assigned_to;
  }
  const oldStage = row.stage;
  await db.prepare(`UPDATE leads SET
      contact_id = ?, name = COALESCE(?, name), phone = COALESCE(?, phone),
      whatsapp = COALESCE(?, whatsapp), source = COALESCE(?, source), interest = COALESCE(?, interest),
      intent = COALESCE(?, intent), society = COALESCE(?, society),
      budget_min = COALESCE(?, budget_min), budget_max = COALESCE(?, budget_max),
      stage = COALESCE(?, stage), owner_id = COALESCE(?, owner_id),
      assigned_to = CASE WHEN ? THEN ? ELSE assigned_to END, notes = COALESCE(?, notes),
      updated_at = datetime('now') WHERE id = ?`)
    .run(
      contactId === undefined ? row.contact_id : contactId,
      name !== undefined ? String(name).trim() : null,
      phone !== undefined ? String(phone).trim() : null,
      whatsapp !== undefined ? String(whatsapp).trim() : null,
      source ?? null, interest !== undefined ? String(interest) : null,
      intent ?? null, society !== undefined ? String(society).trim() : null,
      budgetMin !== undefined ? Number(budgetMin) || 0 : null,
      budgetMax !== undefined ? Number(budgetMax) || 0 : null,
      stage ?? null, ownerId ?? null,
      assignedTo !== undefined ? 1 : 0, nextAssignee,
      notes !== undefined ? String(notes) : null,
      req.params.id
    );
  if (stage && stage !== oldStage) {
    await db.prepare(`INSERT INTO activities (id, entity_type, entity_id, actor_id, kind, text)
      VALUES (?, 'lead', ?, ?, 'stage_change', ?)`)
      .run(uid(), req.params.id, req.user.sub, `Stage changed: ${oldStage} → ${stage}`);
    auditReq(req, 'LEAD_STAGE', { entityType: 'lead', entityId: req.params.id, details: `Lead ${row.name}: ${oldStage} → ${stage}.` });
  } else if (assigneeChanged) {
    const agentName = nextAssignee ? (await db.prepare('SELECT name FROM users WHERE id = ?').get(nextAssignee))?.name : 'unassigned';
    auditReq(req, 'LEAD_ASSIGN', { entityType: 'lead', entityId: req.params.id, details: `Lead ${row.name} assigned to ${agentName}.` });
  } else {
    auditReq(req, 'LEAD_UPDATE', { entityType: 'lead', entityId: req.params.id, details: `Updated lead ${row.name}.` });
  }
  res.json(camel(await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)));
}));

// POST /api/leads/:id/assign { agentId | null } — manager/admin only
router.post('/:id/assign', requirePermission('assign_leads'), ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  const { agentId = null } = req.body || {};
  const assignee = await resolveAssignee(agentId);
  await db.prepare("UPDATE leads SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?").run(assignee, req.params.id);
  const agentName = assignee ? (await db.prepare('SELECT name FROM users WHERE id = ?').get(assignee))?.name : 'unassigned';
  auditReq(req, 'LEAD_ASSIGN', { entityType: 'lead', entityId: req.params.id, details: `Lead ${row.name} assigned to ${agentName}.` });
  res.json(camel(await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)));
}));

// POST /api/leads/:id/stage { stage } — explicit pipeline move
router.post('/:id/stage', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  assertLeadVisible(req, row);
  const { stage } = req.body || {};
  if (!VALID_STAGES.includes(stage)) throw httpError(400, `Stage must be one of: ${VALID_STAGES.join(', ')}.`);
  if (stage === row.stage) return res.json(camel(row));
  await db.prepare(`UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE id = ?`).run(stage, req.params.id);
  await db.prepare(`INSERT INTO activities (id, entity_type, entity_id, actor_id, kind, text)
    VALUES (?, 'lead', ?, ?, 'stage_change', ?)`)
    .run(uid(), req.params.id, req.user.sub, `Stage changed: ${row.stage} → ${stage}`);
  auditReq(req, 'LEAD_STAGE', { entityType: 'lead', entityId: req.params.id, details: `Lead ${row.name}: ${row.stage} → ${stage}.` });
  res.json(camel(await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id)));
}));

// POST /api/leads/:id/score — rules-based score, stored on the lead
router.post('/:id/score', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  assertLeadVisible(req, row);
  const breakdown = [];
  let score = 0;
  const add = (pts, label) => { score += pts; breakdown.push(`+${pts} ${label}`); };

  if (row.phone?.trim()) add(10, 'has phone number');
  if (row.whatsapp?.trim()) add(10, 'has WhatsApp number');
  if (row.source === 'website' || row.source === 'WhatsApp') add(10, `source: ${row.source}`);
  else if (row.source === 'referral') add(15, 'source: referral');
  const stagePts = { contacted: 10, viewing: 20, negotiating: 30 }[row.stage] || 0;
  if (stagePts) add(stagePts, `pipeline stage: ${row.stage}`);
  const recent = (await db.prepare(`SELECT COUNT(*) AS n FROM activities
    WHERE entity_type = 'lead' AND entity_id = ? AND created_at >= datetime('now', '-7 days')`)
    .get(req.params.id)).n;
  if (recent > 0) add(10, 'recent activity (< 7 days)');
  if ((row.budget_min || 0) > 0 || (row.budget_max || 0) > 0) add(10, 'budget specified');
  score = Math.min(100, score);

  await db.prepare('UPDATE leads SET score = ?, updated_at = datetime(\'now\') WHERE id = ?').run(score, req.params.id);
  auditReq(req, 'LEAD_SCORE', { entityType: 'lead', entityId: req.params.id, details: `Rules-based score for ${row.name}: ${score}/100.` });
  res.json({ score, breakdown });
}));

// DELETE /api/leads/:id
router.delete('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Lead not found.');
  assertLeadVisible(req, row);
  const dealCount = (await db.prepare('SELECT COUNT(*) AS n FROM deals WHERE lead_id = ?').get(req.params.id)).n;
  if (dealCount > 0) throw httpError(409, `Cannot delete: lead has ${dealCount} deal(s).`);
  await db.prepare('DELETE FROM activities WHERE entity_type = ? AND entity_id = ?').run('lead', req.params.id);
  await db.prepare('DELETE FROM followups WHERE entity_type = ? AND entity_id = ?').run('lead', req.params.id);
  await db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  auditReq(req, 'LEAD_DELETE', { entityType: 'lead', entityId: req.params.id, details: `Deleted lead ${row.name}.` });
  res.json({ ok: true });
}));

export default router;
