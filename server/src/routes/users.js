// User management — admin only.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, mapUser, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid } from '../util.js';

const router = Router();
router.use(requireAuth);

const VALID_ROLES = ['admin', 'manager', 'agent'];

// GET /api/users/agents — id + name of every agent, for lead assignment.
// Manager/admin only (assign_leads); deliberately NOT the full user list.
router.get('/agents', requirePermission('assign_leads'), ah(async (req, res) => {
  const rows = await db.prepare("SELECT id, name, username FROM users WHERE role = 'agent' ORDER BY name").all();
  res.json(rows.map(camel));
}));

// GET /api/users — admin only
router.get('/', requirePermission('manage_users'), ah(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM users ORDER BY created_at').all();
  res.json(rows.map(mapUser));
}));

// POST /api/users { username, password, name, role } — admin only
router.post('/', requirePermission('manage_users'), ah(async (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username?.trim() || !password || !name?.trim()) throw httpError(400, 'Username, password and name are required.');
  if (String(password).length < 8) throw httpError(400, 'Password must be at least 8 characters.');
  if (!VALID_ROLES.includes(role)) throw httpError(400, `Role must be one of: ${VALID_ROLES.join(', ')}.`);
  const exists = await db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim().toLowerCase());
  if (exists) throw httpError(409, 'That username is already taken.');
  const id = uid();
  await db.prepare(`INSERT INTO users (id, username, password_hash, name, role, must_change_password)
    VALUES (?, ?, ?, ?, ?, 1)`)
    .run(id, String(username).trim().toLowerCase(), await bcrypt.hash(password, 10), name.trim(), role);
  auditReq(req, 'USER_CREATE', { entityType: 'user', entityId: id, details: `Created user ${name.trim()} (${role}).` });
  res.status(201).json(mapUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

// PUT /api/users/:id { name, role, password? } — admin only
router.put('/:id', requirePermission('manage_users'), ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'User not found.');
  const { name, role, password } = req.body || {};
  const updates = [];
  const params = [];
  if (name !== undefined) {
    if (!String(name).trim()) throw httpError(400, 'Name cannot be empty.');
    updates.push('name = ?'); params.push(String(name).trim());
  }
  if (role !== undefined) {
    if (!VALID_ROLES.includes(role)) throw httpError(400, `Role must be one of: ${VALID_ROLES.join(', ')}.`);
    if (row.role === 'admin' && role !== 'admin') {
      const adminCount = (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get()).n;
      if (adminCount <= 1) throw httpError(400, 'Cannot demote the last admin.');
    }
    updates.push('role = ?'); params.push(role);
  }
  if (password !== undefined && password !== '') {
    if (String(password).length < 8) throw httpError(400, 'Password must be at least 8 characters.');
    updates.push('password_hash = ?', 'must_change_password = 1');
    params.push(await bcrypt.hash(password, 10));
  }
  if (updates.length) {
    await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params, req.params.id);
  }
  auditReq(req, 'USER_UPDATE', { entityType: 'user', entityId: req.params.id, details: `Updated user ${row.name}.` });
  res.json(mapUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)));
}));

// DELETE /api/users/:id — admin only
router.delete('/:id', requirePermission('manage_users'), ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'User not found.');
  if (row.id === req.user.sub) throw httpError(400, 'You cannot delete your own account.');
  if (row.role === 'admin') {
    const adminCount = (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get()).n;
    if (adminCount <= 1) throw httpError(400, 'Cannot delete the last admin.');
  }
  await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  auditReq(req, 'USER_DELETE', { entityType: 'user', entityId: req.params.id, details: `Deleted user ${row.name} (${row.username}).` });
  res.json({ ok: true });
}));

export default router;
