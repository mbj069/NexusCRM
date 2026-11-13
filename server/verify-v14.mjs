// NexusCRM v1.4 verification suite — runs against a local server on the
// file DB (http://localhost:4000). Run against a freshly seeded database;
// exits non-zero if any check fails.
//
// Covers: owner earnings (GET /api/earnings, admin-only, cash basis) —
// math hand-checked against the seed rows for all-time and for single
// months, monthly rows summing to period totals, preset month sets,
// custom-range filtering, pending commissions/shares excluded, role
// scoping (manager/agent 403 + no earnings keys on their dashboards),
// unauthenticated 401, invalid preset / bad dates 400, and the seed
// date spread (expenses across Jun–Oct 2026).
//
// Seed figures the suite pins (v1.4 seed — only dates moved from v1.3,
// every amount unchanged):
//   received 131,250 (D3 paid 2026-10-05); shares paid 25,000 (D2 paid
//   2026-10-06); expenses 442,000 (Jun 120,000 / Jul 250,000 /
//   Aug 18,500 / Sep 45,000 / Oct 8,500); net −335,750.
//   Monthly net: Jun −120,000; Jul −250,000; Aug −18,500; Sep −45,000;
//   Oct +97,750 (131,250 − 25,000 − 8,500); Nov 0.
const BASE = 'http://localhost:4000';
let passed = 0, failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name} ${extra}`); }
}

async function req(method, path, token = null, body = null) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

async function login(username, password) {
  return req('POST', '/api/auth/login', null, { username, password });
}

const get = (p, t) => req('GET', p, t);

/** Last N calendar months (YYYY-MM), oldest first, including the current month. */
function lastNMonths(n) {
  const now = new Date();
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

/** Monthly rows sum to the period totals, and each row's net is received − shares − expenses. */
function sumsCheck(label, body) {
  const rows = body?.monthly || [];
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const netsOk = rows.every((r) => r.netEarnings === r.commissionReceived - r.agentSharesPaid - r.expenses);
  return body?.totals?.commissionReceived === sum('commissionReceived')
    && body?.totals?.agentSharesPaid === sum('agentSharesPaid')
    && body?.totals?.expenses === sum('expenses')
    && body?.totals?.netEarnings === sum('netEarnings')
    && netsOk;
}

const row = (body, month) => (body?.monthly || []).find((r) => r.month === month);
const monthsOf = (body) => (body?.monthly || []).map((r) => r.month);

console.log('== 1. Logins ==');
const adminLogin = await login('admin@nexuscrm.local', 'changeme123');
check('admin login 200', adminLogin.status === 200);
const adminTok = adminLogin.json?.token;
const managerLogin = await login('manager@nexuscrm.local', 'manager123');
check('manager login 200', managerLogin.status === 200);
const managerTok = managerLogin.json?.token;
const agentLogin = await login('agent@nexuscrm.local', 'agent123');
check('agent login 200', agentLogin.status === 200);
const agentTok = agentLogin.json?.token;

console.log('== 2. All-time earnings, hand-checked against the seed ==');
const all = await get('/api/earnings?preset=all', adminTok);
check('all-time 200', all.status === 200, `got ${all.status}: ${all.text?.slice(0, 200)}`);
check('all-time range Jun 2026 → Nov 2026 (earliest data is Jun)',
  all.json?.from === '2026-06-01' && all.json?.to === '2026-11-30',
  JSON.stringify({ from: all.json?.from, to: all.json?.to }));
check('all-time months are Jun–Nov 2026',
  JSON.stringify(monthsOf(all.json)) === JSON.stringify(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']),
  JSON.stringify(monthsOf(all.json)));
check('all-time totals: received 131,250 / shares 25,000 / expenses 442,000 / net −335,750',
  all.json?.totals?.commissionReceived === 131250
  && all.json?.totals?.agentSharesPaid === 25000
  && all.json?.totals?.expenses === 442000
  && all.json?.totals?.netEarnings === -335750,
  JSON.stringify(all.json?.totals));
check('Jun: received 0 / shares 0 / expenses 120,000 / net −120,000',
  row(all.json, '2026-06')?.commissionReceived === 0 && row(all.json, '2026-06')?.agentSharesPaid === 0
  && row(all.json, '2026-06')?.expenses === 120000 && row(all.json, '2026-06')?.netEarnings === -120000,
  JSON.stringify(row(all.json, '2026-06')));
check('Jul: expenses 250,000 / net −250,000',
  row(all.json, '2026-07')?.expenses === 250000 && row(all.json, '2026-07')?.netEarnings === -250000
  && row(all.json, '2026-07')?.commissionReceived === 0 && row(all.json, '2026-07')?.agentSharesPaid === 0,
  JSON.stringify(row(all.json, '2026-07')));
check('Aug: expenses 18,500 / net −18,500',
  row(all.json, '2026-08')?.expenses === 18500 && row(all.json, '2026-08')?.netEarnings === -18500,
  JSON.stringify(row(all.json, '2026-08')));
check('Sep: expenses 45,000 / net −45,000',
  row(all.json, '2026-09')?.expenses === 45000 && row(all.json, '2026-09')?.netEarnings === -45000,
  JSON.stringify(row(all.json, '2026-09')));
check('Oct: received 131,250 / shares 25,000 / expenses 8,500 / net +97,750',
  row(all.json, '2026-10')?.commissionReceived === 131250 && row(all.json, '2026-10')?.agentSharesPaid === 25000
  && row(all.json, '2026-10')?.expenses === 8500 && row(all.json, '2026-10')?.netEarnings === 97750,
  JSON.stringify(row(all.json, '2026-10')));
check('Nov: all zero (zero-filled month)',
  row(all.json, '2026-11')?.commissionReceived === 0 && row(all.json, '2026-11')?.agentSharesPaid === 0
  && row(all.json, '2026-11')?.expenses === 0 && row(all.json, '2026-11')?.netEarnings === 0,
  JSON.stringify(row(all.json, '2026-11')));
check('all-time monthly rows sum to totals, per-row net = received − shares − expenses',
  sumsCheck('all', all.json), JSON.stringify(all.json?.totals));

console.log('== 3. Default = 6m (Jun–Nov) ==');
const def = await get('/api/earnings', adminTok);
check('default 200', def.status === 200, `got ${def.status}`);
check('default months are the last 6 calendar months (Jun–Nov 2026)',
  JSON.stringify(monthsOf(def.json)) === JSON.stringify(lastNMonths(6)),
  JSON.stringify(monthsOf(def.json)));
check('default totals match all-time (no data before Jun 2026)',
  JSON.stringify(def.json?.totals) === JSON.stringify(all.json?.totals),
  JSON.stringify(def.json?.totals));
check('default monthly rows sum to totals', sumsCheck('default', def.json));

console.log('== 4. Presets return the right month sets ==');
const p3 = await get('/api/earnings?preset=3m', adminTok);
check('3m months are Sep–Nov 2026',
  JSON.stringify(monthsOf(p3.json)) === JSON.stringify(lastNMonths(3)),
  JSON.stringify(monthsOf(p3.json)));
check('3m totals: received 131,250 / shares 25,000 / expenses 53,500 / net 52,750',
  p3.json?.totals?.commissionReceived === 131250 && p3.json?.totals?.agentSharesPaid === 25000
  && p3.json?.totals?.expenses === 53500 && p3.json?.totals?.netEarnings === 52750,
  JSON.stringify(p3.json?.totals));
check('3m monthly rows sum to totals', sumsCheck('3m', p3.json));
const p6 = await get('/api/earnings?preset=6m', adminTok);
check('6m months are Jun–Nov 2026',
  JSON.stringify(monthsOf(p6.json)) === JSON.stringify(lastNMonths(6)),
  JSON.stringify(monthsOf(p6.json)));
check('6m totals match default', JSON.stringify(p6.json?.totals) === JSON.stringify(def.json?.totals));
const p12 = await get('/api/earnings?preset=12m', adminTok);
check('12m months are Dec 2025–Nov 2026 (12 rows)',
  monthsOf(p12.json).length === 12 && JSON.stringify(monthsOf(p12.json)) === JSON.stringify(lastNMonths(12)),
  JSON.stringify(monthsOf(p12.json)));
check('12m totals match all-time (nothing before Jun 2026)',
  JSON.stringify(p12.json?.totals) === JSON.stringify(all.json?.totals),
  JSON.stringify(p12.json?.totals));
check('12m zero-filled months before Jun are all zero',
  (p12.json?.monthly || []).filter((r) => r.month < '2026-06')
    .every((r) => r.commissionReceived === 0 && r.agentSharesPaid === 0 && r.expenses === 0 && r.netEarnings === 0),
  JSON.stringify((p12.json?.monthly || []).filter((r) => r.month < '2026-06')));
check('12m monthly rows sum to totals', sumsCheck('12m', p12.json));
const pAll = await get('/api/earnings?preset=all', adminTok);
check('preset=all months match all-time months',
  JSON.stringify(monthsOf(pAll.json)) === JSON.stringify(monthsOf(all.json)));

console.log('== 5. Custom ranges filter correctly ==');
const oct = await get('/api/earnings?from=2026-10-01&to=2026-10-31', adminTok);
check('Oct-only 200, single month row',
  oct.status === 200 && monthsOf(oct.json).length === 1 && monthsOf(oct.json)[0] === '2026-10',
  JSON.stringify(monthsOf(oct.json)));
check('Oct-only: received 131,250 / shares 25,000 / expenses 8,500 / net 97,750',
  oct.json?.totals?.commissionReceived === 131250 && oct.json?.totals?.agentSharesPaid === 25000
  && oct.json?.totals?.expenses === 8500 && oct.json?.totals?.netEarnings === 97750,
  JSON.stringify(oct.json?.totals));
check('Oct-only row matches the Oct row in the all-time view',
  JSON.stringify(row(oct.json, '2026-10')) === JSON.stringify(row(all.json, '2026-10')));
const aug = await get('/api/earnings?from=2026-08-01&to=2026-08-31', adminTok);
check('Aug-only: received 0 / shares 0 / expenses 18,500 / net −18,500',
  aug.json?.totals?.commissionReceived === 0 && aug.json?.totals?.agentSharesPaid === 0
  && aug.json?.totals?.expenses === 18500 && aug.json?.totals?.netEarnings === -18500,
  JSON.stringify(aug.json?.totals));
const empty = await get('/api/earnings?from=2025-01-01&to=2025-03-31', adminTok);
check('empty range (Jan–Mar 2025): 3 zero-filled rows, totals all zero',
  monthsOf(empty.json).length === 3
  && empty.json?.totals?.commissionReceived === 0 && empty.json?.totals?.agentSharesPaid === 0
  && empty.json?.totals?.expenses === 0 && empty.json?.totals?.netEarnings === 0
  && (empty.json?.monthly || []).every((r) => r.netEarnings === 0),
  JSON.stringify(empty.json?.totals));

console.log('== 6. Pending commissions / shares never count ==');
const comms = await get('/api/commissions', adminTok);
check('seed still has 225,500 pending owner commission (so exclusion is real)',
  comms.json?.summary?.pending === 225500, JSON.stringify(comms.json?.summary));
check('seed still has 40,000 pending agent shares (so exclusion is real)',
  comms.json?.agentSummary?.agentPending === 40000, JSON.stringify(comms.json?.agentSummary));
check('received 131,250, NOT 356,750 — pending owner commission excluded',
  all.json?.totals?.commissionReceived === 131250
  && all.json?.totals?.commissionReceived !== (comms.json?.summary?.pending || 0) + (comms.json?.summary?.paid || 0),
  JSON.stringify(all.json?.totals));
check('shares paid 25,000, NOT 65,000 — pending agent shares excluded',
  all.json?.totals?.agentSharesPaid === 25000
  && all.json?.totals?.agentSharesPaid !== (comms.json?.agentSummary?.agentPending || 0) + (comms.json?.agentSummary?.agentPaid || 0),
  JSON.stringify(all.json?.totals));
check('Aug-only nets to its expenses only despite pending commissions existing',
  aug.json?.totals?.commissionReceived === 0 && aug.json?.totals?.netEarnings === -aug.json?.totals?.expenses,
  JSON.stringify(aug.json?.totals));

console.log('== 7. Role scoping + auth ==');
check('manager GET /api/earnings → 403', (await get('/api/earnings', managerTok)).status === 403);
check('agent GET /api/earnings → 403', (await get('/api/earnings', agentTok)).status === 403);
check('unauthenticated GET /api/earnings → 401', (await get('/api/earnings')).status === 401);
const EARNINGS_KEYS = ['earnings', 'netEarnings', 'commissionReceived', 'agentSharesPaid'];
const mgrDash = await get('/api/dashboard', managerTok);
check('manager dashboard 200', mgrDash.status === 200);
for (const k of EARNINGS_KEYS) {
  check(`manager dashboard has NO ${k}`, mgrDash.json?.[k] === undefined, JSON.stringify(mgrDash.json?.[k]));
}
const agentDash = await get('/api/dashboard', agentTok);
check('agent dashboard 200', agentDash.status === 200);
for (const k of EARNINGS_KEYS) {
  check(`agent dashboard has NO ${k}`, agentDash.json?.[k] === undefined, JSON.stringify(agentDash.json?.[k]));
}
const adminDash = await get('/api/dashboard', adminTok);
check('admin dashboard 200', adminDash.status === 200);
for (const k of EARNINGS_KEYS) {
  check(`admin dashboard has NO ${k} (earnings live only on /api/earnings)`, adminDash.json?.[k] === undefined, JSON.stringify(adminDash.json?.[k]));
}

console.log('== 8. Invalid input → 400 ==');
check('preset=9m → 400', (await get('/api/earnings?preset=9m', adminTok)).status === 400);
check('preset=foo → 400', (await get('/api/earnings?preset=foo', adminTok)).status === 400);
check('from only (no to) → 400', (await get('/api/earnings?from=2026-10-01', adminTok)).status === 400);
check('to only (no from) → 400', (await get('/api/earnings?to=2026-10-31', adminTok)).status === 400);
check('garbage from date → 400', (await get('/api/earnings?from=2026-13-01&to=2026-10-31', adminTok)).status === 400);
check('non-ISO date → 400', (await get('/api/earnings?from=10-01-2026&to=2026-10-31', adminTok)).status === 400);
check('from after to → 400', (await get('/api/earnings?from=2026-10-31&to=2026-10-01', adminTok)).status === 400);

console.log('== 9. Seed dates span at least 4 distinct months ==');
const exps = await get('/api/expenses', adminTok);
const expMonths = [...new Set((exps.json?.expenses || []).map((e) => String(e.date).slice(0, 7)))];
check('expenses span 5 distinct months (Jun–Oct 2026)',
  expMonths.length === 5 && JSON.stringify(expMonths.sort()) === JSON.stringify(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']),
  JSON.stringify(expMonths));
check('expenses total still 442,000', exps.json?.total === 442000, JSON.stringify(exps.json?.total));
const activeMonths = (all.json?.monthly || []).filter((r) => r.expenses !== 0 || r.commissionReceived !== 0 || r.agentSharesPaid !== 0);
check('earnings monthly rows show activity in 5 distinct months',
  activeMonths.length === 5, JSON.stringify(activeMonths.map((r) => r.month)));

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if (failures.length) console.log('Failures:', failures.join(' | '));
process.exit(failed ? 1 : 0);
