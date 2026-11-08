// Activities (timeline entries on leads/contacts/deals) and follow-ups.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid, todayStr } from '../util.js';

const ENTITY_TYPES = ['lead', 'contact', 'deal'];
const ACTIVITY_KINDS = ['note', 'call', 'viewing', 'message', 'stage_change'];

// --- Activities ------------------------------------------------------------

export const activitiesRouter = Router();
activitiesRouter.use(requireAuth, requirePermission('crm'));

// GET /api/activities/:entityType/:entityId
activitiesRouter.get('/:entityType/:entityId', ah(async (req, res) => {
  const { entityType, entityId } = req.params;
  if (!ENTITY_TYPES.includes(entityType)) throw httpError(400, 'Invalid entity type.');
  const rows = await db.prepare(`SELECT a.*, u.name AS actor_name FROM activities a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.created_at DESC`)
    .all(entityType, entityId);
  res.json(rows.map(camel));
}));

// POST /api/activities { entityType, entityId, kind, text }
activitiesRouter.post('/', ah(async (req, res) => {
  const { entityType, entityId, kind, text } = req.body || {};
  if (!ENTITY_TYPES.includes(entityType)) throw httpError(400, `Entity type must be one of: ${ENTITY_TYPES.join(', ')}.`);
  if (!ACTIVITY_KINDS.includes(kind)) throw httpError(400, `Kind must be one of: ${ACTIVITY_KINDS.join(', ')}.`);
  if (!entityId) throw httpError(400, 'Entity id is required.');
  if (!text?.trim()) throw httpError(400, 'Text is required.');
  const id = uid();
  await db.prepare('INSERT INTO activities (id, entity_type, entity_id, actor_id, kind, text) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, entityType, entityId, req.user.sub, kind, text.trim());
  auditReq(req, 'ACTIVITY_CREATE', { entityType, entityId, details: `Activity (${kind}) on ${entityType} ${entityId}.` });
  res.status(201).json(camel(await db.prepare('SELECT * FROM activities WHERE id = ?').get(id)));
}));

// --- Follow-ups ------------------------------------------------------------

export const followupsRouter = Router();
followupsRouter.use(requireAuth, requirePermission('crm'));

// GET /api/followups?overdue=1&mine=1
followupsRouter.get('/', ah(async (req, res) => {
  const { overdue, mine } = req.query;
  const where = [];
  const params = [];
  if (overdue === '1') { where.push('done = 0 AND due_date < ?'); params.push(todayStr()); }
  if (mine === '1') { where.push('owner_id = ?'); params.push(req.user.sub); }
  const sql = `SELECT f.*, u.name AS owner_name FROM followups f
    LEFT JOIN users u ON u.id = f.owner_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.due_date`;
  res.json((await db.prepare(sql).all(...params)).map(camel));
}));

// POST /api/followups { entityType, entityId, title, dueDate }
followupsRouter.post('/', ah(async (req, res) => {
  const { entityType, entityId, title, dueDate } = req.body || {};
  if (!ENTITY_TYPES.includes(entityType)) throw httpError(400, `Entity type must be one of: ${ENTITY_TYPES.join(', ')}.`);
  if (!entityId) throw httpError(400, 'Entity id is required.');
  if (!title?.trim()) throw httpError(400, 'Title is required.');
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw httpError(400, 'dueDate must be YYYY-MM-DD.');
  const id = uid();
  await db.prepare('INSERT INTO followups (id, entity_type, entity_id, title, due_date, owner_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, entityType, entityId, title.trim(), dueDate, req.user.sub);
  auditReq(req, 'FOLLOWUP_CREATE', { entityType, entityId, details: `Follow-up "${title.trim()}" due ${dueDate}.` });
  res.status(201).json(camel(await db.prepare('SELECT * FROM followups WHERE id = ?').get(id)));
}));

// PUT /api/followups/:id { title, dueDate, done }
followupsRouter.put('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM followups WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Follow-up not found.');
  const { title, dueDate, done } = req.body || {};
  if (title !== undefined && !String(title).trim()) throw httpError(400, 'Title cannot be empty.');
  if (dueDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw httpError(400, 'dueDate must be YYYY-MM-DD.');
  await db.prepare(`UPDATE followups SET title = COALESCE(?, title), due_date = COALESCE(?, due_date),
    done = COALESCE(?, done) WHERE id = ?`)
    .run(title !== undefined ? String(title).trim() : null, dueDate ?? null,
      done !== undefined ? (done ? 1 : 0) : null, req.params.id);
  auditReq(req, 'FOLLOWUP_UPDATE', { entityType: row.entity_type, entityId: row.entity_id, details: `Updated follow-up "${row.title}".` });
  res.json(camel(await db.prepare('SELECT * FROM followups WHERE id = ?').get(req.params.id)));
}));

// DELETE /api/followups/:id
followupsRouter.delete('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM followups WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Follow-up not found.');
  await db.prepare('DELETE FROM followups WHERE id = ?').run(req.params.id);
  auditReq(req, 'FOLLOWUP_DELETE', { entityType: row.entity_type, entityId: row.entity_id, details: `Deleted follow-up "${row.title}".` });
  res.json({ ok: true });
}));
