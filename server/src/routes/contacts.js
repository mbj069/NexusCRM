// Contacts CRUD — all CRM roles.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

const VALID_TYPES = ['buyer', 'seller'];

// GET /api/contacts?q=
router.get('/', ah(async (req, res) => {
  const { q } = req.query;
  let rows;
  if (q?.trim()) {
    const like = `%${q.trim()}%`;
    rows = await db.prepare(`SELECT * FROM contacts
      WHERE name LIKE ? OR phone LIKE ? OR whatsapp LIKE ? OR email LIKE ?
      ORDER BY updated_at DESC`).all(like, like, like, like);
  } else {
    rows = await db.prepare('SELECT * FROM contacts ORDER BY updated_at DESC').all();
  }
  res.json(rows.map(camel));
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
  res.json(camel(row));
}));

// PUT /api/contacts/:id
router.put('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Contact not found.');
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
