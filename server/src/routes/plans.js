// Payment plans: plan + generated schedule (down payment, monthly
// installments, possession). Plan total must match the deal value.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid, addMonths } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

// POST /api/plans { dealId, contactId, downPayment, numInstallments,
//                   installmentAmount, possessionAmount, startDate }
router.post('/', ah(async (req, res) => {
  const { dealId, contactId, downPayment = 0, numInstallments = 0, installmentAmount = 0,
    possessionAmount = 0, startDate } = req.body || {};
  if (!dealId) throw httpError(400, 'dealId is required.');
  if (!contactId) throw httpError(400, 'contactId is required.');
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw httpError(400, 'startDate must be YYYY-MM-DD.');
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
  if (!deal) throw httpError(404, 'Deal not found.');
  const contact = db.prepare('SELECT id, name FROM contacts WHERE id = ?').get(contactId);
  if (!contact) throw httpError(404, 'Contact not found.');
  const existing = db.prepare('SELECT id FROM payment_plans WHERE deal_id = ?').get(dealId);
  if (existing) throw httpError(409, 'This deal already has a payment plan.');

  const down = Number(downPayment) || 0;
  const n = Math.floor(Number(numInstallments) || 0);
  const inst = Number(installmentAmount) || 0;
  const poss = Number(possessionAmount) || 0;
  if (down < 0 || n < 0 || inst < 0 || poss < 0) throw httpError(400, 'Amounts cannot be negative.');
  const total = down + n * inst + poss;
  if (!(total > 0)) throw httpError(400, 'Plan total must be positive.');
  if (Math.abs(total - deal.deal_value) > 0.01) {
    throw httpError(400, `Plan total (${total.toLocaleString()}) does not match deal value (${deal.deal_value.toLocaleString()}).`);
  }

  const planId = uid();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO payment_plans (id, deal_id, contact_id, total_amount, down_payment,
        possession_amount, num_installments, installment_amount, start_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(planId, dealId, contactId, total, down, poss, n, inst, startDate);
    const rows = [];
    rows.push({ seq: 0, due: startDate, amount: down, kind: 'down_payment' });
    for (let i = 1; i <= n; i++) {
      rows.push({ seq: i, due: addMonths(startDate, i), amount: inst, kind: 'installment' });
    }
    rows.push({ seq: n + 1, due: addMonths(startDate, n + 1), amount: poss, kind: 'possession' });
    const ins = db.prepare(`INSERT INTO payment_schedule (id, plan_id, seq, due_date, amount, kind, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')`);
    for (const r of rows) ins.run(uid(), planId, r.seq, r.due, r.amount, r.kind);
    auditReq(req, 'PLAN_CREATE', { entityType: 'plan', entityId: planId, details: `Payment plan for deal ${dealId}: total ${total}, ${n} installments.` });
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }

  const plan = camel(db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(planId));
  plan.schedule = db.prepare('SELECT * FROM payment_schedule WHERE plan_id = ? ORDER BY seq').all(planId).map(camel);
  res.status(201).json(plan);
}));

// GET /api/plans?dealId=
router.get('/', ah(async (req, res) => {
  const { dealId } = req.query;
  const sql = dealId
    ? 'SELECT * FROM payment_plans WHERE deal_id = ? ORDER BY created_at'
    : 'SELECT * FROM payment_plans ORDER BY created_at DESC';
  const rows = dealId ? db.prepare(sql).all(dealId) : db.prepare(sql).all();
  res.json(rows.map(camel));
}));

// GET /api/plans/:id — with schedule + payments
router.get('/:id', ah(async (req, res) => {
  const plan = db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(req.params.id);
  if (!plan) throw httpError(404, 'Payment plan not found.');
  const out = camel(plan);
  out.contact = camel(db.prepare('SELECT * FROM contacts WHERE id = ?').get(plan.contact_id));
  out.deal = camel(db.prepare('SELECT * FROM deals WHERE id = ?').get(plan.deal_id));
  out.schedule = db.prepare('SELECT * FROM payment_schedule WHERE plan_id = ? ORDER BY seq')
    .all(req.params.id).map(camel);
  out.payments = db.prepare(`SELECT p.*, u.name AS received_by_name FROM payments p
    LEFT JOIN users u ON u.id = p.received_by WHERE p.plan_id = ? ORDER BY p.created_at`).all(req.params.id).map(camel);
  out.totalPaid = out.payments.reduce((s, p) => s + p.amount, 0);
  out.balance = plan.total_amount - out.totalPaid;
  res.json(out);
}));

export default router;
