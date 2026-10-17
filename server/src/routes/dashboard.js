// Dashboard aggregates: revenue, pipeline, inventory, overdue, agents, activity.

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

  // Revenue: collected vs expected (open deals)
  const collected = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments').get().s;
  const expected = db.prepare(`SELECT COALESCE(SUM(deal_value), 0) AS s FROM deals
    WHERE stage IN ('proposed','token_paid','in_progress')`).get().s;

  // Leads by stage
  const stageRows = db.prepare('SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage').all();
  const leadsByStage = {};
  for (const r of stageRows) leadsByStage[r.stage] = r.n;

  // Inventory by status
  const invRows = db.prepare('SELECT status, COUNT(*) AS n FROM properties GROUP BY status').all();
  const inventoryByStatus = {};
  for (const r of invRows) inventoryByStatus[r.status] = r.n;

  // Overdue installments
  const overdueRows = db.prepare(`SELECT s.*, pp.total_amount, c.name AS contact_name, c.phone AS contact_phone,
      c.id AS contact_id, d.id AS deal_id, pr.code AS property_code FROM payment_schedule s
    JOIN payment_plans pp ON pp.id = s.plan_id
    JOIN contacts c ON c.id = pp.contact_id
    LEFT JOIN deals d ON d.id = pp.deal_id
    LEFT JOIN properties pr ON pr.id = d.property_id
    WHERE s.status = 'pending' AND s.due_date < ? ORDER BY s.due_date`).all(today);
  const overdueInstallments = overdueRows.map((r) => {
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE schedule_id = ?').get(r.id).s;
    return {
      scheduleId: r.id, seq: r.seq, kind: r.kind, dueDate: r.due_date,
      amount: r.amount, paidAmount: paid, outstanding: r.amount - paid,
      daysOverdue: daysBetween(today, r.due_date),
      contact: { id: r.contact_id, name: r.contact_name, phone: r.contact_phone },
      dealId: r.deal_id, propertyCode: r.property_code,
    };
  });

  // Agent performance
  const agents = db.prepare(`SELECT id, name FROM users WHERE role IN ('manager','agent') ORDER BY name`).all();
  const agentPerformance = agents.map((a) => {
    const closed = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(deal_value),0) AS rev FROM deals
      WHERE agent_id = ? AND stage = 'closed_won'`).get(a.id);
    const comm = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM commissions
      WHERE agent_id = ? AND status = 'paid'`).get(a.id).s;
    const open = db.prepare(`SELECT COUNT(*) AS n FROM deals
      WHERE agent_id = ? AND stage IN ('proposed','token_paid','in_progress')`).get(a.id).n;
    return {
      agentId: a.id, name: a.name,
      dealsClosed: closed.n, revenue: closed.rev, commissionEarned: comm, openDeals: open,
    };
  });

  // Recent activity (latest audit entries)
  const recentActivity = db.prepare(`SELECT id, timestamp, actor_name, role, action, entity_type, entity_id, details
    FROM audit_log ORDER BY id DESC LIMIT 15`).all().map(camel);

  // Follow-up counts
  const overdueFollowups = db.prepare('SELECT COUNT(*) AS n FROM followups WHERE done = 0 AND due_date < ?').get(today).n;
  const dueToday = db.prepare('SELECT COUNT(*) AS n FROM followups WHERE done = 0 AND due_date = ?').get(today).n;

  res.json({
    revenue: { collected, expected },
    leadsByStage,
    inventoryByStatus,
    overdueInstallments,
    overdueCount: overdueInstallments.length,
    agentPerformance,
    recentActivity,
    followups: { overdue: overdueFollowups, dueToday },
  });
}));

export default router;
