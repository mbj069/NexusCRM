// NexusCRM v1.3 verification suite — runs against a local server on the
// file DB (http://localhost:4000). Run against a freshly seeded database;
// exits non-zero if any check fails.
//
// Covers: commission owner-total vs agent-share split (create, PUT,
// pay / pay-agent-share independence, role scoping), dashboard v1.3
// shapes per role, leads buy/rent only, expenses CRUD + permissions,
// rental deal split. Expected values are computed live from the API
// wherever test deals change the totals, so the suite stays valid even
// if the seed changes — except the seed split rows (D1–D4), which the
// seed guarantees.
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
const post = (p, t, b) => req('POST', p, t, b);
const put = (p, t, b) => req('PUT', p, t, b);
const del = (p, t) => req('DELETE', p, t);

const ABSENT_DASHBOARD_KEYS = ['revenue', 'commissionTotals', 'overdueInstallments', 'overdueCount', 'overdueTotal', 'recentActivity', 'agentPerformance', 'followups', 'myCommissions', 'myTotalCommission', 'myPendingCommission', 'myDeals'];

console.log('== 1. Logins ==');
const adminLogin = await login('admin@nexuscrm.local', 'changeme123');
check('admin login 200', adminLogin.status === 200);
const adminTok = adminLogin.json?.token;
const managerLogin = await login('manager@nexuscrm.local', 'manager123');
check('manager login 200', managerLogin.status === 200);
const managerTok = managerLogin.json?.token;
const agentLogin = await login('agent@nexuscrm.local', 'agent123');
check('agent (Bilal) login 200', agentLogin.status === 200);
const agentTok = agentLogin.json?.token;
const agentId = agentLogin.json?.user?.id;
const omarLogin = await login('omar@nexuscrm.local', 'omar123');
check('agent (Omar) login 200', omarLogin.status === 200);
const omarTok = omarLogin.json?.token;
const omarId = omarLogin.json?.user?.id;

console.log('== 2. Seed commission split (owner total vs agent share) ==');
const seedComms = await get('/api/commissions', adminTok);
const seedRows = seedComms.json?.commissions || [];
check('seed has 4 commission rows', seedRows.length === 4, `n=${seedRows.length}`);
const byAmount = (amt) => seedRows.find((c) => c.amount === amt);
check('D1 total 78,000 / share 15,000, both pending',
  byAmount(78000)?.agentAmount === 15000 && byAmount(78000)?.agentStatus === 'pending' && byAmount(78000)?.status === 'pending',
  JSON.stringify(byAmount(78000)));
check('D2 total 125,000 / share 25,000 PAID, owner still pending (independent statuses)',
  byAmount(125000)?.agentAmount === 25000 && byAmount(125000)?.agentStatus === 'paid' && byAmount(125000)?.status === 'pending' && byAmount(125000)?.manual === 1,
  JSON.stringify(byAmount(125000)));
check('D3 owner PAID 131,250 / share 20,000 still pending',
  byAmount(131250)?.agentAmount === 20000 && byAmount(131250)?.agentStatus === 'pending' && byAmount(131250)?.status === 'paid',
  JSON.stringify(byAmount(131250)));
check('D4 rental total 22,500 / share 5,000, both pending, manual=1',
  byAmount(22500)?.agentAmount === 5000 && byAmount(22500)?.agentStatus === 'pending' && byAmount(22500)?.manual === 1,
  JSON.stringify(byAmount(22500)));
check('seed owner summary pending 225,500 / paid 131,250',
  seedComms.json?.summary?.pending === 225500 && seedComms.json?.summary?.paid === 131250,
  JSON.stringify(seedComms.json?.summary));
check('seed agent summary pending 40,000 / paid 25,000',
  seedComms.json?.agentSummary?.agentPending === 40000 && seedComms.json?.agentSummary?.agentPaid === 25000,
  JSON.stringify(seedComms.json?.agentSummary));
check('seed expenses present (5 rows, total 442,000)',
  (await get('/api/expenses', adminTok)).json?.total === 442000, JSON.stringify((await get('/api/expenses', adminTok)).json?.total));

console.log('== 3. Test fixtures: lead + properties ==');
const testLead = await post('/api/leads', adminTok, { name: 'V13 Buyer', phone: '+923000001301', intent: 'buy', society: 'Model City', assignedTo: agentId });
check('test lead created', testLead.status === 201, JSON.stringify(testLead.json));
const testLeadId = testLead.json?.id;
const availProps = await get('/api/properties?status=Available', adminTok);
const saleProps = (availProps.json || []).filter((p) => p.listingType === 'sale');
check('sale properties available for test deals', saleProps.length >= 4, `n=${saleProps.length}`);
const rentProp = (availProps.json || []).find((p) => p.code === 'RNT-HSE-002');
check('rental test property RNT-HSE-002 available (35,000/mo)', !!rentProp, JSON.stringify(rentProp?.code));

async function makeDeal(propId, body) {
  return post('/api/deals', adminTok, { leadId: testLeadId, propertyId: propId, agentId, ...body });
}
async function dealCommission(dealId) {
  const d = await get(`/api/deals/${dealId}`, adminTok);
  return d.json?.commissions?.[0];
}

console.log('== 4. Deal create with agent share ==');
const deal1 = await makeDeal(saleProps[0].id, { dealValue: 2000000, bayanaAmount: 0, commissionType: 'percent', commissionValue: 2, agentShareAmount: 10000 });
check('deal1 create 201 (total 40,000)', deal1.status === 201 && deal1.json?.dealValue === 2000000, JSON.stringify(deal1.json));
const deal1Id = deal1.json?.id;
const comm1 = await dealCommission(deal1Id);
check('deal1 commission: total 40,000, share 10,000, both pending',
  comm1?.amount === 40000 && comm1?.agentAmount === 10000 && comm1?.agentStatus === 'pending' && comm1?.status === 'pending',
  JSON.stringify(comm1));
const deal2 = await makeDeal(saleProps[1].id, { dealValue: 1000000, bayanaAmount: 0, commissionType: 'percent', commissionValue: 5, agentSharePercent: 20 });
check('deal2 create 201 (total 50,000)', deal2.status === 201, JSON.stringify(deal2.json));
const deal2Id = deal2.json?.id;
const comm2 = await dealCommission(deal2Id);
check('deal2 commission: percent share 20% of 50,000 = 10,000 stored as amount',
  comm2?.amount === 50000 && comm2?.agentAmount === 10000, JSON.stringify(comm2));
const deal3 = await makeDeal(saleProps[2].id, { dealValue: 1000000, bayanaAmount: 0, commissionType: 'percent', commissionValue: 10, agentShareAmount: 7000, agentSharePercent: 50 });
check('deal3 create 201 (total 100,000)', deal3.status === 201, JSON.stringify(deal3.json));
const deal3Id = deal3.json?.id;
const comm3 = await dealCommission(deal3Id);
check('deal3 commission: both given → amount wins (7,000, not 50%)',
  comm3?.amount === 100000 && comm3?.agentAmount === 7000, JSON.stringify(comm3));
const badPct = await makeDeal(saleProps[3].id, { dealValue: 1000000, commissionType: 'percent', commissionValue: 2, agentSharePercent: 150 });
check('agentSharePercent 150 → 400', badPct.status === 400, `got ${badPct.status}`);
const badAmt = await makeDeal(saleProps[3].id, { dealValue: 1000000, commissionType: 'percent', commissionValue: 2, agentShareAmount: -5 });
check('agentShareAmount -5 → 400', badAmt.status === 400, `got ${badAmt.status}`);
const shareAudit = await get('/api/audit?action=COMMISSION_AGENT_SHARE&limit=10', adminTok);
check('share-at-creation audit-logged COMMISSION_AGENT_SHARE', JSON.stringify(shareAudit.json).includes(deal1Id || 'x'), JSON.stringify(shareAudit.json)?.slice(0, 200));

console.log('== 5. Owner-pay and agent-share-pay are independent ==');
const payOwner1 = await post(`/api/commissions/${comm1.id}/pay`, adminTok, {});
check('pay owner on deal1 200 (status paid)', payOwner1.status === 200 && payOwner1.json?.status === 'paid', JSON.stringify(payOwner1.json));
check('pay owner leaves agent share pending', payOwner1.json?.agentStatus === 'pending' && payOwner1.json?.agentAmount === 10000, JSON.stringify(payOwner1.json));
const payOwnerAgain = await post(`/api/commissions/${comm1.id}/pay`, adminTok, {});
check('double owner pay → 400', payOwnerAgain.status === 400, `got ${payOwnerAgain.status}`);
const payShare1 = await post(`/api/commissions/${comm1.id}/pay-agent-share`, adminTok, {});
check('pay agent share on deal1 200 (agentStatus paid)', payShare1.status === 200 && payShare1.json?.agentStatus === 'paid' && payShare1.json?.agentPaidAt, JSON.stringify(payShare1.json));
check('pay agent share leaves owner status paid (unchanged)', payShare1.json?.status === 'paid' && payShare1.json?.amount === 40000, JSON.stringify(payShare1.json));
const payShareAgain = await post(`/api/commissions/${comm1.id}/pay-agent-share`, adminTok, {});
check('double agent-share pay → 400', payShareAgain.status === 400, `got ${payShareAgain.status}`);
const sharePayAudit = await get('/api/audit?action=COMMISSION_AGENT_SHARE_PAY&limit=5', adminTok);
check('agent-share pay audit-logged', JSON.stringify(sharePayAudit.json).includes(comm1.id), JSON.stringify(sharePayAudit.json)?.slice(0, 200));
// Reverse order on deal2: share first, owner still pending.
const payShare2 = await post(`/api/commissions/${comm2.id}/pay-agent-share`, adminTok, {});
check('pay share first on deal2 200', payShare2.status === 200 && payShare2.json?.agentStatus === 'paid', JSON.stringify(payShare2.json));
check('share paid first leaves owner pending', payShare2.json?.status === 'pending' && payShare2.json?.amount === 50000, JSON.stringify(payShare2.json));
const payOwner2 = await post(`/api/commissions/${comm2.id}/pay`, adminTok, {});
check('then pay owner on deal2 200', payOwner2.status === 200 && payOwner2.json?.status === 'paid' && payOwner2.json?.agentStatus === 'paid', JSON.stringify(payOwner2.json));
const ownerPayAudit = await get('/api/audit?action=COMMISSION_PAY&limit=5', adminTok);
check('owner pay audit says "Owner commission received"', JSON.stringify(ownerPayAudit.json).includes('Owner commission received'), JSON.stringify(ownerPayAudit.json)?.slice(0, 300));

console.log('== 6. PUT commission: share set + total set stay separate ==');
const putShare = await put(`/api/commissions/${comm3.id}`, adminTok, { agentAmount: 9000, agentStatus: 'paid' });
check('PUT share 200: agentAmount 9,000, agentStatus paid, agentPaidAt stamped',
  putShare.status === 200 && putShare.json?.agentAmount === 9000 && putShare.json?.agentStatus === 'paid' && !!putShare.json?.agentPaidAt,
  JSON.stringify(putShare.json));
check('PUT share does not touch owner total (100,000 pending) or set manual=0',
  putShare.json?.amount === 100000 && putShare.json?.status === 'pending' && putShare.json?.manual === 1,
  JSON.stringify(putShare.json));
const putShareBack = await put(`/api/commissions/${comm3.id}`, adminTok, { agentStatus: 'pending' });
check('PUT agentStatus back to pending clears agentPaidAt',
  putShareBack.status === 200 && putShareBack.json?.agentStatus === 'pending' && putShareBack.json?.agentPaidAt === null,
  JSON.stringify(putShareBack.json));
const putTotal = await put(`/api/commissions/${comm3.id}`, adminTok, { amount: 110000 });
check('PUT amount 200: owner total 110,000', putTotal.status === 200 && putTotal.json?.amount === 110000, JSON.stringify(putTotal.json));
check('PUT amount does not touch agent share (9,000 pending)',
  putTotal.json?.agentAmount === 9000 && putTotal.json?.agentStatus === 'pending', JSON.stringify(putTotal.json));
const badSharePut = await put(`/api/commissions/${comm3.id}`, adminTok, { agentAmount: -1 });
check('PUT negative agentAmount → 400', badSharePut.status === 400, `got ${badSharePut.status}`);
const badStatusPut = await put(`/api/commissions/${comm3.id}`, adminTok, { agentStatus: 'done' });
check('PUT bad agentStatus → 400', badStatusPut.status === 400, `got ${badStatusPut.status}`);
const manualAudit = await get('/api/audit?action=COMMISSION_AGENT_SHARE&limit=10', adminTok);
check('PUT share audit-logged COMMISSION_AGENT_SHARE', JSON.stringify(manualAudit.json).includes(comm3.id), JSON.stringify(manualAudit.json)?.slice(0, 200));

console.log('== 7. Commission permissions (manager/agent 403) ==');
const deal5 = await makeDeal(saleProps[3].id, { dealValue: 500000, bayanaAmount: 0, commissionType: 'fixed', commissionValue: 5000 });
check('deal5 create 201', deal5.status === 201, JSON.stringify(deal5.json));
const deal5Id = deal5.json?.id;
const comm5 = await dealCommission(deal5Id);
check('deal5 commission share defaults 0/pending', comm5?.agentAmount === 0 && comm5?.agentStatus === 'pending', JSON.stringify(comm5));
check('manager PUT share 403', (await put(`/api/commissions/${comm5.id}`, managerTok, { agentAmount: 1000 })).status === 403);
check('manager POST pay 403', (await post(`/api/commissions/${comm5.id}/pay`, managerTok, {})).status === 403);
check('manager POST pay-agent-share 403', (await post(`/api/commissions/${comm5.id}/pay-agent-share`, managerTok, {})).status === 403);
check('agent PUT share 403', (await put(`/api/commissions/${comm5.id}`, agentTok, { agentAmount: 1000 })).status === 403);
check('agent POST pay 403', (await post(`/api/commissions/${comm5.id}/pay`, agentTok, {})).status === 403);
check('agent POST pay-agent-share 403', (await post(`/api/commissions/${comm5.id}/pay-agent-share`, agentTok, {})).status === 403);

console.log('== 8. Agent commissions view: own rows, share figures only ==');
const bilalComms = await get('/api/commissions', agentTok);
check('agent list only own rows', Array.isArray(bilalComms.json?.commissions) && bilalComms.json.commissions.every((c) => c.agentId === agentId), `n=${bilalComms.json?.commissions?.length}`);
check('agent rows carry agentAmount/agentStatus/agentPaidAt',
  bilalComms.json?.commissions?.every((c) => c.agentAmount !== undefined && c.agentStatus !== undefined && 'agentPaidAt' in c),
  JSON.stringify(bilalComms.json?.commissions?.[0]));
check('agent response has NO owner summary', bilalComms.json?.summary === undefined, JSON.stringify(Object.keys(bilalComms.json || {})));
const bilalSharePending = bilalComms.json?.commissions?.filter((c) => c.agentStatus === 'pending').reduce((s, c) => s + (c.agentAmount || 0), 0);
const bilalSharePaid = bilalComms.json?.commissions?.filter((c) => c.agentStatus === 'paid').reduce((s, c) => s + (c.agentAmount || 0), 0);
check('agent agentSummary matches own share rows',
  bilalComms.json?.agentSummary?.agentPending === bilalSharePending && bilalComms.json?.agentSummary?.agentPaid === bilalSharePaid,
  JSON.stringify(bilalComms.json?.agentSummary));
const adminComms = await get('/api/commissions', adminTok);
check('admin response has BOTH summary and agentSummary',
  adminComms.json?.summary !== undefined && adminComms.json?.agentSummary !== undefined,
  JSON.stringify(Object.keys(adminComms.json || {})));
const allRows = adminComms.json?.commissions || [];
check('admin owner summary matches rows (amount by status)',
  adminComms.json?.summary?.pending === allRows.filter((c) => c.status === 'pending').reduce((s, c) => s + c.amount, 0)
  && adminComms.json?.summary?.paid === allRows.filter((c) => c.status === 'paid').reduce((s, c) => s + c.amount, 0),
  JSON.stringify(adminComms.json?.summary));
check('admin agentSummary matches rows (agent_amount by agent_status)',
  adminComms.json?.agentSummary?.agentPending === allRows.filter((c) => c.agentStatus === 'pending').reduce((s, c) => s + (c.agentAmount || 0), 0)
  && adminComms.json?.agentSummary?.agentPaid === allRows.filter((c) => c.agentStatus === 'paid').reduce((s, c) => s + (c.agentAmount || 0), 0),
  JSON.stringify(adminComms.json?.agentSummary));

console.log('== 9. Dashboard v1.3 per role (live-computed expectations) ==');
const allLeads = await get('/api/leads', adminTok);
const activeLeadCount = (allLeads.json || []).filter((l) => ['new', 'contacted', 'viewing', 'negotiating'].includes(l.stage)).length;
const thisMonth = new Date().toISOString().slice(0, 7);
for (const [label, tok, role] of [['admin', adminTok, 'admin'], ['manager', managerTok, 'manager'], ['agent', agentTok, 'agent']]) {
  const d = await get('/api/dashboard', tok);
  check(`${label} dashboard 200 + role=${role}`, d.status === 200 && d.json?.role === role, JSON.stringify(d.json?.role));
  for (const f of ABSENT_DASHBOARD_KEYS) {
    check(`${label} dashboard has NO ${f}`, d.json?.[f] === undefined, JSON.stringify(d.json?.[f]));
  }
  check(`${label} dashboard has commissionTrend (6 months)`,
    Array.isArray(d.json?.commissionTrend) && d.json.commissionTrend.length === 6, JSON.stringify(d.json?.commissionTrend?.length));
  check(`${label} dashboard has leads/deals/inventory series`,
    d.json?.leadsByStage !== undefined && d.json?.dealsByStage !== undefined && d.json?.inventoryByStatus !== undefined);
}
const adminDash = await get('/api/dashboard', adminTok);
check('admin totalCommission = live owner pending+paid',
  adminDash.json?.totalCommission === adminDash.json?.pendingCommission + adminDash.json?.paidCommission
  && adminDash.json?.totalCommission === (adminComms.json?.summary?.pending || 0) + (adminComms.json?.summary?.paid || 0),
  JSON.stringify(adminDash.json));
check('admin activeLeads matches non-terminal lead count', adminDash.json?.activeLeads === activeLeadCount, `dash=${adminDash.json?.activeLeads} leads=${activeLeadCount}`);
const adminTrendNow = adminDash.json?.commissionTrend?.find((m) => m.month === thisMonth);
check('admin trend current month sums match commission rows',
  adminTrendNow?.total === (adminComms.json?.summary?.pending || 0) + (adminComms.json?.summary?.paid || 0)
  && adminTrendNow?.pending === adminComms.json?.summary?.pending && adminTrendNow?.paid === adminComms.json?.summary?.paid,
  JSON.stringify(adminTrendNow));
const mgrDash = await get('/api/dashboard', managerTok);
check('manager activeLeads matches count', mgrDash.json?.activeLeads === activeLeadCount, `dash=${mgrDash.json?.activeLeads}`);
check('manager commissionCounts match rows',
  mgrDash.json?.commissionCounts?.pending === allRows.filter((c) => c.status === 'pending').length
  && mgrDash.json?.commissionCounts?.paid === allRows.filter((c) => c.status === 'paid').length,
  JSON.stringify(mgrDash.json?.commissionCounts));
const mgrTrendNow = mgrDash.json?.commissionTrend?.find((m) => m.month === thisMonth);
check('manager trend current month counts match rows',
  mgrTrendNow?.countPending === allRows.filter((c) => c.status === 'pending').length
  && mgrTrendNow?.countPaid === allRows.filter((c) => c.status === 'paid').length,
  JSON.stringify(mgrTrendNow));
const bilalDash = await get('/api/dashboard', agentTok);
check('Bilal myTotalShare = myPendingShare + myPaidShare',
  bilalDash.json?.myTotalShare === bilalDash.json?.myPendingShare + bilalDash.json?.myPaidShare,
  JSON.stringify(bilalDash.json));
check('Bilal my shares match own share rows',
  bilalDash.json?.myPendingShare === bilalSharePending && bilalDash.json?.myPaidShare === bilalSharePaid,
  `dash=${bilalDash.json?.myPendingShare}/${bilalDash.json?.myPaidShare} rows=${bilalSharePending}/${bilalSharePaid}`);
const bilalTrendNow = bilalDash.json?.commissionTrend?.find((m) => m.month === thisMonth);
check('Bilal trend current month = own share sums',
  bilalTrendNow?.total === bilalSharePending + bilalSharePaid && bilalTrendNow?.pending === bilalSharePending && bilalTrendNow?.paid === bilalSharePaid,
  JSON.stringify(bilalTrendNow));
const omarDash = await get('/api/dashboard', omarTok);
check('Omar myTotalShare is 5,000 (seed rental share only)',
  omarDash.json?.myTotalShare === 5000 && omarDash.json?.myPendingShare === 5000 && omarDash.json?.myPaidShare === 0,
  JSON.stringify(omarDash.json));

console.log('== 10. Leads: buy/rent only ==');
const sellLead = await post('/api/leads', adminTok, { name: 'V13 Seller', phone: '+923000001302', intent: 'sell', society: 'Model City' });
check("lead create intent 'sell' → 400", sellLead.status === 400, `got ${sellLead.status}: ${JSON.stringify(sellLead.json)}`);
const buyLead = await post('/api/leads', adminTok, { name: 'V13 Buyer 2', phone: '+923000001303', intent: 'buy', society: 'Model City' });
check("lead create intent 'buy' → 201", buyLead.status === 201 && buyLead.json?.intent === 'buy', JSON.stringify(buyLead.json));
const rentLead = await post('/api/leads', adminTok, { name: 'V13 Renter', phone: '+923000001304', intent: 'rent', society: 'Satellite Town' });
check("lead create intent 'rent' → 201", rentLead.status === 201 && rentLead.json?.intent === 'rent', JSON.stringify(rentLead.json));
const putSell = await put(`/api/leads/${buyLead.json?.id}`, adminTok, { intent: 'sell' });
check("PUT lead intent 'sell' → 400", putSell.status === 400, `got ${putSell.status}`);
const sellFilter = await get('/api/leads?intent=sell', adminTok);
check("GET leads?intent=sell → 400", sellFilter.status === 400, `got ${sellFilter.status}`);
const rentFilter = await get('/api/leads?intent=rent', adminTok);
check('GET leads?intent=rent returns only rent', Array.isArray(rentFilter.json) && rentFilter.json.length > 0 && rentFilter.json.every((l) => l.intent === 'rent'), `n=${rentFilter.json?.length}`);
const noSellLeads = await get('/api/leads', adminTok);
check('seed has zero sell leads', (noSellLeads.json || []).every((l) => l.intent !== 'sell'), `n=${noSellLeads.json?.length}`);

console.log('== 11. Expenses CRUD + filters + permissions ==');
const exp1 = await post('/api/expenses', adminTok, { date: '2026-11-10', category: 'Marketing', description: 'V13 test ads', amount: 10000 });
check('expense create 201 (recorded_by = admin)', exp1.status === 201 && exp1.json?.recordedBy !== undefined && exp1.json?.amount === 10000, JSON.stringify(exp1.json));
const exp1Id = exp1.json?.id;
const exp2 = await post('/api/expenses', adminTok, { date: '2026-11-11', category: 'Utilities', description: 'V13 test bill', amount: 5000 });
check('second expense create 201', exp2.status === 201, JSON.stringify(exp2.json));
const exp2Id = exp2.json?.id;
const expZero = await post('/api/expenses', adminTok, { date: '2026-11-11', category: 'Misc', amount: 0 });
check('expense amount 0 → 400', expZero.status === 400, `got ${expZero.status}`);
const expBadDate = await post('/api/expenses', adminTok, { date: '11-11-2026', category: 'Misc', amount: 100 });
check('expense bad date → 400', expBadDate.status === 400, `got ${expBadDate.status}`);
const expList = await get('/api/expenses', adminTok);
check('expense list total includes seed + tests (442,000 + 15,000)',
  expList.json?.total === 457000 && expList.json?.expenses?.length === 7, JSON.stringify(expList.json?.total));
check('expense byCategory sums match',
  expList.json?.byCategory?.Marketing === 55000 && expList.json?.byCategory?.Utilities === 23500,
  JSON.stringify(expList.json?.byCategory));
const expCat = await get('/api/expenses?category=Marketing', adminTok);
check('expense category filter returns only Marketing',
  expCat.json?.expenses?.every((e) => e.category === 'Marketing') && expCat.json?.total === 55000,
  `n=${expCat.json?.expenses?.length} total=${expCat.json?.total}`);
const expFrom = await get('/api/expenses?from=2026-11-10&to=2026-11-11', adminTok);
check('expense from/to filter returns only that window',
  expFrom.json?.expenses?.every((e) => e.date >= '2026-11-10' && e.date <= '2026-11-11') && expFrom.json?.total === 15000,
  `n=${expFrom.json?.expenses?.length} total=${expFrom.json?.total}`);
const expGet = await get(`/api/expenses/${exp1Id}`, adminTok);
check('expense get by id 200', expGet.status === 200 && expGet.json?.id === exp1Id, JSON.stringify(expGet.json));
const expPut = await put(`/api/expenses/${exp1Id}`, adminTok, { amount: 12000, description: 'V13 test ads (revised)' });
check('expense PUT 200 (amount 12,000)', expPut.status === 200 && expPut.json?.amount === 12000 && expPut.json?.description === 'V13 test ads (revised)', JSON.stringify(expPut.json));
const expPutBad = await put(`/api/expenses/${exp1Id}`, adminTok, { amount: -5 });
check('expense PUT negative amount → 400', expPutBad.status === 400, `got ${expPutBad.status}`);
const expAudit = await get('/api/audit?action=EXPENSE_CREATE&limit=5', adminTok);
check('expense create audit-logged', JSON.stringify(expAudit.json).includes(exp1Id || 'x'), JSON.stringify(expAudit.json)?.slice(0, 200));
check('manager expense list 200 (read allowed)', (await get('/api/expenses', managerTok)).status === 200);
check('manager expense create 403', (await post('/api/expenses', managerTok, { date: '2026-11-12', category: 'Misc', amount: 100 })).status === 403);
check('manager expense PUT 403', (await put(`/api/expenses/${exp1Id}`, managerTok, { amount: 1 })).status === 403);
check('manager expense DELETE 403', (await del(`/api/expenses/${exp1Id}`, managerTok)).status === 403);
check('agent expense list 403', (await get('/api/expenses', agentTok)).status === 403);
check('agent expense create 403', (await post('/api/expenses', agentTok, { date: '2026-11-12', category: 'Misc', amount: 100 })).status === 403);
const expDel = await del(`/api/expenses/${exp2Id}`, adminTok);
check('expense DELETE 200 (admin)', expDel.status === 200, JSON.stringify(expDel.json));
check('deleted expense 404 on get', (await get(`/api/expenses/${exp2Id}`, adminTok)).status === 404);

console.log('== 12. Rental deal split (half-month total, manual share) ==');
const rentDeal = await post('/api/deals', adminTok, { leadId: testLeadId, propertyId: rentProp.id, commissionPick: 'half', agentShareAmount: 5000, agentId: omarId });
check('rental deal create 201 (value = rent 35,000, bayana 0)',
  rentDeal.status === 201 && rentDeal.json?.dealValue === 35000 && rentDeal.json?.bayanaAmount === 0,
  JSON.stringify(rentDeal.json));
const rentDealId = rentDeal.json?.id;
const rentComm = await dealCommission(rentDealId);
check('rental commission: total = half-month 17,500, share manual 5,000',
  rentComm?.amount === 17500 && rentComm?.agentAmount === 5000 && rentComm?.manual === 1 && rentComm?.status === 'pending',
  JSON.stringify(rentComm));

console.log('== 13. Cleanup test data ==');
for (const dId of [deal1Id, deal2Id, deal3Id, deal5Id, rentDealId]) {
  const c = await post(`/api/deals/${dId}/stage`, adminTok, { stage: 'cancelled' });
  check(`cancel test deal ${String(dId).slice(0, 8)}… 200`, c.status === 200, `got ${c.status}`);
}
const delExp1 = await del(`/api/expenses/${exp1Id}`, adminTok);
check('delete test expense 200', delExp1.status === 200, `got ${delExp1.status}`);
const delBuyLead = await del(`/api/leads/${buyLead.json?.id}`, adminTok);
check('delete test buy lead 200', delBuyLead.status === 200, `got ${delBuyLead.status}`);
const delRentLead = await del(`/api/leads/${rentLead.json?.id}`, adminTok);
check('delete test rent lead 200', delRentLead.status === 200, `got ${delRentLead.status}`);

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if (failures.length) console.log('Failures:', failures.join(' | '));
process.exit(failed ? 1 : 0);
