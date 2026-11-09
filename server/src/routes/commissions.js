// Commissions: agents see only their own rows; paying out and manual
// overrides are admin-only.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, can } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid, todayStr } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

// GET /api/commissions?agentId=&status=&from=&to=
// Agents are always scoped to their own rows, regardless of query params.
router.get('/', ah(async (req, res) => {
  const { agentId, status, from, to } = req.query;
  const where = [];
  const params = [];
  if (req.user.role === 'agent') {
    where.push('c.agent_id = ?'); params.push(req.user.sub);
  } else if (agentId) {
    where.push('c.agent_id = ?'); params.push(agentId);
  }
  if (status) {
    if (!['pending', 'paid'].includes(status)) throw httpError(400, 'Invalid status.');
    where.push('c.status = ?'); params.push(status);
  }
  if (from) { where.push('date(c.created_at) >= date(?)'); params.push(from); }
  if (to) { where.push('date(c.created_at) <= date(?)'); params.push(to); }
  const sql = `SELECT c.*, u.name AS agent_name, pr.code AS property_code FROM commissions c
    LEFT JOIN users u ON u.id = c.agent_id
    LEFT JOIN deals d ON d.id = c.deal_id
    LEFT JOIN properties pr ON pr.id = d.property_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.created_at DESC`;
  const rows = (await db.prepare(sql).all(...params)).map(camel);
  const summary = {
    pending: rows.filter((r) => r.status === 'pending').reduce((s, r) => s + r.amount, 0),
    paid: rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amount, 0),
  };
  res.json({ commissions: rows, summary });
}));

// PUT /api/commissions/:id — manual override (admin only): set the amount
// and/or status independent of the auto percent/fixed calculation at deal
// creation. Sets manual=1 so later deal-term edits do not overwrite it.
// Every manual change is audit-logged with old → new values.
router.put('/:id', ah(async (req, res) => {
  if (!can(req.user.role, 'assign_commissions')) {
    throw httpError(403, 'Only an admin can set commissions manually.');
  }
  const row = await db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Commission not found.');
  const { amount, status } = req.body || {};
  if (amount !== undefined && !(Number(amount) >= 0)) throw httpError(400, 'Amount must be zero or more.');
  if (status !== undefined && !['pending', 'paid'].includes(status)) throw httpError(400, 'Status must be pending or paid.');
  const nextAmount = amount !== undefined ? Number(amount) : row.amount;
  const nextStatus = status ?? row.status;
  const nextPaidAt = nextStatus === 'paid' ? (row.paid_at || new Date().toISOString()) : null;
  await db.prepare(`UPDATE commissions SET amount = ?, status = ?, paid_at = ?, manual = 1 WHERE id = ?`)
    .run(nextAmount, nextStatus, nextPaidAt, req.params.id);
  auditReq(req, 'COMMISSION_MANUAL', { entityType: 'commission', entityId: req.params.id,
    details: `Manual commission override (deal ${row.deal_id}, agent ${row.agent_id}): ${row.amount} ${row.status} → ${nextAmount} ${nextStatus}.` });
  res.json(camel(await db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id)));
}));

// POST /api/commissions/:id/pay { paidAt? } — admin only
router.post('/:id/pay', ah(async (req, res) => {
  if (!can(req.user.role, 'pay_commissions')) {
    throw httpError(403, 'Insufficient permissions.');
  }
  const row = await db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Commission not found.');
  if (row.status === 'paid') throw httpError(400, 'Commission is already paid.');
  const { paidAt } = req.body || {};
  if (paidAt !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(paidAt)) throw httpError(400, 'paidAt must be a date.');
  const stamp = paidAt ? `${String(paidAt).slice(0, 10)}T00:00:00.000Z` : new Date().toISOString();
  await db.prepare(`UPDATE commissions SET status = 'paid', paid_at = ? WHERE id = ?`).run(stamp, req.params.id);
  auditReq(req, 'COMMISSION_PAY', { entityType: 'commission', entityId: req.params.id, details: `Commission ${row.amount} paid to agent ${row.agent_id} (deal ${row.deal_id}).` });
  res.json(camel(await db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id)));
}));

export default router;
