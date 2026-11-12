// Expenses: office running costs (rent, utilities, marketing, salaries…).
//
// Permissions: reads need view_expenses (admin + manager); writes need
// manage_expenses (admin only). Agents get 403 on every endpoint.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid } from '../util.js';

const router = Router();
router.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateExpense(body, partial = false) {
  const { date, category, description, amount } = body || {};
  if (!partial || date !== undefined) {
    if (!date || !DATE_RE.test(date) || Number.isNaN(Date.parse(date))) {
      throw httpError(400, 'date must be a valid YYYY-MM-DD date.');
    }
  }
  if (!partial || amount !== undefined) {
    if (!(Number(amount) > 0)) throw httpError(400, 'amount must be greater than zero.');
  }
  if (category !== undefined && typeof category !== 'string') throw httpError(400, 'category must be text.');
  if (description !== undefined && typeof description !== 'string') throw httpError(400, 'description must be text.');
}

// GET /api/expenses?category=&from=&to= — list + { total, byCategory }
router.get('/', requirePermission('view_expenses'), ah(async (req, res) => {
  const { category, from, to } = req.query;
  const where = [];
  const params = [];
  if (category) { where.push('category = ?'); params.push(category); }
  if (from) {
    if (!DATE_RE.test(from)) throw httpError(400, 'from must be a YYYY-MM-DD date.');
    where.push('date >= ?'); params.push(from);
  }
  if (to) {
    if (!DATE_RE.test(to)) throw httpError(400, 'to must be a YYYY-MM-DD date.');
    where.push('date <= ?'); params.push(to);
  }
  const sql = `SELECT e.*, u.name AS recorded_by_name FROM expenses e
    LEFT JOIN users u ON u.id = e.recorded_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.date DESC, e.created_at DESC`;
  const rows = (await db.prepare(sql).all(...params)).map(camel);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const byCategory = {};
  for (const r of rows) byCategory[r.category] = (byCategory[r.category] || 0) + r.amount;
  res.json({ expenses: rows, total, byCategory });
}));

// POST /api/expenses — admin only
router.post('/', requirePermission('manage_expenses'), ah(async (req, res) => {
  validateExpense(req.body);
  const { date, category = 'Misc', description = '', amount } = req.body;
  const id = uid();
  await db.prepare(`INSERT INTO expenses (id, date, category, description, amount, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, date, String(category).trim() || 'Misc', String(description), Number(amount), req.user.sub);
  auditReq(req, 'EXPENSE_CREATE', { entityType: 'expense', entityId: id, details: `Expense recorded: ${category} ${Number(amount)} on ${date}.` });
  res.status(201).json(camel(await db.prepare('SELECT * FROM expenses WHERE id = ?').get(id)));
}));

// GET /api/expenses/:id
router.get('/:id', requirePermission('view_expenses'), ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Expense not found.');
  res.json(camel(row));
}));

// PUT /api/expenses/:id — admin only
router.put('/:id', requirePermission('manage_expenses'), ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Expense not found.');
  validateExpense(req.body, true);
  const { date, category, description, amount } = req.body || {};
  await db.prepare(`UPDATE expenses SET date = COALESCE(?, date), category = COALESCE(?, category),
      description = COALESCE(?, description), amount = COALESCE(?, amount) WHERE id = ?`)
    .run(date ?? null, category !== undefined ? (String(category).trim() || 'Misc') : null,
      description !== undefined ? String(description) : null,
      amount !== undefined ? Number(amount) : null, req.params.id);
  auditReq(req, 'EXPENSE_UPDATE', { entityType: 'expense', entityId: req.params.id, details: `Expense updated: ${row.category} ${row.amount} on ${row.date}.` });
  res.json(camel(await db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id)));
}));

// DELETE /api/expenses/:id — admin only
router.delete('/:id', requirePermission('manage_expenses'), ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Expense not found.');
  await db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  auditReq(req, 'EXPENSE_DELETE', { entityType: 'expense', entityId: req.params.id, details: `Expense deleted: ${row.category} ${row.amount} on ${row.date}.` });
  res.json({ ok: true });
}));

export default router;
