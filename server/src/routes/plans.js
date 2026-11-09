// Payment plans: plan + generated schedule in the hierarchy
//   Token → Bayana → Installments (optional) → Final payment.
// Plan total must match the deal value. Final payment is auto-computed as
// the remainder (deal value − token − bayana − installments total) when
// not given explicitly.
//
// Legacy field names are still accepted as aliases on create
// (downPayment → token, possessionAmount → final) so older clients keep
// working.

import { Router } from 'express';
import { db, camel, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid, addMonths } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

const isAgent = (req) => req.user.role === 'agent';

// Agents may only touch plans belonging to their own deals.
async function assertPlanVisible(req, plan) {
  if (!isAgent(req)) return;
  const deal = await db.prepare('SELECT agent_id FROM deals WHERE id = ?').get(plan.deal_id);
  if (!deal || deal.agent_id !== req.user.sub) throw httpError(403, 'Plan not on one of your deals.');
}

// POST /api/plans { dealId, contactId, tokenAmount, bayanaAmount,
//                   numInstallments, installmentAmount, finalAmount, startDate }
router.post('/', ah(async (req, res) => {
  const { dealId, contactId, tokenAmount, bayanaAmount, numInstallments = 0,
    installmentAmount = 0, finalAmount, startDate,
    // legacy aliases
    downPayment, possessionAmount } = req.body || {};
  if (!dealId) throw httpError(400, 'dealId is required.');
  if (!contactId) throw httpError(400, 'contactId is required.');
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw httpError(400, 'startDate must be YYYY-MM-DD.');
  const deal = await db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId);
  if (!deal) throw httpError(404, 'Deal not found.');
  if (isAgent(req) && deal.agent_id !== req.user.sub) throw httpError(403, 'Cannot create a plan for another agent\u2019s deal.');
  const contact = await db.prepare('SELECT id, name FROM contacts WHERE id = ?').get(contactId);
  if (!contact) throw httpError(404, 'Contact not found.');
  const existing = await db.prepare('SELECT id FROM payment_plans WHERE deal_id = ?').get(dealId);
  if (existing) throw httpError(409, 'This deal already has a payment plan.');

  // Token defaults to 0; bayana defaults to the deal's earnest amount.
  const token = Number(tokenAmount ?? downPayment ?? 0) || 0;
  const bayana = Number(bayanaAmount ?? deal.bayana_amount ?? 0) || 0;
  const n = Math.floor(Number(numInstallments) || 0);
  const inst = Number(installmentAmount) || 0;
  // Final defaults to the remainder so the plan always adds up.
  const final = finalAmount !== undefined && finalAmount !== null && finalAmount !== ''
    ? Number(finalAmount) : deal.deal_value - token - bayana - n * inst;
  if (token < 0 || bayana < 0 || n < 0 || inst < 0 || final < 0) throw httpError(400, 'Amounts cannot be negative.');
  const total = token + bayana + n * inst + final;
  if (!(total > 0)) throw httpError(400, 'Plan total must be positive.');
  if (Math.abs(total - deal.deal_value) > 0.01) {
    throw httpError(400, `Plan total (${total.toLocaleString()}) does not match deal value (${deal.deal_value.toLocaleString()}).`);
  }

  const planId = uid();
  await withTransaction(async (tx) => {
    await tx.prepare(`INSERT INTO payment_plans (id, deal_id, contact_id, total_amount, token_amount,
        bayana_amount, final_amount, num_installments, installment_amount, start_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(planId, dealId, contactId, total, token, bayana, final, n, inst, startDate);
    // Schedule in hierarchy order; zero-amount stages are skipped so the
    // schedule only shows money actually owed.
    const rows = [];
    let seq = 0;
    if (token > 0) rows.push({ seq: seq++, due: startDate, amount: token, kind: 'token' });
    if (bayana > 0) rows.push({ seq: seq++, due: startDate, amount: bayana, kind: 'bayana' });
    for (let i = 1; i <= n; i++) {
      rows.push({ seq: seq++, due: addMonths(startDate, i), amount: inst, kind: 'installment' });
    }
    if (final > 0) rows.push({ seq: seq++, due: addMonths(startDate, n + 1), amount: final, kind: 'final' });
    const ins = tx.prepare(`INSERT INTO payment_schedule (id, plan_id, seq, due_date, amount, kind, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')`);
    for (const r of rows) await ins.run(uid(), planId, r.seq, r.due, r.amount, r.kind);
    await auditReq(req, 'PLAN_CREATE', { entityType: 'plan', entityId: planId, details: `Payment plan for deal ${dealId}: token ${token}, bayana ${bayana}, ${n} installments, final ${final}.` }, tx);
  });

  const plan = camel(await db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(planId));
  plan.schedule = (await db.prepare('SELECT * FROM payment_schedule WHERE plan_id = ? ORDER BY seq').all(planId)).map(camel);
  res.status(201).json(plan);
}));

// GET /api/plans?dealId=
router.get('/', ah(async (req, res) => {
  const { dealId } = req.query;
  if (isAgent(req)) {
    const sql = dealId
      ? `SELECT pp.* FROM payment_plans pp JOIN deals d ON d.id = pp.deal_id
         WHERE pp.deal_id = ? AND d.agent_id = ? ORDER BY pp.created_at`
      : `SELECT pp.* FROM payment_plans pp JOIN deals d ON d.id = pp.deal_id
         WHERE d.agent_id = ? ORDER BY pp.created_at DESC`;
    const rows = dealId
      ? await db.prepare(sql).all(dealId, req.user.sub)
      : await db.prepare(sql).all(req.user.sub);
    return res.json(rows.map(camel));
  }
  const sql = dealId
    ? 'SELECT * FROM payment_plans WHERE deal_id = ? ORDER BY created_at'
    : 'SELECT * FROM payment_plans ORDER BY created_at DESC';
  const rows = dealId ? await db.prepare(sql).all(dealId) : await db.prepare(sql).all();
  res.json(rows.map(camel));
}));

// GET /api/plans/:id — with schedule + payments
router.get('/:id', ah(async (req, res) => {
  const plan = await db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(req.params.id);
  if (!plan) throw httpError(404, 'Payment plan not found.');
  await assertPlanVisible(req, plan);
  const out = camel(plan);
  out.contact = camel(await db.prepare('SELECT * FROM contacts WHERE id = ?').get(plan.contact_id));
  out.deal = camel(await db.prepare('SELECT * FROM deals WHERE id = ?').get(plan.deal_id));
  out.schedule = (await db.prepare('SELECT * FROM payment_schedule WHERE plan_id = ? ORDER BY seq')
    .all(req.params.id)).map(camel);
  out.payments = (await db.prepare(`SELECT p.*, u.name AS received_by_name FROM payments p
    LEFT JOIN users u ON u.id = p.received_by WHERE p.plan_id = ? ORDER BY p.created_at`).all(req.params.id)).map(camel);
  out.totalPaid = out.payments.reduce((s, p) => s + p.amount, 0);
  out.balance = plan.total_amount - out.totalPaid;
  res.json(out);
}));

export default router;
