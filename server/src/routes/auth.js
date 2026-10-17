// Authentication: login + password change.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, mapUser } from '../db.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { audit, auditReq } from '../audit.js';
import { ah, httpError, uid } from '../util.js';

const router = Router();

// POST /api/auth/login { username, password }
router.post('/login', ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw httpError(400, 'Username and password are required.');
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim().toLowerCase());
  const ok = row && (await bcrypt.compare(password, row.password_hash));
  if (!ok) {
    audit({ actorId: '', actorName: String(username).slice(0, 60), role: '', action: 'LOGIN_FAILED', details: `Failed login for ${String(username).slice(0, 60)}` });
    throw httpError(401, 'Invalid username or password.');
  }
  const user = mapUser(row);
  audit({ actorId: user.id, actorName: user.name, role: user.role, action: 'LOGIN', details: `${user.name} signed in.` });
  res.json({ token: signToken(user), user });
}));

// POST /api/auth/change-password { currentPassword, newPassword } (auth)
router.post('/change-password', requireAuth, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) throw httpError(400, 'Current and new passwords are required.');
  if (String(newPassword).length < 8) throw httpError(400, 'New password must be at least 8 characters.');
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!row) throw httpError(401, 'Account not found.');
  const ok = await bcrypt.compare(currentPassword, row.password_hash);
  if (!ok) throw httpError(401, 'Current password is incorrect.');
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, req.user.sub);
  auditReq(req, 'PASSWORD_CHANGE', { entityType: 'user', entityId: req.user.sub, details: `${req.user.name} changed their password.` });
  res.json({ ok: true });
}));

export function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}

export function newUserId() {
  return uid();
}

export default router;
