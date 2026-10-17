// Commissions: agents see only their own rows; paying out is manager/admin.

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
  const rows = db.prepare(sql).all(...params).map(camel);
  const summary = {
    pending: rows.filter((r) => r.status === 'pending').reduce((s, r) => s + r.amount, 0),
    paid: rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amount, 0),
  };
  res.json({ commissions: rows, summary });
}));

// POST /api/commissions/:id/pay { paidAt? } — manager/admin only
router.post('/:id/pay', ah(async (req, res) => {
  if (!can(req.user.role, 'pay_commissions')) {
    throw httpError(403, 'Insufficient permissions.');
  }
  const row = db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Commission not found.');
  if (row.status === 'paid') throw httpError(400, 'Commission is already paid.');
  const { paidAt } = req.body || {};
  if (paidAt !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(paidAt)) throw httpError(400, 'paidAt must be a date.');
  const stamp = paidAt ? `${String(paidAt).slice(0, 10)}T00:00:00.000Z` : new Date().toISOString();
  db.prepare(`UPDATE commissions SET status = 'paid', paid_at = ? WHERE id = ?`).run(stamp, req.params.id);
  auditReq(req, 'COMMISSION_PAY', { entityType: 'commission', entityId: req.params.id, details: `Commission ${row.amount} paid to agent ${row.agent_id} (deal ${row.deal_id}).` });
  res.json(camel(db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id)));
}));

export default router;
