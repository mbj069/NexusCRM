// Notifications: list, mark read, and an overdue-installment scanner.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid, todayStr, daysBetween } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

// GET /api/notifications — own + broadcast, newest first
router.get('/', ah(async (req, res) => {
  const { unread } = req.query;
  const where = ['(user_id IS NULL OR user_id = ?)'];
  const params = [req.user.sub];
  if (unread === '1') { where.push('is_read = 0'); }
  const rows = await db.prepare(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 100`)
    .all(...params);
  const unreadCount = (await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE (user_id IS NULL OR user_id = ?) AND is_read = 0')
    .get(req.user.sub)).n;
  res.json({ notifications: rows.map(camel), unreadCount });
}));

// POST /api/notifications/:id/read
router.post('/:id/read', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Notification not found.');
  if (row.user_id && row.user_id !== req.user.sub) throw httpError(403, 'Not your notification.');
  await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// POST /api/notifications/scan-overdue — broadcast notifications for overdue
// installments that don't already have one (deduped by link).
router.post('/scan-overdue', ah(async (req, res) => {
  const today = todayStr();
  const rows = await db.prepare(`SELECT s.id, s.seq, s.kind, s.due_date, s.amount, c.name AS contact_name,
      pr.code AS property_code,
      (SELECT COUNT(*) FROM payment_schedule s2
        WHERE s2.plan_id = s.plan_id AND s2.kind = 'installment' AND s2.seq <= s.seq) AS inst_idx
    FROM payment_schedule s
    JOIN payment_plans pp ON pp.id = s.plan_id
    JOIN contacts c ON c.id = pp.contact_id
    LEFT JOIN deals d ON d.id = pp.deal_id
    LEFT JOIN properties pr ON pr.id = d.property_id
    WHERE s.status = 'pending' AND s.due_date < ?`).all(today);
  let created = 0;
  for (const r of rows) {
    const link = `schedule:${r.id}`;
    const exists = await db.prepare('SELECT id FROM notifications WHERE link = ? AND kind = ?').get(link, 'overdue_installment');
    if (exists) continue;
    const paid = (await db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE schedule_id = ?').get(r.id)).s;
    const outstanding = r.amount - paid;
    if (outstanding <= 0.01) continue;
    const kindLabel = { token: 'token money', bayana: 'bayana', installment: `installment #${r.inst_idx}`, final: 'final payment' }[r.kind] || r.kind;
    const days = daysBetween(today, r.due_date);
    await db.prepare(`INSERT INTO notifications (id, user_id, kind, title, body, link)
      VALUES (?, NULL, 'overdue_installment', ?, ?, ?)`)
      .run(uid(),
        `Overdue: ${r.contact_name}'s ${kindLabel}`,
        `${r.contact_name} owes ${outstanding.toLocaleString()} PKR (${kindLabel}, due ${r.due_date}, ${days} day(s) overdue)${r.property_code ? ` — property ${r.property_code}` : ''}.`,
        link);
    created++;
  }
  auditReq(req, 'OVERDUE_SCAN', { details: `Overdue scan created ${created} notification(s).` });
  res.json({ created });
}));

export default router;
