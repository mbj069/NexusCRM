// Client ledger: every plan, schedule row with paid info, and totals.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ah, httpError, todayStr } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

// GET /api/ledgers/:contactId
router.get('/:contactId', ah(async (req, res) => {
  const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.contactId);
  if (!contact) throw httpError(404, 'Contact not found.');

  // Agents only see ledgers for contacts on their own deals.
  const params = [req.params.contactId];
  let agentClause = '';
  if (req.user.role === 'agent') {
    const linked = await db.prepare(`SELECT 1 FROM payment_plans pp
      JOIN deals d ON d.id = pp.deal_id
      WHERE pp.contact_id = ? AND d.agent_id = ?`).get(req.params.contactId, req.user.sub);
    if (!linked) throw httpError(403, 'Ledger not on one of your deals.');
    agentClause = 'AND pp.deal_id IN (SELECT id FROM deals WHERE agent_id = ?)';
    params.push(req.user.sub);
  }

  const plans = await db.prepare(`SELECT pp.*, d.deal_value, d.stage AS deal_stage, pr.code AS property_code,
      pr.title AS property_title FROM payment_plans pp
    LEFT JOIN deals d ON d.id = pp.deal_id
    LEFT JOIN properties pr ON pr.id = d.property_id
    WHERE pp.contact_id = ? ${agentClause} ORDER BY pp.created_at`).all(...params);

  const totals = { total: 0, paid: 0, overdue: 0, balance: 0 };
  const outPlans = [];
  for (const plan of plans) {
    const p = camel(plan);
    const schedRows = await db.prepare('SELECT * FROM payment_schedule WHERE plan_id = ? ORDER BY seq')
      .all(plan.id);
    p.schedule = [];
    for (const s of schedRows) {
      const row = camel(s);
      row.payments = (await db.prepare('SELECT * FROM payments WHERE schedule_id = ? ORDER BY created_at')
        .all(s.id)).map(camel);
      row.paidAmount = row.payments.reduce((sum, x) => sum + x.amount, 0);
      row.isOverdue = row.status === 'pending' && row.due_date < todayStr();
      p.schedule.push(row);
    }
    p.totalPaid = p.schedule.reduce((s, r) => s + r.paidAmount, 0);
    p.overdueAmount = p.schedule.filter((r) => r.isOverdue).reduce((s, r) => s + (r.amount - r.paidAmount), 0);
    p.balance = plan.total_amount - p.totalPaid;
    totals.total += plan.total_amount;
    totals.paid += p.totalPaid;
    totals.overdue += p.overdueAmount;
    outPlans.push(p);
  }
  totals.balance = totals.total - totals.paid;

  res.json({ contact: camel(contact), plans: outPlans, totals });
}));

export default router;
