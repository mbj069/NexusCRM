// Dashboard aggregates, scoped by role on the server — the frontend never
// receives data the role may not see.
//
//   admin   — full totals: revenue collected/expected, all-leads funnel,
//             full inventory counts, all-agents performance (with money),
//             commission totals, overdue totals, recent activity.
//   manager — team view: leads/deals by stage, per-agent performance
//             (counts only), follow-up load, overdue list. NO grand money
//             totals (no revenue, no commission totals, no agent revenue).
//   agent   — only their own numbers: assigned leads by stage, own deals,
//             own commissions, own follow-ups, own overdue items.
//             No totals, no other agents.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ah, daysBetween, todayStr } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

// GET /api/dashboard
router.get('/', ah(async (req, res) => {
  const today = todayStr();
  const role = req.user.role;
  const me = req.user.sub;

  const out = { role };

  // --- Admin-only: grand money totals --------------------------------------
  if (role === 'admin') {
    const collected = (await db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments').get()).s;
    const expected = (await db.prepare(`SELECT COALESCE(SUM(deal_value), 0) AS s FROM deals
      WHERE stage IN ('proposed','token_paid','in_progress')`).get()).s;
    out.revenue = { collected, expected };
    const commPending = (await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM commissions WHERE status = 'pending'").get()).s;
    const commPaid = (await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM commissions WHERE status = 'paid'").get()).s;
    out.commissionTotals = { pending: commPending, paid: commPaid };
    out.recentActivity = (await db.prepare(`SELECT id, timestamp, actor_name, role, action, entity_type, entity_id, details
      FROM audit_log ORDER BY id DESC LIMIT 15`).all()).map(camel);
  }

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

  // --- Overdue installments (agent: own deals only) --------------------------
  const overdueWhere = role === 'agent'
    ? `WHERE s.status = 'pending' AND s.due_date < ? AND d.agent_id = ?`
    : `WHERE s.status = 'pending' AND s.due_date < ?`;
  const overdueParams = role === 'agent' ? [today, me] : [today];
  const overdueRows = await db.prepare(`SELECT s.*, pp.total_amount, c.name AS contact_name, c.phone AS contact_phone,
      c.id AS contact_id, d.id AS deal_id, pr.code AS property_code FROM payment_schedule s
    JOIN payment_plans pp ON pp.id = s.plan_id
    JOIN contacts c ON c.id = pp.contact_id
    LEFT JOIN deals d ON d.id = pp.deal_id
    LEFT JOIN properties pr ON pr.id = d.property_id
    ${overdueWhere} ORDER BY s.due_date`).all(...overdueParams);
  const overdueInstallments = [];
  let overdueTotal = 0;
  for (const r of overdueRows) {
    const paid = (await db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE schedule_id = ?').get(r.id)).s;
    const outstanding = r.amount - paid;
    overdueTotal += outstanding;
    overdueInstallments.push({
      scheduleId: r.id, seq: r.seq, kind: r.kind, dueDate: r.due_date,
      amount: r.amount, paidAmount: paid, outstanding,
      daysOverdue: daysBetween(today, r.due_date),
      contact: { id: r.contact_id, name: r.contact_name, phone: r.contact_phone },
      dealId: r.deal_id, propertyCode: r.property_code,
    });
  }
  out.overdueInstallments = overdueInstallments;
  out.overdueCount = overdueInstallments.length;
  if (role === 'admin') out.overdueTotal = overdueTotal;

  // --- Agent performance -----------------------------------------------------
  // Admin: full, with money. Manager: counts only (no revenue, no
  // commission). Agents do not receive this section at all.
  if (role !== 'agent') {
    const agents = await db.prepare(`SELECT id, name FROM users WHERE role IN ('manager','agent') ORDER BY name`).all();
    const agentPerformance = [];
    for (const a of agents) {
      const closed = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(deal_value),0) AS rev FROM deals
        WHERE agent_id = ? AND stage = 'closed_won'`).get(a.id);
      const open = (await db.prepare(`SELECT COUNT(*) AS n FROM deals
        WHERE agent_id = ? AND stage IN ('proposed','token_paid','in_progress')`).get(a.id)).n;
      const leads = (await db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE assigned_to = ?`).get(a.id)).n;
      const row = { agentId: a.id, name: a.name, dealsClosed: closed.n, openDeals: open, leadsAssigned: leads };
      if (role === 'admin') {
        const comm = (await db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM commissions
          WHERE agent_id = ? AND status = 'paid'`).get(a.id)).s;
        row.revenue = closed.rev;
        row.commissionEarned = comm;
      }
      agentPerformance.push(row);
    }
    out.agentPerformance = agentPerformance;
  }

  // --- Agent-only: own commissions -------------------------------------------
  if (role === 'agent') {
    const myPending = (await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM commissions WHERE agent_id = ? AND status = 'pending'").get(me)).s;
    const myPaid = (await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM commissions WHERE agent_id = ? AND status = 'paid'").get(me)).s;
    out.myCommissions = { pending: myPending, paid: myPaid };
    const myDeals = (await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(deal_value),0) AS v FROM deals
      WHERE agent_id = ? AND stage IN ('proposed','token_paid','in_progress')`).get(me));
    out.myDeals = { open: myDeals.n, openValue: myDeals.v };
  }

  // --- Follow-up counts (agent: own only) ------------------------------------
  const fuScope = role === 'agent' ? 'AND owner_id = ?' : '';
  const fuParams = role === 'agent' ? [me] : [];
  const overdueFollowups = (await db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE done = 0 AND due_date < ? ${fuScope}`).get(today, ...fuParams)).n;
  const dueToday = (await db.prepare(`SELECT COUNT(*) AS n FROM followups WHERE done = 0 AND due_date = ? ${fuScope}`).get(today, ...fuParams)).n;
  out.followups = { overdue: overdueFollowups, dueToday };

  res.json(out);
}));

export default router;
