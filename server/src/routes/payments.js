// Payments + receipts. Receipt numbers come from the counters table
// (RCP-YYYY-NNNN). Partial payments are recorded; a schedule row is marked
// paid once cumulative payments cover its amount.

import { Router } from 'express';
import { db, camel, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid, todayStr, pkr } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

const VALID_METHODS = ['cash', 'bank', 'transfer'];

const isAgent = (req) => req.user.role === 'agent';

// Stage labels for the Token → Bayana → Installments → Final hierarchy.
// Installments are numbered by their position among installment rows
// (seq counts all stages, so it is not the installment number).
async function stageLabel(sched) {
  if (!sched) return '';
  if (sched.kind === 'installment') {
    const n = (await db.prepare(`SELECT COUNT(*) AS n FROM payment_schedule
      WHERE plan_id = ? AND kind = 'installment' AND seq <= ?`).get(sched.plan_id, sched.seq)).n;
    return `Installment #${n}`;
  }
  return { token: 'Token money', bayana: 'Bayana', final: 'Final payment' }[sched.kind] || sched.kind;
}

/** Next receipt number for the current year, inside an open transaction. */
async function nextReceiptNo(tx) {
  const year = new Date().getFullYear();
  const name = `receipt_${year}`;
  const row = await tx.prepare('SELECT next FROM counters WHERE name = ?').get(name);
  const n = row ? row.next : 1;
  if (row) await tx.prepare('UPDATE counters SET next = next + 1 WHERE name = ?').run(name);
  else await tx.prepare('INSERT INTO counters (name, next) VALUES (?, 2)').run(name);
  return `RCP-${year}-${String(n).padStart(4, '0')}`;
}

// POST /api/payments { scheduleId, amount, method, notes? }
router.post('/', ah(async (req, res) => {
  const { scheduleId, amount, method = 'cash', notes = '' } = req.body || {};
  if (!scheduleId) throw httpError(400, 'scheduleId is required.');
  if (!(Number(amount) > 0)) throw httpError(400, 'Amount must be a positive number.');
  if (!VALID_METHODS.includes(method)) throw httpError(400, `Method must be one of: ${VALID_METHODS.join(', ')}.`);

  const paymentId = uid();
  let receiptNo;
  await withTransaction(async (tx) => {
    const sched = await tx.prepare('SELECT * FROM payment_schedule WHERE id = ?').get(scheduleId);
    if (!sched) throw httpError(404, 'Schedule row not found.');
    if (isAgent(req)) {
      const deal = await tx.prepare(`SELECT d.agent_id FROM deals d
        JOIN payment_plans pp ON pp.deal_id = d.id WHERE pp.id = ?`).get(sched.plan_id);
      if (!deal || deal.agent_id !== req.user.sub) throw httpError(403, 'Cannot record a payment on another agent\u2019s deal.');
    }
    receiptNo = await nextReceiptNo(tx);
    await tx.prepare(`INSERT INTO payments (id, plan_id, schedule_id, amount, method, received_by, receipt_no, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(paymentId, sched.plan_id, scheduleId, Number(amount), method, req.user.sub, receiptNo, String(notes));
    const paidSoFar = (await tx.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE schedule_id = ?')
      .get(scheduleId)).s;
    if (paidSoFar >= sched.amount - 0.01) {
      await tx.prepare(`UPDATE payment_schedule SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).run(scheduleId);
    }
    await auditReq(req, 'PAYMENT', {
      entityType: 'payment', entityId: paymentId,
      details: `Payment ${pkr(amount)} (${method}) against schedule ${sched.seq} of plan ${sched.plan_id} — receipt ${receiptNo}.`,
    }, tx);
  });
  const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  res.status(201).json(camel(payment));
}));

// GET /api/payments?planId=
router.get('/', ah(async (req, res) => {
  const { planId } = req.query;
  const where = [];
  const params = [];
  if (planId) { where.push('p.plan_id = ?'); params.push(planId); }
  if (isAgent(req)) {
    where.push('p.plan_id IN (SELECT pp.id FROM payment_plans pp JOIN deals d ON d.id = pp.deal_id WHERE d.agent_id = ?)');
    params.push(req.user.sub);
  }
  const sql = `SELECT p.*, u.name AS received_by_name FROM payments p
    LEFT JOIN users u ON u.id = p.received_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.created_at DESC LIMIT 200`;
  res.json((await db.prepare(sql).all(...params)).map(camel));
}));

// Shared receipt payload
async function receiptData(paymentId, req) {
  const p = await db.prepare(`SELECT p.*, u.name AS received_by_name FROM payments p
    LEFT JOIN users u ON u.id = p.received_by WHERE p.id = ?`).get(paymentId);
  if (!p) throw httpError(404, 'Payment not found.');
  const plan = await db.prepare('SELECT * FROM payment_plans WHERE id = ?').get(p.plan_id);
  const sched = await db.prepare('SELECT * FROM payment_schedule WHERE id = ?').get(p.schedule_id);
  const contact = plan ? await db.prepare('SELECT * FROM contacts WHERE id = ?').get(plan.contact_id) : null;
  const deal = plan ? await db.prepare('SELECT * FROM deals WHERE id = ?').get(plan.deal_id) : null;
  if (req && isAgent(req) && (!deal || deal.agent_id !== req.user.sub)) {
    throw httpError(403, 'Receipt not on one of your deals.');
  }
  const property = deal?.property_id ? await db.prepare('SELECT * FROM properties WHERE id = ?').get(deal.property_id) : null;
  const kindLabel = await stageLabel(sched);
  return {
    receiptNo: p.receipt_no,
    date: p.created_at,
    agency: 'NexusCRM Demo',
    receivedFrom: contact ? { name: contact.name, phone: contact.phone } : null,
    property: property ? { code: property.code, title: property.title, location: property.location } : null,
    lineItems: [
      { label: kindLabel, dueDate: sched?.due_date || '', amount: p.amount },
    ],
    total: p.amount,
    method: p.method,
    receivedBy: p.received_by_name || '',
    notes: p.notes || '',
  };
}

// --- Receipts (mounted separately at /api/receipts) -------------------------

export const receiptsRouter = Router();
receiptsRouter.use(requireAuth, requirePermission('crm'));

// GET /api/receipts/:paymentId — receipt JSON
receiptsRouter.get('/:paymentId', ah(async (req, res) => {
  res.json(await receiptData(req.params.paymentId, req));
}));

// GET /api/receipts/:paymentId/html — printable HTML receipt, no external assets
receiptsRouter.get('/:paymentId/html', ah(async (req, res) => {
  const r = await receiptData(req.params.paymentId, req);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${esc(r.receiptNo)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1c1917; margin: 0; padding: 32px; background: #fff; }
  .receipt { max-width: 640px; margin: 0 auto; border: 2px solid #1c1917; padding: 36px 40px; }
  .head { text-align: center; border-bottom: 2px solid #1c1917; padding-bottom: 18px; margin-bottom: 22px; }
  .head h1 { margin: 0; font-size: 26px; letter-spacing: 2px; }
  .head p { margin: 4px 0 0; font-size: 13px; color: #57534e; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 18px; font-size: 14px; }
  .rows { width: 100%; border-collapse: collapse; margin: 12px 0 18px; font-size: 15px; }
  .rows th { text-align: left; border-bottom: 1px solid #1c1917; padding: 8px 4px; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; }
  .rows td { padding: 10px 4px; border-bottom: 1px dotted #a8a29e; }
  .total td { border-bottom: none; border-top: 2px solid #1c1917; font-weight: bold; font-size: 17px; padding-top: 12px; }
  .foot { margin-top: 26px; font-size: 13px; color: #57534e; }
  .sign { display: flex; justify-content: space-between; margin-top: 48px; font-size: 14px; }
  .sign div { border-top: 1px solid #1c1917; padding-top: 6px; width: 40%; text-align: center; }
  @media print {
    body { padding: 0; }
    .receipt { border: none; padding: 0; max-width: none; }
  }
</style>
</head>
<body>
<div class="receipt">
  <div class="head">
    <h1>${esc(r.agency)}</h1>
    <p>Payment Receipt</p>
  </div>
  <div class="meta">
    <div><strong>Receipt No:</strong> ${esc(r.receiptNo)}<br><strong>Date:</strong> ${esc(String(r.date).slice(0, 10))}</div>
    <div><strong>Received from:</strong> ${esc(r.receivedFrom?.name || '')}<br><strong>Phone:</strong> ${esc(r.receivedFrom?.phone || '')}</div>
  </div>
  ${r.property ? `<p style="font-size:14px"><strong>Property:</strong> ${esc(r.property.code)} — ${esc(r.property.title)}, ${esc(r.property.location)}</p>` : ''}
  <table class="rows">
    <thead><tr><th>Description</th><th>Due date</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      ${r.lineItems.map(i => `<tr><td>${esc(i.label)}</td><td>${esc(i.dueDate)}</td><td style="text-align:right">${esc(pkr(i.amount))}</td></tr>`).join('')}
      <tr class="total"><td colspan="2">Total received</td><td style="text-align:right">${esc(pkr(r.total))}</td></tr>
    </tbody>
  </table>
  <p style="font-size:14px"><strong>Payment method:</strong> ${esc(r.method)} &nbsp;•&nbsp; <strong>Received by:</strong> ${esc(r.receivedBy)}</p>
  ${r.notes ? `<p style="font-size:14px"><strong>Notes:</strong> ${esc(r.notes)}</p>` : ''}
  <div class="sign"><div>Received by</div><div>Paid by</div></div>
  <div class="foot">This is a computer-generated receipt.</div>
</div>
</body>
</html>`;
  res.type('html').send(html);
}));

export default router;
