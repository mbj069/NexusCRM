// NexusCRM v1.2 verification suite — runs against a local server on the
// file DB (http://localhost:4000). Covers every rental item plus the
// commissions-first dashboard and Quick Add code path. Run against a
// freshly seeded database; exits non-zero if any check fails.
//
// Dashboard expectations below are computed live from the commissions
// endpoint (not hardcoded), so the suite stays valid even if the seed
// changes — except the Bilal-vs-Omar inequality, which the seed data
// guarantees (Bilal has two pending sale commissions, Omar one pending
// rental commission).
//
// v1.3 updates: §3 dashboard checks now expect the v1.3 shapes (admin
// owner totals + paidCommission + activeLeads + trend; manager counts +
// trend counts; agent own SHARE figures myTotalShare/myPendingShare/
// myPaidShare computed from agent_amount/agent_status). commissionTotals,
// agentPerformance, myCommissions and myTotalCommission are gone.
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

console.log('== 2. Seed rental data present ==');
const seedRentProps = await get('/api/properties?listing=rent', adminTok);
check('seed has 3 rental properties', Array.isArray(seedRentProps.json) && seedRentProps.json.length === 3, `n=${seedRentProps.json?.length}`);
check('seed rental props have rentPerMonth', seedRentProps.json?.every((p) => p.rentPerMonth > 0 && p.price === 0), JSON.stringify(seedRentProps.json?.map((p) => [p.code, p.rentPerMonth, p.price])));
const seedRentLeads = await get('/api/leads?intent=rent', adminTok);
check('seed has rental lead (Bilal Ahmed)', Array.isArray(seedRentLeads.json) && seedRentLeads.json.some((l) => l.name === 'Bilal Ahmed' && l.intent === 'rent'), `n=${seedRentLeads.json?.length}`);
const seedRentalDeal = (await get('/api/deals', adminTok)).json?.find((d) => d.dealValue === 45000 && d.bayanaAmount === 0);
check('seed rental deal D4 (45,000, bayana 0)', !!seedRentalDeal, JSON.stringify((await get('/api/deals', adminTok)).json?.map((d) => d.dealValue)));
if (seedRentalDeal) {
  const d4 = await get(`/api/deals/${seedRentalDeal.id}`, adminTok);
  check('seed rental deal commission manual=1, 22,500', d4.json?.commissions?.some((c) => c.manual === 1 && c.amount === 22500), JSON.stringify(d4.json?.commissions));
  const d4plans = await get(`/api/plans?dealId=${seedRentalDeal.id}`, adminTok);
  const d4plan = d4plans.json?.[0] ? await get(`/api/plans/${d4plans.json[0].id}`, adminTok) : null;
  const kinds = d4plan?.json?.schedule?.map((s) => s.kind) || [];
  check('seed rental plan stages token,final only', JSON.stringify(kinds) === JSON.stringify(['token', 'final']), JSON.stringify(kinds));
  check('seed rental plan token 20,000 / final 25,000',
    d4plan?.json?.tokenAmount === 20000 && d4plan?.json?.finalAmount === 25000, JSON.stringify(d4plan?.json));
}

console.log('== 3. Dashboard — commissions first (v1.3 shapes, seed state, before test deals) ==');
const adminDash = await get('/api/dashboard', adminTok);
check('admin totalCommission is a number', typeof adminDash.json?.totalCommission === 'number', JSON.stringify(adminDash.json?.totalCommission));
check('admin pendingCommission is a number', typeof adminDash.json?.pendingCommission === 'number', JSON.stringify(adminDash.json?.pendingCommission));
check('admin paidCommission is a number', typeof adminDash.json?.paidCommission === 'number', JSON.stringify(adminDash.json?.paidCommission));
check('admin totalCommission = pending + paid',
  adminDash.json?.totalCommission === adminDash.json?.pendingCommission + adminDash.json?.paidCommission,
  JSON.stringify(adminDash.json));
check('admin seed totals 356,750 = 225,500 pending + 131,250 paid (owner)',
  adminDash.json?.totalCommission === 356750 && adminDash.json?.pendingCommission === 225500 && adminDash.json?.paidCommission === 131250,
  JSON.stringify(adminDash.json));
check('admin activeLeads is 9 (seed non-terminal leads)',
  adminDash.json?.activeLeads === 9, JSON.stringify(adminDash.json?.activeLeads));
for (const f of ['revenue', 'commissionTotals', 'recentActivity', 'agentPerformance', 'followups', 'overdueInstallments', 'overdueCount', 'overdueTotal', 'myCommissions']) {
  check(`admin has NO ${f}`, adminDash.json?.[f] === undefined, JSON.stringify(adminDash.json?.[f]));
}
const thisMonth = new Date().toISOString().slice(0, 7);
const adminTrendNow = adminDash.json?.commissionTrend?.find((m) => m.month === thisMonth);
check('admin trend current month = seed owner totals',
  adminTrendNow?.total === 356750 && adminTrendNow?.pending === 225500 && adminTrendNow?.paid === 131250,
  JSON.stringify(adminTrendNow));
const mgrDash = await get('/api/dashboard', managerTok);
check('manager commissionCounts numbers', typeof mgrDash.json?.commissionCounts?.pending === 'number' && typeof mgrDash.json?.commissionCounts?.paid === 'number', JSON.stringify(mgrDash.json?.commissionCounts));
check('manager seed commissionCounts 3 pending, 1 paid',
  mgrDash.json?.commissionCounts?.pending === 3 && mgrDash.json?.commissionCounts?.paid === 1,
  JSON.stringify(mgrDash.json?.commissionCounts));
for (const f of ['revenue', 'commissionTotals', 'totalCommission', 'pendingCommission', 'paidCommission', 'recentActivity', 'agentPerformance', 'followups', 'overdueInstallments', 'overdueCount', 'overdueTotal', 'myCommissions']) {
  check(`manager has NO ${f}`, mgrDash.json?.[f] === undefined, JSON.stringify(mgrDash.json?.[f]));
}
check('manager activeLeads is 9', mgrDash.json?.activeLeads === 9, JSON.stringify(mgrDash.json?.activeLeads));
const mgrTrendNow = mgrDash.json?.commissionTrend?.find((m) => m.month === thisMonth);
check('manager trend current month counts 3 pending, 1 paid',
  mgrTrendNow?.countPending === 3 && mgrTrendNow?.countPaid === 1, JSON.stringify(mgrTrendNow));
// Agent share totals, computed live from each agent's own commission rows
// (agent_amount by agent_status — the v1.3 share figures, not owner totals).
async function agentExpected(agentTokValue, agentUserId) {
  const rows = await get(`/api/commissions?agentId=${agentUserId}`, adminTok);
  const list = rows.json?.commissions || [];
  const pending = list.filter((c) => c.agentStatus === 'pending').reduce((s, c) => s + (c.agentAmount || 0), 0);
  const paid = list.filter((c) => c.agentStatus === 'paid').reduce((s, c) => s + (c.agentAmount || 0), 0);
  return { pending, paid, total: pending + paid };
}
const bilalDash = await get('/api/dashboard', agentTok);
const bilalExp = await agentExpected(agentTok, agentId);
check('Bilal myTotalShare matches own share rows', bilalDash.json?.myTotalShare === bilalExp.total, `dash=${bilalDash.json?.myTotalShare} rows=${bilalExp.total}`);
check('Bilal myPendingShare matches own share rows', bilalDash.json?.myPendingShare === bilalExp.pending, `dash=${bilalDash.json?.myPendingShare} rows=${bilalExp.pending}`);
check('Bilal myPaidShare matches own share rows', bilalDash.json?.myPaidShare === bilalExp.paid, `dash=${bilalDash.json?.myPaidShare} rows=${bilalExp.paid}`);
check('Bilal seed share 40,000 = 15,000 pending + 25,000 paid',
  bilalDash.json?.myTotalShare === 40000 && bilalDash.json?.myPendingShare === 15000 && bilalDash.json?.myPaidShare === 25000,
  JSON.stringify(bilalDash.json));
for (const f of ['myCommissions', 'myTotalCommission', 'myPendingCommission', 'totalCommission', 'pendingCommission', 'paidCommission', 'commissionTotals', 'revenue', 'summary']) {
  check(`Bilal dashboard has NO ${f}`, bilalDash.json?.[f] === undefined, JSON.stringify(bilalDash.json?.[f]));
}
const omarDash = await get('/api/dashboard', omarTok);
const omarExp = await agentExpected(omarTok, omarId);
check('Omar myTotalShare matches own share rows', omarDash.json?.myTotalShare === omarExp.total, `dash=${omarDash.json?.myTotalShare} rows=${omarExp.total}`);
check('Omar myPendingShare matches own share rows', omarDash.json?.myPendingShare === omarExp.pending, `dash=${omarDash.json?.myPendingShare} rows=${omarExp.pending}`);
check('Omar myPaidShare matches own share rows', omarDash.json?.myPaidShare === omarExp.paid, `dash=${omarDash.json?.myPaidShare} rows=${omarExp.paid}`);
check('Omar seed share 5,000 pending, 0 paid',
  omarDash.json?.myTotalShare === 5000 && omarDash.json?.myPendingShare === 5000 && omarDash.json?.myPaidShare === 0,
  JSON.stringify(omarDash.json));
check('Bilal vs Omar share totals differ', bilalDash.json?.myTotalShare !== omarDash.json?.myTotalShare,
  `bilal=${bilalDash.json?.myTotalShare} omar=${omarDash.json?.myTotalShare}`);

console.log('== 4. Rent listing create + validation ==');
const noRent = await post('/api/properties', adminTok, { code: 'TST-RNT-000', type: 'house', title: 'No rent', location: 'Test', areaValue: 5, areaUnit: 'marla', listingType: 'rent' });
check('rent listing without rent_per_month 400', noRent.status === 400, `got ${noRent.status}`);
const zeroRent = await post('/api/properties', adminTok, { code: 'TST-RNT-000', type: 'house', title: 'Zero rent', location: 'Test', areaValue: 5, areaUnit: 'marla', listingType: 'rent', rentPerMonth: 0 });
check('rent listing rent 0 → 400', zeroRent.status === 400, `got ${zeroRent.status}`);
const negRent = await post('/api/properties', adminTok, { code: 'TST-RNT-000', type: 'house', title: 'Neg rent', location: 'Test', areaValue: 5, areaUnit: 'marla', listingType: 'rent', rentPerMonth: -100 });
check('rent listing negative rent → 400', negRent.status === 400, `got ${negRent.status}`);
const rentProp = await post('/api/properties', adminTok, { code: 'TST-RNT-001', type: 'house', title: 'Test House on Rent', location: 'Satellite Town', areaValue: 5, areaUnit: 'marla', listingType: 'rent', rentPerMonth: 40000 });
check('rent listing created (Available, rent 40,000, price 0)',
  rentProp.status === 201 && rentProp.json?.listingType === 'rent' && rentProp.json?.rentPerMonth === 40000 && rentProp.json?.price === 0 && rentProp.json?.status === 'Available',
  JSON.stringify(rentProp.json));
const rentPropId = rentProp.json?.id;
const saleProp = await post('/api/properties', adminTok, { code: 'TST-SALE-001', type: 'house', title: 'Test Sale House', location: 'Model City', areaValue: 5, areaUnit: 'marla', price: 9000000, listingType: 'sale' });
check('sale listing still works (rentPerMonth null)',
  saleProp.status === 201 && saleProp.json?.listingType === 'sale' && saleProp.json?.price === 9000000 && (saleProp.json?.rentPerMonth === null || saleProp.json?.rentPerMonth === undefined),
  JSON.stringify(saleProp.json));
const salePropId = saleProp.json?.id;
const auditRent = await get('/api/audit?action=PROPERTY_CREATE&limit=10', adminTok);
check('audit says "for rent" for rental create', JSON.stringify(auditRent.json).includes('for rent'), JSON.stringify(auditRent.json)?.slice(0, 300));

console.log('== 5. Listing filter (list + search, composes) ==');
const rentList = await get('/api/properties?listing=rent', adminTok);
check('listing=rent returns only rent', Array.isArray(rentList.json) && rentList.json.length > 0 && rentList.json.every((p) => p.listingType === 'rent'), `n=${rentList.json?.length}`);
const saleList = await get('/api/properties?listing=sale', adminTok);
check('listing=sale returns only sale', Array.isArray(saleList.json) && saleList.json.length > 0 && saleList.json.every((p) => p.listingType === 'sale'), `n=${saleList.json?.length}`);
const rentHouse = await get('/api/properties?listing=rent&type=house', adminTok);
check('listing=rent composes with type=house', rentHouse.json?.every((p) => p.listingType === 'rent' && p.type === 'house') && rentHouse.json.length > 0, `n=${rentHouse.json?.length}`);
const badListing = await get('/api/properties?listing=lease', adminTok);
check('invalid listing 400', badListing.status === 400, `got ${badListing.status}`);
const searchRent = await get('/api/properties/search?listing=rent&status=Available&minPrice=30000&maxPrice=50000', adminTok);
check('search rent by monthly budget 30k–50k (effective price)',
  Array.isArray(searchRent.json) && searchRent.json.length > 0 &&
  searchRent.json.every((p) => p.listingType === 'rent' && p.rentPerMonth >= 30000 && p.rentPerMonth <= 50000),
  JSON.stringify(searchRent.json?.map((p) => [p.code, p.rentPerMonth])));
const searchRentNarrow = await get('/api/properties/search?listing=rent&status=Available&maxPrice=36000', adminTok);
check('search rent maxPrice 36k excludes 40k/45k/60k rents',
  searchRentNarrow.json?.every((p) => p.rentPerMonth <= 36000) && searchRentNarrow.json?.some((p) => p.rentPerMonth === 35000),
  JSON.stringify(searchRentNarrow.json?.map((p) => [p.code, p.rentPerMonth])));
const searchBadListing = await get('/api/properties/search?listing=lease', adminTok);
check('search invalid listing 400', searchBadListing.status === 400, `got ${searchBadListing.status}`);

console.log('== 6. Rent listing edit (PUT) ==');
const putNoRent = await put(`/api/properties/${salePropId}`, adminTok, { listingType: 'rent' });
check('PUT sale→rent without rent_per_month 400', putNoRent.status === 400, `got ${putNoRent.status}`);
const putToRent = await put(`/api/properties/${salePropId}`, adminTok, { listingType: 'rent', rentPerMonth: 55000 });
check('PUT sale→rent with rent works (price 0)',
  putToRent.status === 200 && putToRent.json?.listingType === 'rent' && putToRent.json?.rentPerMonth === 55000 && putToRent.json?.price === 0,
  JSON.stringify(putToRent.json));
const putToSale = await put(`/api/properties/${salePropId}`, adminTok, { listingType: 'sale', price: 9000000 });
check('PUT rent→sale clears rent_per_month to NULL',
  putToSale.status === 200 && putToSale.json?.listingType === 'sale' && putToSale.json?.rentPerMonth === null && putToSale.json?.price === 9000000,
  JSON.stringify(putToSale.json));

console.log('== 7. Lead intent rent ==');
const rentContact = await post('/api/contacts', adminTok, { name: 'Verify Renter', phone: '+923000000101', whatsapp: '+923000000101', type: 'buyer' });
const rentContactId = rentContact.json?.id;
const rentLead = await post('/api/leads', adminTok, {
  contactId: rentContactId, name: 'Verify Renter', phone: '+923000000101', source: 'website',
  interest: '5 marla house on rent', intent: 'rent', society: 'Satellite Town',
  budgetMin: 30000, budgetMax: 50000, assignedTo: omarId,
});
check('rent lead create 201', rentLead.status === 201 && rentLead.json?.intent === 'rent', JSON.stringify(rentLead.json));
const rentLeadId = rentLead.json?.id;
const rentFilter = await get('/api/leads?intent=rent', adminTok);
check('intent=rent returns only rent', Array.isArray(rentFilter.json) && rentFilter.json.length > 0 && rentFilter.json.every((l) => l.intent === 'rent'), `n=${rentFilter.json?.length}`);
const badLeadIntent = await post('/api/leads', adminTok, { name: 'Bad', intent: 'lease' });
check('invalid intent lease 400', badLeadIntent.status === 400, `got ${badLeadIntent.status}`);
const extraLead = await post('/api/leads', adminTok, { name: 'Deletable Rent Lead', phone: '+923000000102', intent: 'rent', society: 'Model City' });
const extraLeadId = extraLead.json?.id;

console.log('== 8. Rental deals (value = rent, manual commission) ==');
const halfDeal = await post('/api/deals', adminTok, {
  leadId: rentLeadId, propertyId: rentPropId, dealValue: 999999,
  commissionPick: 'half', agentId: omarId,
});
check('rental deal create 201 (dealValue ignored → 40,000, bayana 0, fixed 20,000)',
  halfDeal.status === 201 && halfDeal.json?.dealValue === 40000 && halfDeal.json?.bayanaAmount === 0 &&
  halfDeal.json?.commissionType === 'fixed' && halfDeal.json?.commissionValue === 20000,
  JSON.stringify(halfDeal.json));
const halfDealId = halfDeal.json?.id;
const halfDetail = await get(`/api/deals/${halfDealId}`, adminTok);
check('rental commission row manual=1, 20,000, pending',
  halfDetail.json?.commissions?.some((c) => c.manual === 1 && c.amount === 20000 && c.status === 'pending'),
  JSON.stringify(halfDetail.json?.commissions));
const commAudit = await get('/api/audit?action=COMMISSION_MANUAL&limit=10', adminTok);
check('rental commission audit-logged COMMISSION_MANUAL', JSON.stringify(commAudit.json).includes(halfDealId || 'x'), JSON.stringify(commAudit.json)?.slice(0, 300));
const dblRent = await post('/api/deals', adminTok, { leadId: rentLeadId, propertyId: rentPropId, dealValue: 40000, commissionPick: 'half', agentId: omarId });
check('double-booking 409 on rental property', dblRent.status === 409, `got ${dblRent.status}`);
// Full-month pick on a second rental property.
const rentProp2 = await post('/api/properties', adminTok, { code: 'TST-RNT-002', type: 'shop', title: 'Test Shop on Rent', location: 'Kachehri Road', areaValue: 250, areaUnit: 'sqft', listingType: 'rent', rentPerMonth: 60000 });
const rentProp2Id = rentProp2.json?.id;
const fullDeal = await post('/api/deals', adminTok, { leadId: rentLeadId, propertyId: rentProp2Id, commissionPick: 'full', agentId: omarId });
check('full-month pick → commission = full rent (60,000)',
  fullDeal.status === 201 && fullDeal.json?.dealValue === 60000 && fullDeal.json?.commissionValue === 60000,
  JSON.stringify(fullDeal.json));
const fullDealId = fullDeal.json?.id;
// Free manual amount on a third rental property.
const rentProp3 = await post('/api/properties', adminTok, { code: 'TST-RNT-003', type: 'house', title: 'Test House on Rent 3', location: 'Model City', areaValue: 3, areaUnit: 'marla', listingType: 'rent', rentPerMonth: 35000 });
const rentProp3Id = rentProp3.json?.id;
const manualDeal = await post('/api/deals', adminTok, { leadId: rentLeadId, propertyId: rentProp3Id, commissionAmount: 15000, agentId: omarId });
check('free manual commission amount 15,000 stored',
  manualDeal.status === 201 && manualDeal.json?.dealValue === 35000 && manualDeal.json?.commissionValue === 15000,
  JSON.stringify(manualDeal.json));
const manualDealId = manualDeal.json?.id;
// Neither pick nor amount → 400 (fresh property so availability is not the blocker).
const rentProp4 = await post('/api/properties', adminTok, { code: 'TST-RNT-004', type: 'house', title: 'Test House on Rent 4', location: 'Gulberg City', areaValue: 5, areaUnit: 'marla', listingType: 'rent', rentPerMonth: 50000 });
const rentProp4Id = rentProp4.json?.id;
const noComm = await post('/api/deals', adminTok, { leadId: rentLeadId, propertyId: rentProp4Id, agentId: omarId });
check('rental deal without pick or amount → 400', noComm.status === 400, `got ${noComm.status}: ${JSON.stringify(noComm.json)}`);
const badPick = await post('/api/deals', adminTok, { leadId: rentLeadId, propertyId: rentProp4Id, commissionPick: 'quarter', agentId: omarId });
check('bad commissionPick → 400', badPick.status === 400, `got ${badPick.status}`);
const putRentValue = await put(`/api/deals/${halfDealId}`, adminTok, { dealValue: 50000 });
check('PUT dealValue on rental deal → 400', putRentValue.status === 400, `got ${putRentValue.status}`);

console.log('== 9. Agent scoping on rental lead/deal ==');
check('Bilal 403 on Omar rental lead', (await get(`/api/leads/${rentLeadId}`, agentTok)).status === 403);
check('Bilal 403 on Omar rental deal', (await get(`/api/deals/${halfDealId}`, agentTok)).status === 403);
check('Omar 200 on own rental lead', (await get(`/api/leads/${rentLeadId}`, omarTok)).status === 200);
check('Omar 200 on own rental deal', (await get(`/api/deals/${halfDealId}`, omarTok)).status === 200);

console.log('== 10. Rental payment plans (token → final) ==');
const bayanaPlan = await post('/api/plans', adminTok, { dealId: halfDealId, contactId: rentContactId, tokenAmount: 10000, bayanaAmount: 5000, startDate: '2026-11-05' });
check('rental plan with bayana → 400', bayanaPlan.status === 400, `got ${bayanaPlan.status}`);
const instPlan = await post('/api/plans', adminTok, { dealId: halfDealId, contactId: rentContactId, tokenAmount: 10000, numInstallments: 2, installmentAmount: 5000, startDate: '2026-11-05' });
check('rental plan with installments → 400', instPlan.status === 400, `got ${instPlan.status}`);
const rentPlan = await post('/api/plans', adminTok, { dealId: halfDealId, contactId: rentContactId, tokenAmount: 10000, startDate: '2026-11-05' });
let rentPlanId = null;
if (rentPlan.status === 201) {
  rentPlanId = rentPlan.json?.id;
  const kinds = rentPlan.json?.schedule?.map((s) => s.kind) || [];
  check('rental plan stages exactly token,final', JSON.stringify(kinds) === JSON.stringify(['token', 'final']), JSON.stringify(kinds));
  check('rental plan token 10,000 / final 30,000 (= rent − advance)',
    rentPlan.json?.tokenAmount === 10000 && rentPlan.json?.finalAmount === 30000 && rentPlan.json?.bayanaAmount === 0 && rentPlan.json?.numInstallments === 0,
    JSON.stringify(rentPlan.json));
} else {
  check('rental plan create 201', false, `got ${rentPlan.status}: ${JSON.stringify(rentPlan.json)}`);
}
// Zero-advance plan: only a final row.
const zeroPlan = await post('/api/plans', adminTok, { dealId: fullDealId, contactId: rentContactId, tokenAmount: 0, startDate: '2026-11-05' });
if (zeroPlan.status === 201) {
  const kinds = zeroPlan.json?.schedule?.map((s) => s.kind) || [];
  check('zero-advance rental plan has only a final row', JSON.stringify(kinds) === JSON.stringify(['final']), JSON.stringify(kinds));
  check('zero-advance final = full rent 60,000', zeroPlan.json?.schedule?.[0]?.amount === 60000);
} else {
  check('zero-advance rental plan 201', false, `got ${zeroPlan.status}: ${JSON.stringify(zeroPlan.json)}`);
}

console.log('== 11. Rental receipt + ledger ==');
if (rentPlanId) {
  const planDetail = await get(`/api/plans/${rentPlanId}`, adminTok);
  const tokenRow = planDetail.json?.schedule?.find((s) => s.kind === 'token');
  const finalRow = planDetail.json?.schedule?.find((s) => s.kind === 'final');
  const payToken = await post('/api/payments', adminTok, { scheduleId: tokenRow?.id, amount: 10000, method: 'cash' });
  check('rental token payment 201 + receipt no', payToken.status === 201 && /^RCP-2026-\d{4}$/.test(payToken.json?.receiptNo || ''), JSON.stringify(payToken.json));
  if (payToken.status === 201) {
    const receipt = await get(`/api/receipts/${payToken.json?.id}`, adminTok);
    check('rental receipt shows Token money', receipt.status === 200 && receipt.json?.lineItems?.[0]?.label === 'Token money', JSON.stringify(receipt.json?.lineItems));
    const receiptHtml = await get(`/api/receipts/${payToken.json?.id}/html`, adminTok);
    check('rental receipt HTML contains Token money', receiptHtml.status === 200 && receiptHtml.text.includes('Token money'));
  }
  const payFinal = await post('/api/payments', adminTok, { scheduleId: finalRow?.id, amount: 30000, method: 'bank' });
  check('rental final payment 201', payFinal.status === 201, JSON.stringify(payFinal.json));
  if (payFinal.status === 201) {
    const receipt2 = await get(`/api/receipts/${payFinal.json?.id}`, adminTok);
    check('rental receipt shows Final payment', receipt2.status === 200 && receipt2.json?.lineItems?.[0]?.label === 'Final payment', JSON.stringify(receipt2.json?.lineItems));
  }
  const ledger = await get(`/api/ledgers/${rentContactId}`, adminTok);
  const ledgerPlan = ledger.json?.plans?.find((p) => p.id === rentPlanId);
  check('ledger shows rental plan two stages token,final',
    ledger.status === 200 && JSON.stringify((ledgerPlan?.schedule || []).map((s) => s.kind)) === JSON.stringify(['token', 'final']),
    JSON.stringify(ledgerPlan?.schedule?.map((s) => s.kind)));
} else {
  check('rental plan exists for receipt tests', false);
}

console.log('== 12. Sale deal + plan still four stages ==');
const saleDeal = await post('/api/deals', adminTok, {
  leadId: rentLeadId, propertyId: salePropId, dealValue: 2800000, bayanaAmount: 150000,
  commissionType: 'percent', commissionValue: 2, agentId,
});
check('sale deal create 201', saleDeal.status === 201, JSON.stringify(saleDeal.json));
const saleDealId = saleDeal.json?.id;
if (saleDealId) {
  const salePlan = await post('/api/plans', adminTok, {
    dealId: saleDealId, contactId: rentContactId, tokenAmount: 100000, bayanaAmount: 150000,
    numInstallments: 2, installmentAmount: 500000, startDate: '2026-11-08',
  });
  const kinds = salePlan.json?.schedule?.map((s) => s.kind) || [];
  check('sale plan stages token,bayana,inst x2,final', JSON.stringify(kinds) === JSON.stringify(['token', 'bayana', 'installment', 'installment', 'final']), JSON.stringify(kinds));
  await post(`/api/deals/${saleDealId}/stage`, adminTok, { stage: 'cancelled' });
}

console.log('== 13. Close rental deal → Rented (terminal); cancel → Available ==');
const closeRent = await post(`/api/deals/${halfDealId}/stage`, adminTok, { stage: 'closed_won' });
check('rental deal close 200', closeRent.status === 200 && closeRent.json?.stage === 'closed_won');
const propRented = await get(`/api/properties/${rentPropId}`, adminTok);
check('property now Rented (not Sold)', propRented.json?.status === 'Rented', JSON.stringify(propRented.json?.status));
const rentedStatusChange = await post(`/api/properties/${rentPropId}/status`, adminTok, { status: 'Available' });
check('Rented is terminal (status change 400)', rentedStatusChange.status === 400, `got ${rentedStatusChange.status}`);
const cancelManual = await post(`/api/deals/${manualDealId}/stage`, adminTok, { stage: 'cancelled' });
check('cancel test rental deal 200', cancelManual.status === 200 && cancelManual.json?.stage === 'cancelled');
const propReleased = await get(`/api/properties/${rentProp3Id}`, adminTok);
check('cancelled rental deal releases property to Available', propReleased.json?.status === 'Available', JSON.stringify(propReleased.json?.status));

console.log('== 14. Cleanup test data ==');
const cancelFull = await post(`/api/deals/${fullDealId}/stage`, adminTok, { stage: 'cancelled' });
check('cancel full-month test deal 200', cancelFull.status === 200, `got ${cancelFull.status}: ${JSON.stringify(cancelFull.json)}`);
const delExtraLead = await del(`/api/leads/${extraLeadId}`, adminTok);
check('delete deal-free test rent lead 200', delExtraLead.status === 200, `got ${delExtraLead.status}`);
const delRentProp4 = await del(`/api/properties/${rentProp4Id}`, adminTok);
check('delete deal-free test rent property 200', delRentProp4.status === 200, `got ${delRentProp4.status}`);
const delRentProp3 = await del(`/api/properties/${rentProp3Id}`, adminTok);
check('delete cancelled-deal property blocked (409, has deal)', delRentProp3.status === 409, `got ${delRentProp3.status}`);

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if (failures.length) console.log('Failures:', failures.join(' | '));
process.exit(failed ? 1 : 0);
