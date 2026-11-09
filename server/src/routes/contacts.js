// Contacts CRUD — all CRM roles. Agents only see contacts linked to their
// own leads/deals (lead contact, deal lead's contact, or plan payer).

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

const VALID_TYPES = ['buyer', 'seller'];

const isAgent = (req) => req.user.role === 'agent';

// SQL fragment (with three `?` params, all the agent's id) matching contacts
// linked to the agent's own leads/deals.
const AGENT_LINKED = `id IN (SELECT contact_id FROM leads WHERE assigned_to = ?)
  OR id IN (SELECT l.contact_id FROM leads l JOIN deals d ON d.lead_id = l.id WHERE d.agent_id = ?)
  OR id IN (SELECT pp.contact_id FROM payment_plans pp JOIN deals d ON d.id = pp.deal_id WHERE d.agent_id = ?)`;

async function assertContactVisible(req, contactId) {
  if (!isAgent(req)) return;
  const row = await db.prepare(`SELECT id FROM contacts WHERE id = ? AND (${AGENT_LINKED})`)
    .get(contactId, req.user.sub, req.user.sub, req.user.sub);
  if (!row) throw httpError(403, 'Contact not linked to your leads or deals.');
}

// GET /api/contacts?q=
router.get('/', ah(async (req, res) => {
  const { q } = req.query;
  const where = [];
  const params = [];
  if (isAgent(req)) { where.push(`(${AGENT_LINKED})`); params.push(req.user.sub, req.user.sub, req.user.sub); }
  if (q?.trim()) {
    const like = `%${q.trim()}%`;
    where.push('(name LIKE ? OR phone LIKE ? OR whatsapp LIKE ? OR email LIKE ?)');
    params.push(like, like, like, like);
  }
  const sql = `SELECT * FROM contacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
  res.json((await db.prepare(sql).all(...params)).map(camel));
}));

// POST /api/contacts
router.post('/', ah(async (req, res) => {
  const { name, phone = '', whatsapp = '', type = 'buyer', source = '', email = '', notes = '', ownerId } = req.body || {};
  if (!name?.trim()) throw httpError(400, 'Name is required.');
  if (!VALID_TYPES.includes(type)) throw httpError(400, `Type must be one of: ${VALID_TYPES.join(', ')}.`);
  const id = uid();
  await db.prepare(`INSERT INTO contacts (id, name, phone, whatsapp, type, source, email, notes, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name.trim(), String(phone).trim(), String(whatsapp).trim(), type,
      String(source).trim(), String(email).trim(), String(notes), ownerId || req.user.sub);
  auditReq(req, 'CONTACT_CREATE', { entityType: 'contact', entityId: id, details: `Created contact ${name.trim()} (${type}).` });
  res.status(201).json(camel(await db.prepare('SELECT * FROM contacts WHERE id = ?').get(id)));
}));

// GET /api/contacts/:id
router.get('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Contact not found.');
  await assertContactVisible(req, req.params.id);
  res.json(camel(row));
}));

// PUT /api/contacts/:id
router.put('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Contact not found.');
  await assertContactVisible(req, req.params.id);
  const { name, phone, whatsapp, type, source, email, notes, ownerId } = req.body || {};
  if (name !== undefined && !String(name).trim()) throw httpError(400, 'Name cannot be empty.');
  if (type !== undefined && !VALID_TYPES.includes(type)) throw httpError(400, `Type must be one of: ${VALID_TYPES.join(', ')}.`);
  await db.prepare(`UPDATE contacts SET
      name = COALESCE(?, name), phone = COALESCE(?, phone), whatsapp = COALESCE(?, whatsapp),
      type = COALESCE(?, type), source = COALESCE(?, source), email = COALESCE(?, email),
      notes = COALESCE(?, notes), owner_id = COALESCE(?, owner_id), updated_at = datetime('now')
    WHERE id = ?`)
    .run(
      name !== undefined ? String(name).trim() : null,
      phone !== undefined ? String(phone).trim() : null,
      whatsapp !== undefined ? String(whatsapp).trim() : null,
      type ?? null, source !== undefined ? String(source).trim() : null,
      email !== undefined ? String(email).trim() : null,
      notes !== undefined ? String(notes) : null,
      ownerId ?? null, req.params.id
    );
  auditReq(req, 'CONTACT_UPDATE', { entityType: 'contact', entityId: req.params.id, details: `Updated contact ${row.name}.` });
  res.json(camel(await db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id)));
}));

// DELETE /api/contacts/:id
router.delete('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Contact not found.');
  await assertContactVisible(req, req.params.id);
  const leadCount = (await db.prepare('SELECT COUNT(*) AS n FROM leads WHERE contact_id = ?').get(req.params.id)).n;
  const planCount = (await db.prepare('SELECT COUNT(*) AS n FROM payment_plans WHERE contact_id = ?').get(req.params.id)).n;
  if (leadCount > 0 || planCount > 0) {
    throw httpError(409, `Cannot delete: contact has ${leadCount} lead(s) and ${planCount} payment plan(s).`);
  }
  await db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  auditReq(req, 'CONTACT_DELETE', { entityType: 'contact', entityId: req.params.id, details: `Deleted contact ${row.name}.` });
  res.json({ ok: true });
}));

export default router;
