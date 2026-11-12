// Commissions: owner total vs agent share.
//
// Each row carries TWO independent money tracks:
//   amount + status/paid_at        = the OWNER's total commission and
//     whether the OWNER has received it.
//   agent_amount + agent_status/agent_paid_at = the AGENT's share of that
//     total and whether the owner has paid it to the agent.
// The two statuses change independently: marking the owner paid never
// touches agent_status, and vice versa. `amount` is always the owner
// total — it never sets the agent share.
//
// Agents see only their own rows, and never owner totals: for agents the
// list response omits the owner `summary` entirely and returns only
// `agentSummary` (their share figures), and every row is stripped of the
// owner fields (amount/status/paid_at/manual) — share fields only.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission, can } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid, todayStr } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

// Owner fields an agent must never see on a commission row: the owner's
// total (amount/status/paid_at/manual). Agents keep only their share
// fields plus identifiers. Same stripping as deals.js does for embedded
// commission rows — the list endpoint must not leak what the detail
// endpoint hides.
function stripOwnerFields(row) {
  const { amount, status, paidAt, manual, ...shareOnly } = row;
  return shareOnly;
}

// GET /api/commissions?agentId=&status=&from=&to=
// Agents are always scoped to their own rows, regardless of query params.
// Admin/manager: { commissions, summary, agentSummary }.
//   summary: owner totals over returned rows { pending, paid } (on amount).
//   agentSummary: agent-share totals { agentPending, agentPaid } (on agent_amount).
// Agent: { commissions, agentSummary } only — no owner summary.
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
  const agentSummary = {
    agentPending: rows.filter((r) => r.agentStatus === 'pending').reduce((s, r) => s + (r.agentAmount || 0), 0),
    agentPaid: rows.filter((r) => r.agentStatus === 'paid').reduce((s, r) => s + (r.agentAmount || 0), 0),
  };
  if (req.user.role === 'agent') {
    return res.json({ commissions: rows.map(stripOwnerFields), agentSummary });
  }
  const summary = {
    pending: rows.filter((r) => r.status === 'pending').reduce((s, r) => s + r.amount, 0),
    paid: rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amount, 0),
  };
  res.json({ commissions: rows, summary, agentSummary });
}));

// PUT /api/commissions/:id — manual override (admin only).
// `amount`/`status` set the OWNER total (and set manual=1, audit
// COMMISSION_MANUAL). `agentAmount`/`agentStatus` set the AGENT share
// (and set manual=1, audit COMMISSION_AGENT_SHARE). The two tracks are
// independent: `amount` never touches the share, and changing the share
// never touches the owner total. If both change in one call, both audit
// entries are written.
router.put('/:id', ah(async (req, res) => {
  if (!can(req.user.role, 'assign_commissions')) {
    throw httpError(403, 'Only an admin can set commissions manually.');
  }
  const row = await db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Commission not found.');
  const { amount, status, agentAmount, agentStatus } = req.body || {};
  if (amount !== undefined && !(Number(amount) >= 0)) throw httpError(400, 'Amount must be zero or more.');
  if (status !== undefined && !['pending', 'paid'].includes(status)) throw httpError(400, 'Status must be pending or paid.');
  if (agentAmount !== undefined && !(Number(agentAmount) >= 0)) throw httpError(400, 'Agent amount must be zero or more.');
  if (agentStatus !== undefined && !['pending', 'paid'].includes(agentStatus)) throw httpError(400, 'Agent status must be pending or paid.');
  const nextAmount = amount !== undefined ? Number(amount) : row.amount;
  const nextStatus = status ?? row.status;
  const nextPaidAt = nextStatus === 'paid' ? (row.paid_at || new Date().toISOString()) : null;
  const nextAgentAmount = agentAmount !== undefined ? Number(agentAmount) : (row.agent_amount ?? 0);
  const nextAgentStatus = agentStatus ?? row.agent_status ?? 'pending';
  const nextAgentPaidAt = nextAgentStatus === 'paid' ? (row.agent_paid_at || new Date().toISOString()) : null;
  await db.prepare(`UPDATE commissions SET amount = ?, status = ?, paid_at = ?,
      agent_amount = ?, agent_status = ?, agent_paid_at = ?, manual = 1 WHERE id = ?`)
    .run(nextAmount, nextStatus, nextPaidAt, nextAgentAmount, nextAgentStatus, nextAgentPaidAt, req.params.id);
  const totalChanged = nextAmount !== row.amount || nextStatus !== row.status;
  const shareChanged = nextAgentAmount !== (row.agent_amount ?? 0) || nextAgentStatus !== (row.agent_status ?? 'pending');
  if (totalChanged) {
    auditReq(req, 'COMMISSION_MANUAL', { entityType: 'commission', entityId: req.params.id,
      details: `Manual commission override (deal ${row.deal_id}, agent ${row.agent_id}): owner total ${row.amount} ${row.status} → ${nextAmount} ${nextStatus}.` });
  }
  if (shareChanged) {
    auditReq(req, 'COMMISSION_AGENT_SHARE', { entityType: 'commission', entityId: req.params.id,
      details: `Agent share changed (deal ${row.deal_id}, agent ${row.agent_id}): ${row.agent_amount ?? 0} ${row.agent_status ?? 'pending'} → ${nextAgentAmount} ${nextAgentStatus}.` });
  }
  res.json(camel(await db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id)));
}));

// POST /api/commissions/:id/pay { paidAt? } — admin only.
// Marks the OWNER's commission received (owner status → paid). The agent
// share is untouched: agent_status stays exactly as it was.
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
  auditReq(req, 'COMMISSION_PAY', { entityType: 'commission', entityId: req.params.id, details: `Owner commission received: ${row.amount} (deal ${row.deal_id}, agent ${row.agent_id}). Agent share unchanged (${row.agent_amount ?? 0} ${row.agent_status ?? 'pending'}).` });
  res.json(camel(await db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id)));
}));

// POST /api/commissions/:id/pay-agent-share { paidAt? } — admin only.
// Marks ONLY the agent share paid (agent_status → paid). The owner total
// is untouched: status stays exactly as it was.
router.post('/:id/pay-agent-share', ah(async (req, res) => {
  if (!can(req.user.role, 'pay_commissions')) {
    throw httpError(403, 'Insufficient permissions.');
  }
  const row = await db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Commission not found.');
  if ((row.agent_status ?? 'pending') === 'paid') throw httpError(400, 'Agent share is already paid.');
  const { paidAt } = req.body || {};
  if (paidAt !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(paidAt)) throw httpError(400, 'paidAt must be a date.');
  const stamp = paidAt ? `${String(paidAt).slice(0, 10)}T00:00:00.000Z` : new Date().toISOString();
  await db.prepare(`UPDATE commissions SET agent_status = 'paid', agent_paid_at = ? WHERE id = ?`).run(stamp, req.params.id);
  auditReq(req, 'COMMISSION_AGENT_SHARE_PAY', { entityType: 'commission', entityId: req.params.id, details: `Agent share paid: ${row.agent_amount ?? 0} to agent ${row.agent_id} (deal ${row.deal_id}). Owner total unchanged (${row.amount} ${row.status}).` });
  res.json(camel(await db.prepare('SELECT * FROM commissions WHERE id = ?').get(req.params.id)));
}));

export default router;
