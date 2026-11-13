// Owner earnings (admin only): what the owner actually pockets, on a
// cash basis — money is counted in the month it was received/paid, not
// the month the deal was made.
//
//   commissionReceived = SUM(amount) of commissions with status = 'paid',
//                         bucketed by paid_at (the owner received it).
//   agentSharesPaid    = SUM(agent_amount) of commissions with
//                         agent_status = 'paid', bucketed by agent_paid_at
//                         (the owner paid the agent's share out).
//   expenses           = SUM(amount) of expenses, bucketed by their date.
//   netEarnings        = commissionReceived - agentSharesPaid - expenses,
//                         per month and in total.
//
// Pending commissions and pending agent shares never count here — they
// stay visible only as the existing Pending commission figure on the
// dashboard. All three series are filtered to the requested date range
// with SQLite date(), so ISO timestamps carrying a time still land in
// the right month, and every calendar month in the range gets a row,
// zero-filled when nothing happened in it.

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ah, httpError } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('view_earnings'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRESETS = { '3m': 3, '6m': 6, '12m': 12 };

function validDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

function monthKey(y, m) {
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** First day of a month, as YYYY-MM-DD. */
function monthStart(y, m) {
  return `${monthKey(y, m)}-01`;
}

/** Last day of a month, as YYYY-MM-DD. */
function monthEnd(y, m) {
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${monthKey(y, m)}-${String(lastDay).padStart(2, '0')}`;
}

/** Every YYYY-MM between the month of `from` and the month of `to`, oldest first. */
function monthsInRange(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const months = [];
  let y = fy;
  let m = fm - 1;
  while (y < ty || (y === ty && m <= tm - 1)) {
    months.push(monthKey(y, m));
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return months;
}

/** Earliest calendar month holding any earnings data, or null when empty. */
async function earliestDataMonth() {
  const rows = await Promise.all([
    db.prepare("SELECT MIN(date(paid_at)) AS d FROM commissions WHERE status = 'paid' AND paid_at IS NOT NULL").get(),
    db.prepare("SELECT MIN(date(agent_paid_at)) AS d FROM commissions WHERE agent_status = 'paid' AND agent_paid_at IS NOT NULL").get(),
    db.prepare('SELECT MIN(date(date)) AS d FROM expenses').get(),
  ]);
  const dates = rows.map((r) => r?.d).filter(Boolean);
  if (!dates.length) return null;
  return dates.sort()[0].slice(0, 7);
}

// GET /api/earnings?preset=3m|6m|12m|all  OR  ?from=YYYY-MM-DD&to=YYYY-MM-DD
// Default when no params: preset 6m. from/to wins when both are given.
router.get('/', ah(async (req, res) => {
  const { preset, from: fromQ, to: toQ } = req.query;

  let from;
  let to;

  if (fromQ !== undefined || toQ !== undefined) {
    // Custom range: both ends are required, valid, and in order.
    if (!validDate(fromQ) || !validDate(toQ)) {
      throw httpError(400, 'from and to must both be valid YYYY-MM-DD dates.');
    }
    if (fromQ > toQ) throw httpError(400, 'from must be on or before to.');
    from = fromQ;
    to = toQ;
  } else {
    const p = preset === undefined ? '6m' : preset;
    const now = new Date();
    const cy = now.getUTCFullYear();
    const cm = now.getUTCMonth();
    if (p === 'all') {
      const earliest = await earliestDataMonth();
      if (earliest) {
        const [ey, em] = earliest.split('-').map(Number);
        from = monthStart(ey, em - 1);
      } else {
        from = monthStart(cy, cm);
      }
      to = monthEnd(cy, cm);
    } else if (PRESETS[p]) {
      const n = PRESETS[p];
      // Last N calendar months including the current month.
      const start = new Date(Date.UTC(cy, cm - (n - 1), 1));
      from = monthStart(start.getUTCFullYear(), start.getUTCMonth());
      to = monthEnd(cy, cm);
    } else {
      throw httpError(400, 'preset must be one of 3m, 6m, 12m, all.');
    }
  }

  const months = monthsInRange(from, to);

  // Cash-basis series, each bucketed by the month the money actually moved.
  // date() normalises ISO timestamps with times to their calendar date.
  const [receivedRows, shareRows, expenseRows] = await Promise.all([
    db.prepare(`SELECT strftime('%Y-%m', paid_at) AS month, COALESCE(SUM(amount), 0) AS s
        FROM commissions
        WHERE status = 'paid' AND paid_at IS NOT NULL
          AND date(paid_at) >= ? AND date(paid_at) <= ?
        GROUP BY month`).all(from, to),
    db.prepare(`SELECT strftime('%Y-%m', agent_paid_at) AS month, COALESCE(SUM(agent_amount), 0) AS s
        FROM commissions
        WHERE agent_status = 'paid' AND agent_paid_at IS NOT NULL
          AND date(agent_paid_at) >= ? AND date(agent_paid_at) <= ?
        GROUP BY month`).all(from, to),
    db.prepare(`SELECT strftime('%Y-%m', date) AS month, COALESCE(SUM(amount), 0) AS s
        FROM expenses
        WHERE date(date) >= ? AND date(date) <= ?
        GROUP BY month`).all(from, to),
  ]);

  const byMonth = {};
  for (const m of months) {
    byMonth[m] = { month: m, commissionReceived: 0, agentSharesPaid: 0, expenses: 0, netEarnings: 0 };
  }
  for (const r of receivedRows) if (byMonth[r.month]) byMonth[r.month].commissionReceived += r.s;
  for (const r of shareRows) if (byMonth[r.month]) byMonth[r.month].agentSharesPaid += r.s;
  for (const r of expenseRows) if (byMonth[r.month]) byMonth[r.month].expenses += r.s;

  const monthly = months.map((m) => {
    const row = byMonth[m];
    row.netEarnings = row.commissionReceived - row.agentSharesPaid - row.expenses;
    return row;
  });

  const totals = monthly.reduce((t, r) => ({
    commissionReceived: t.commissionReceived + r.commissionReceived,
    agentSharesPaid: t.agentSharesPaid + r.agentSharesPaid,
    expenses: t.expenses + r.expenses,
    netEarnings: t.netEarnings + r.netEarnings,
  }), { commissionReceived: 0, agentSharesPaid: 0, expenses: 0, netEarnings: 0 });

  res.json({ from, to, totals, monthly });
}));

export default router;
