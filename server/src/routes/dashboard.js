// Dashboard aggregates, scoped by role on the server — the frontend never
// receives data the role may not see.
//
//   admin   — owner commission money only: totalCommission (pending+paid),
//             pendingCommission (not yet received), paidCommission
//             (received), activeLeads count, plus graph series.
//   manager — counts only, never money: activeLeads, dealsByStage,
//             commissionCounts { pending, paid }, plus graph series in
//             count form.
//   agent   — only their own share: myTotalShare / myPendingShare /
//             myPaidShare (own agent_amount by agent_status), myActiveLeads,
//             plus graph series of their own share.
// Graph series (every role, scoped the same way): commissionTrend (last 6
// calendar months, from commissions.created_at), leadsByStage, dealsByStage,
// inventoryByStatus (counts only).
//
// Removed in v1.3: revenue, commissionTotals, overdue*, recentActivity,
// agentPerformance, followups, myCommissions / myTotalCommission /
// myPendingCommission / myDeals (owner-total keys).

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ah } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

const ACTIVE_LEAD_STAGES = ['new', 'contacted', 'viewing', 'negotiating'];

/** Last 6 calendar months as YYYY-MM strings, oldest first. */
function lastSixMonths() {
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

// GET /api/dashboard
router.get('/', ah(async (req, res) => {
  const role = req.user.role;
  const me = req.user.sub;
  const months = lastSixMonths();

  const out = { role };

  // --- Leads by stage (agent: assigned only) --------------------------------
  const leadScope = role === 'agent' ? 'WHERE assigned_to = ?' : '';
  const leadParams = role === 'agent' ? [me] : [];
  const stageRows = await db.prepare(`SELECT stage, COUNT(*) AS n FROM leads ${leadScope} GROUP BY stage`).all(...leadParams);
  const leadsByStage = {};
  for (const r of stageRows) leadsByStage[r.stage] = r.n;
  out.leadsByStage = leadsByStage;

  // --- Deals by stage (agent: own only) -------------------------------------
  const dealScope = role === 'agent' ? 'WHERE agent_id = ?' : '';
  const dealParams = role === 'agent' ? [me] : [];
  const dealStageRows = await db.prepare(`SELECT stage, COUNT(*) AS n FROM deals ${dealScope} GROUP BY stage`).all(...dealParams);
  const dealsByStage = {};
  for (const r of dealStageRows) dealsByStage[r.stage] = r.n;
  out.dealsByStage = dealsByStage;

  // --- Inventory by status (counts only — no money for any role) ------------
  const invRows = await db.prepare('SELECT status, COUNT(*) AS n FROM properties GROUP BY status').all();
  const inventoryByStatus = {};
  for (const r of invRows) inventoryByStatus[r.status] = r.n;
  out.inventoryByStatus = inventoryByStatus;

  // --- Active leads: stage in new/contacted/viewing/negotiating -------------
  const activePlaceholders = ACTIVE_LEAD_STAGES.map(() => '?').join(',');
  const activeWhere = `stage IN (${activePlaceholders})`;
  const activeScope = role === 'agent' ? `${activeWhere} AND assigned_to = ?` : activeWhere;
  const activeParams = role === 'agent' ? [...ACTIVE_LEAD_STAGES, me] : [...ACTIVE_LEAD_STAGES];
  const activeCount = (await db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${activeScope}`).get(...activeParams)).n;

  // --- Commission trend: last 6 months from commissions.created_at ----------
  // Admin: owner amounts { total, pending, paid }.
  // Manager: counts { countPending, countPaid }.
  // Agent: MY share amounts { total, pending, paid } (agent_amount by agent_status).
  const trendScope = role === 'agent' ? 'WHERE agent_id = ?' : '';
  const trendParams = role === 'agent' ? [me] : [];
  const trendRows = await db.prepare(`SELECT strftime('%Y-%m', created_at) AS month,
      status, agent_status, COUNT(*) AS n,
      COALESCE(SUM(amount), 0) AS amount_sum,
      COALESCE(SUM(agent_amount), 0) AS share_sum
    FROM commissions ${trendScope} GROUP BY month, status, agent_status`).all(...trendParams);
  const byMonth = {};
  for (const m of months) {
    byMonth[m] = role === 'manager'
      ? { month: m, countPending: 0, countPaid: 0 }
      : { month: m, total: 0, pending: 0, paid: 0 };
  }
  for (const r of trendRows) {
    if (!byMonth[r.month]) continue;
    const bucket = byMonth[r.month];
    if (role === 'manager') {
      if (r.status === 'pending') bucket.countPending += r.n;
      if (r.status === 'paid') bucket.countPaid += r.n;
    } else if (role === 'agent') {
      const share = r.share_sum || 0;
      bucket.total += share;
      if (r.agent_status === 'pending') bucket.pending += share;
      if (r.agent_status === 'paid') bucket.paid += share;
    } else {
      const amt = r.amount_sum || 0;
      bucket.total += amt;
      if (r.status === 'pending') bucket.pending += amt;
      if (r.status === 'paid') bucket.paid += amt;
    }
  }
  out.commissionTrend = months.map((m) => byMonth[m]);

  // --- Role figures ----------------------------------------------------------
  if (role === 'admin') {
    const commPending = (await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM commissions WHERE status = 'pending'").get()).s;
    const commPaid = (await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM commissions WHERE status = 'paid'").get()).s;
    out.totalCommission = commPending + commPaid;
    out.pendingCommission = commPending;
    out.paidCommission = commPaid;
    out.activeLeads = activeCount;
  } else if (role === 'manager') {
    const countPending = (await db.prepare("SELECT COUNT(*) AS n FROM commissions WHERE status = 'pending'").get()).n;
    const countPaid = (await db.prepare("SELECT COUNT(*) AS n FROM commissions WHERE status = 'paid'").get()).n;
    out.commissionCounts = { pending: countPending, paid: countPaid };
    out.activeLeads = activeCount;
  } else {
    const myPending = (await db.prepare("SELECT COALESCE(SUM(agent_amount),0) AS s FROM commissions WHERE agent_id = ? AND agent_status = 'pending'").get(me)).s;
    const myPaid = (await db.prepare("SELECT COALESCE(SUM(agent_amount),0) AS s FROM commissions WHERE agent_id = ? AND agent_status = 'paid'").get(me)).s;
    out.myTotalShare = myPending + myPaid;
    out.myPendingShare = myPending;
    out.myPaidShare = myPaid;
    out.myActiveLeads = activeCount;
  }

  res.json(out);
}));

export default router;
