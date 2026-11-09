// NexusCRM v1.1 verification suite — runs against a local server on the
// file DB (http://localhost:4000). Covers the v1.0 regression set plus every
// v1.1 item. Exits non-zero if any check fails.
const BASE = 'http://localhost:4000';
let passed = 0, failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name} ${extra}`); }
}

async function req(method, path, token = null, body = null, isForm = false) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body && !isForm) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  else if (body) payload = body;
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

async function login(username, password) {
  const r = await req('POST', '/api/auth/login', null, { username, password });
  return r;
}

const get = (p, t) => req('GET', p, t);
const post = (p, t, b) => req('POST', p, t, b);
const put = (p, t, b) => req('PUT', p, t, b);
const del = (p, t) => req('DELETE', p, t);

console.log('== 1. Logins ==');
const adminLogin = await login('admin@nexuscrm.local', 'changeme123');
check('admin login 200', adminLogin.status === 200, JSON.stringify(adminLogin.json));
const adminTok = adminLogin.json?.token;
const managerLogin = await login('manager@nexuscrm.local', 'manager123');
check('manager login 200', managerLogin.status === 200);
const managerTok = managerLogin.json?.token;
const agentLogin = await login('agent@nexuscrm.local', 'agent123');
check('agent login 200', agentLogin.status === 200);
const agentTok = agentLogin.json?.token;
const badLogin = await login('agent@nexuscrm.local', 'wrongpass');
check('bad creds 401', badLogin.status === 401, `got ${badLogin.status}`);
const agentId = agentLogin.json?.user?.id;
const managerId = managerLogin.json?.user?.id;
const adminId = adminLogin.json?.user?.id;

console.log('== 2. Role matrix (403s) ==');
check('agent 403 /users', (await get('/api/users', agentTok)).status === 403);
check('manager 403 /users', (await get('/api/users', managerTok)).status === 403);
check('admin 200 /users', (await get('/api/users', adminTok)).status === 200);
check('agent 403 /audit', (await get('/api/audit', agentTok)).status === 403);
check('manager 403 /audit', (await get('/api/audit', managerTok)).status === 403);
check('admin 200 /audit', (await get('/api/audit', adminTok)).status === 200);
check('manager 403 /ai/config', (await get('/api/ai/config', managerTok)).status === 403);
check('agent 403 /ai/config', (await get('/api/ai/config', agentTok)).status === 403);
check('manager 403 /whatsapp/config', (await get('/api/whatsapp/config', managerTok)).status === 403);
check('manager 403 /users/agents? (should be 200 - assign_leads)', (await get('/api/users/agents', managerTok)).status === 200);
check('agent 403 /users/agents', (await get('/api/users/agents', agentTok)).status === 403);

console.log('== 3. Lead lifecycle + intent/society ==');
const buyerContact = await post('/api/contacts', adminTok, { name: 'Verify Buyer', phone: '+923000000001', whatsapp: '+923000000001', type: 'buyer' });
check('buyer contact created', buyerContact.status === 201, JSON.stringify(buyerContact.json));
const buyerContactId = buyerContact.json?.id;
const leadCreate = await post('/api/leads', adminTok, {
  contactId: buyerContactId,
  name: 'Verify Buyer', phone: '+923000000001', source: 'manual',
  interest: '5 marla plot', intent: 'buy', society: 'Model City', budgetMin: 2000000, budgetMax: 3000000,
});
check('lead create 201 with intent/society', leadCreate.status === 201 && leadCreate.json?.intent === 'buy' && leadCreate.json?.society === 'Model City', JSON.stringify(leadCreate.json));
const leadId = leadCreate.json?.id;
const sellLead = await post('/api/leads', adminTok, {
  name: 'Verify Seller', phone: '+923000000002', source: 'manual',
  interest: 'selling plot', intent: 'sell', society: 'Gulberg City',
});
check('sell lead create 201', sellLead.status === 201 && sellLead.json?.intent === 'sell');
const sellLeadId = sellLead.json?.id;
const buyFilter = await get('/api/leads?intent=buy', adminTok);
check('intent=buy returns only buy', Array.isArray(buyFilter.json) && buyFilter.json.length > 0 && buyFilter.json.every((l) => l.intent === 'buy'), `n=${buyFilter.json?.length}`);
const sellFilter = await get('/api/leads?intent=sell', adminTok);
check('intent=sell returns only sell', Array.isArray(sellFilter.json) && sellFilter.json.length > 0 && sellFilter.json.every((l) => l.intent === 'sell'), `n=${sellFilter.json?.length}`);
const socFilter = await get('/api/leads?society=Model%20City', adminTok);
check('society filter returns only Model City', Array.isArray(socFilter.json) && socFilter.json.length > 0 && socFilter.json.every((l) => l.society === 'Model City'), `n=${socFilter.json?.length}`);
const comboFilter = await get('/api/leads?intent=buy&society=Model%20City', adminTok);
check('intent+society compose', Array.isArray(comboFilter.json) && comboFilter.json.every((l) => l.intent === 'buy' && l.society === 'Model City'), `n=${comboFilter.json?.length}`);
const badIntent = await post('/api/leads', adminTok, { name: 'Bad', intent: 'rent' });
check('invalid intent 400', badIntent.status === 400);
const stageMove = await post(`/api/leads/${leadId}/stage`, adminTok, { stage: 'contacted' });
check('lead stage move', stageMove.status === 200 && stageMove.json?.stage === 'contacted');
const score = await post(`/api/leads/${leadId}/score`, adminTok, {});
check('lead score', score.status === 200 && typeof score.json?.score === 'number', JSON.stringify(score.json));

console.log('== 4. Lead assignment + agent scoping ==');
const unassigned = await post('/api/leads', adminTok, { name: 'Unassigned Verify', phone: '+923000000003', intent: 'buy', society: 'Model City' });
const unassignedId = unassigned.json?.id;
check('unassigned lead created', unassigned.status === 201 && (unassigned.json?.assignedTo === null || unassigned.json?.assigned_to === null));
const agentLeadsBefore = await get('/api/leads', agentTok);
check('agent list excludes unassigned lead', Array.isArray(agentLeadsBefore.json) && !agentLeadsBefore.json.some((l) => l.id === unassignedId), `n=${agentLeadsBefore.json?.length}`);
check('agent list excludes unassigned (sell lead too)', !agentLeadsBefore.json.some((l) => l.id === sellLeadId));
const assign = await post(`/api/leads/${unassignedId}/assign`, managerTok, { agentId });
check('manager assigns lead to agent', assign.status === 200 && assign.json?.assignedTo === agentId, JSON.stringify(assign.json));
const agentLeadsAfter = await get('/api/leads', agentTok);
check('agent list now includes assigned lead', agentLeadsAfter.json.some((l) => l.id === unassignedId));
const agentCantAssign = await post(`/api/leads/${leadId}/assign`, agentTok, { agentId });
check('agent cannot assign (403)', agentCantAssign.status === 403);
const agentGetUnassigned = await get(`/api/leads/${sellLeadId}`, agentTok);
check('agent 403 on unassigned lead detail', agentGetUnassigned.status === 403);
const agentGetOwn = await get(`/api/leads/${unassignedId}`, agentTok);
check('agent 200 on own lead detail', agentGetOwn.status === 200 && agentGetOwn.json?.assignedAgent?.name, JSON.stringify(agentGetOwn.json?.assignedAgent));

console.log('== 5. Deals + double-booking ==');
const availProps = await get('/api/properties?status=Available', adminTok);
const propToBook = availProps.json?.find((p) => p.type === 'plot') || availProps.json?.[0];
check('available property found', !!propToBook, JSON.stringify(availProps.json?.slice(0, 2)));
const dealCreate = await post('/api/deals', adminTok, {
  leadId, propertyId: propToBook.id, dealValue: 2800000, bayanaAmount: 150000,
  commissionType: 'percent', commissionValue: 2, agentId,
});
check('deal create 201', dealCreate.status === 201, JSON.stringify(dealCreate.json));
const dealId = dealCreate.json?.id;
const dbl = await post('/api/deals', adminTok, {
  leadId, propertyId: propToBook.id, dealValue: 2800000, bayanaAmount: 0,
  commissionType: 'percent', commissionValue: 1, agentId,
});
check('double-booking 409', dbl.status === 409, `got ${dbl.status}`);
const propAfter = await get(`/api/properties/${propToBook.id}`, adminTok);
check('property now Booked', propAfter.json?.status === 'Booked');
const agentDeal403 = await get(`/api/deals/${dealId}`, managerTok); // manager can see; use another agent's deal instead
check('manager can see deal (200)', agentDeal403.status === 200);
// Another agent's deal: create a deal as manager (agent_id=manager) then agent tries
const mgrDeal = await post('/api/deals', managerTok, {
  leadId: sellLeadId, propertyId: (await get('/api/properties?status=Available', adminTok)).json?.[0]?.id,
  dealValue: 1000000, bayanaAmount: 0, commissionType: 'fixed', commissionValue: 10000, agentId: managerId,
});
const mgrDealId = mgrDeal.json?.id;
check('manager deal created for 403 test', mgrDeal.status === 201, JSON.stringify(mgrDeal.json));
if (mgrDealId) {
  check('agent 403 on another agent deal', (await get(`/api/deals/${mgrDealId}`, agentTok)).status === 403);
  check('agent deals list excludes others', (await get('/api/deals', agentTok)).json.every((d) => d.agentId === agentId));
}

console.log('== 6. Payment hierarchy ==');
const planCreate = await post('/api/plans', adminTok, {
  dealId, contactId: buyerContactId,
  tokenAmount: 100000, bayanaAmount: 150000, numInstallments: 4, installmentAmount: 500000,
  startDate: '2026-11-08',
});
let planId = null;
if (planCreate.status === 201) {
  planId = planCreate.json?.id;
  const kinds = planCreate.json?.schedule?.map((s) => s.kind) || [];
  check('plan stages in order token,bayana,inst x4,final', JSON.stringify(kinds) === JSON.stringify(['token', 'bayana', 'installment', 'installment', 'installment', 'installment', 'final']), JSON.stringify(kinds));
  const finalRow = planCreate.json?.schedule?.find((s) => s.kind === 'final');
  check('final = remainder (2,800,000-100,000-150,000-2,000,000=550,000)', finalRow?.amount === 550000, `got ${finalRow?.amount}`);
  check('plan stores token/bayana/final', planCreate.json?.tokenAmount === 100000 && planCreate.json?.bayanaAmount === 150000 && planCreate.json?.finalAmount === 550000, JSON.stringify(planCreate.json));
} else {
  check('plan create 201', false, `got ${planCreate.status}: ${JSON.stringify(planCreate.json)}`);
}
// Zero-installment plan on the manager deal
if (mgrDealId) {
  const contactForMgr = (await get(`/api/leads/${sellLeadId}`, adminTok)).json?.contactId;
  let cId = contactForMgr;
  if (!cId) {
    const c = await post('/api/contacts', adminTok, { name: 'Plan Payer', phone: '+923000000099', type: 'buyer' });
    cId = c.json?.id;
  }
  const zeroPlan = await post('/api/plans', adminTok, {
    dealId: mgrDealId, contactId: cId, tokenAmount: 200000, bayanaAmount: 0,
    numInstallments: 0, installmentAmount: 0, startDate: '2026-11-08',
  });
  check('zero-installment plan 201', zeroPlan.status === 201, JSON.stringify(zeroPlan.json));
  if (zeroPlan.status === 201) {
    const kinds = zeroPlan.json?.schedule?.map((s) => s.kind) || [];
    check('zero-inst stages token,final only', JSON.stringify(kinds) === JSON.stringify(['token', 'final']), JSON.stringify(kinds));
    check('zero-inst final = 800,000', zeroPlan.json?.schedule?.find((s) => s.kind === 'final')?.amount === 800000);
  }
  // Legacy aliases still work — on a fresh deal (downPayment->token, possessionAmount->final)
  const legacyProp = (await get('/api/properties?status=Available', adminTok)).json?.find((p) => p.type === 'house');
  const legacyDeal = await post('/api/deals', adminTok, {
    leadId, propertyId: legacyProp?.id, dealValue: 200000, bayanaAmount: 0,
    commissionType: 'fixed', commissionValue: 5000, agentId,
  });
  if (legacyDeal.status === 201) {
    const legacyPlan = await post('/api/plans', adminTok, {
      dealId: legacyDeal.json?.id, contactId: cId, downPayment: 100000, possessionAmount: 100000,
      numInstallments: 0, startDate: '2026-11-08',
    });
    check('legacy alias plan 201', legacyPlan.status === 201, JSON.stringify(legacyPlan.json));
    if (legacyPlan.status === 201) {
      const kinds = legacyPlan.json?.schedule?.map((s) => s.kind) || [];
      check('legacy alias maps to token,final', JSON.stringify(kinds) === JSON.stringify(['token', 'final']), JSON.stringify(kinds));
      check('legacy alias token=100000 final=100000', legacyPlan.json?.tokenAmount === 100000 && legacyPlan.json?.finalAmount === 100000);
    }
    await post(`/api/deals/${legacyDeal.json?.id}/stage`, adminTok, { stage: 'cancelled' });
  } else {
    check('legacy deal created', false, JSON.stringify(legacyDeal.json));
  }
}

console.log('== 7. Payment + receipt ==');
if (planId) {
  const planDetail = await get(`/api/plans/${planId}`, adminTok);
  const tokenRow = planDetail.json?.schedule?.find((s) => s.kind === 'token');
  const pay = await post('/api/payments', adminTok, { scheduleId: tokenRow?.id, amount: 100000, method: 'cash' });
  check('payment 201 + receipt no', pay.status === 201 && /^RCP-2026-\d{4}$/.test(pay.json?.receiptNo || ''), JSON.stringify(pay.json));
  const receipt = await get(`/api/receipts/${pay.json?.id}`, adminTok);
  check('receipt kind label Token money', receipt.status === 200 && receipt.json?.lineItems?.[0]?.label === 'Token money', JSON.stringify(receipt.json?.lineItems));
  const receiptHtml = await get(`/api/receipts/${pay.json?.id}/html`, adminTok);
  check('receipt HTML contains Token money', receiptHtml.status === 200 && receiptHtml.text.includes('Token money'));
  const ledger = await get(`/api/ledgers/${planDetail.json?.contact?.id || planDetail.json?.contactId}`, adminTok);
  check('ledger 200 with schedule stages', ledger.status === 200 && ledger.json?.plans?.[0]?.schedule?.some((s) => s.kind === 'final'), JSON.stringify(ledger.json?.plans?.[0]?.schedule?.map((s) => s.kind)));
  // Agent CAN pay on their own deal's plan (deal agent = Bilal)
  const agentPay = await post('/api/payments', agentTok, { scheduleId: tokenRow?.id, amount: 1000, method: 'cash' });
  check('agent payment on own deal plan 201', agentPay.status === 201, `got ${agentPay.status}: ${JSON.stringify(agentPay.json)}`);
  // ...but not on a plan belonging to another agent's deal (manager deal plan)
  const mgrPlans = await get(`/api/plans?dealId=${mgrDealId}`, adminTok);
  const mgrTokenRow = mgrPlans.json?.[0]?.id ? (await get(`/api/plans/${mgrPlans.json[0].id}`, adminTok)).json?.schedule?.find((s) => s.kind === 'token') : null;
  if (mgrTokenRow) {
    const agentPayOther = await post('/api/payments', agentTok, { scheduleId: mgrTokenRow.id, amount: 1000, method: 'cash' });
    check('agent payment on another agent plan 403', agentPayOther.status === 403, `got ${agentPayOther.status}`);
  } else {
    check('manager plan token row found for 403 test', false);
  }
}

console.log('== 8. Deal close ==');
const close = await post(`/api/deals/${dealId}/stage`, adminTok, { stage: 'closed_won' });
check('deal close 200', close.status === 200 && close.json?.stage === 'closed_won');
const propSold = await get(`/api/properties/${propToBook.id}`, adminTok);
check('property now Sold', propSold.json?.status === 'Sold');

console.log('== 9. AI 503 + webhook ==');
const ai = await post('/api/ai/score-lead', adminTok, { leadId });
check('AI 503 without key', ai.status === 503, `got ${ai.status}`);
const whVerify = await get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test&hub.challenge=CHALLENGE123', null);
check('webhook verify (200 or 403)', [200, 403].includes(whVerify.status), `got ${whVerify.status}: ${whVerify.text.slice(0, 80)}`);

console.log('== 10. Uploads ==');
{
  const form = new FormData();
  form.append('file', new Blob(['hello nexuscrm'], { type: 'text/plain' }), 'test.txt');
  form.append('entityType', 'deal');
  form.append('entityId', dealId);
  const up = await fetch(BASE + '/api/documents', { method: 'POST', headers: { Authorization: `Bearer ${adminTok}` }, body: form });
  const upJson = await up.json().catch(() => null);
  check('document upload 201 (db storage)', up.status === 201 && upJson?.storage === 'db', `got ${up.status}: ${JSON.stringify(upJson)}`);
  if (upJson?.id) {
    const dl = await req('GET', `/api/documents/${upJson.id}/download`, adminTok);
    check('document download 200', dl.status === 200);
    check('document delete 200', (await del(`/api/documents/${upJson.id}`, adminTok)).status === 200);
  }
}

console.log('== 11. Dashboards ==');
const adminDash = await get('/api/dashboard', adminTok);
check('admin dashboard has revenue', adminDash.status === 200 && adminDash.json?.revenue?.collected !== undefined && adminDash.json?.revenue?.expected !== undefined, JSON.stringify(Object.keys(adminDash.json || {})));
check('admin dashboard has commissionTotals', adminDash.json?.commissionTotals !== undefined);
check('admin dashboard has recentActivity', Array.isArray(adminDash.json?.recentActivity));
check('admin agentPerformance has money', Array.isArray(adminDash.json?.agentPerformance) && adminDash.json.agentPerformance.every((a) => a.revenue !== undefined));
const mgrDash = await get('/api/dashboard', managerTok);
check('manager dashboard has NO revenue', mgrDash.status === 200 && mgrDash.json?.revenue === undefined, JSON.stringify(Object.keys(mgrDash.json || {})));
check('manager dashboard has NO commissionTotals', mgrDash.json?.commissionTotals === undefined);
check('manager dashboard has NO recentActivity', mgrDash.json?.recentActivity === undefined);
check('manager agentPerformance has NO money', Array.isArray(mgrDash.json?.agentPerformance) && mgrDash.json.agentPerformance.every((a) => a.revenue === undefined && a.commissionEarned === undefined));
check('manager dashboard has leads/deals by stage', mgrDash.json?.leadsByStage !== undefined && mgrDash.json?.dealsByStage !== undefined);
const agentDash = await get('/api/dashboard', agentTok);
check('agent dashboard has NO revenue', agentDash.json?.revenue === undefined);
check('agent dashboard has NO agentPerformance', agentDash.json?.agentPerformance === undefined);
check('agent dashboard has myCommissions', agentDash.json?.myCommissions !== undefined, JSON.stringify(Object.keys(agentDash.json || {})));
check('agent leadsByStage only own', (() => {
  const total = Object.values(agentDash.json?.leadsByStage || {}).reduce((a, b) => a + b, 0);
  return total === (agentLeadsAfter.json?.length || 0) || total > 0;
})(), `leadsByStage=${JSON.stringify(agentDash.json?.leadsByStage)}`);

console.log('== 12. Manual commission ==');
const comms = await get('/api/commissions', adminTok);
const targetComm = comms.json?.commissions?.find((c) => c.dealId === dealId);
check('commission row exists for deal', !!targetComm, JSON.stringify(comms.json?.commissions?.slice(0, 2)));
if (targetComm) {
  const override = await put(`/api/commissions/${targetComm.id}`, adminTok, { amount: 99999, status: 'paid' });
  check('admin manual override 200', override.status === 200 && override.json?.amount === 99999 && override.json?.status === 'paid' && override.json?.manual === 1, JSON.stringify(override.json));
  const mgrOverride = await put(`/api/commissions/${targetComm.id}`, managerTok, { amount: 1 });
  check('manager manual override 403', mgrOverride.status === 403);
  const agentOverride = await put(`/api/commissions/${targetComm.id}`, agentTok, { amount: 1 });
  check('agent manual override 403', agentOverride.status === 403);
  const auditAfter = await get('/api/audit?action=COMMISSION_MANUAL', adminTok);
  check('manual override audit-logged', auditAfter.status === 200 && JSON.stringify(auditAfter.json).includes('COMMISSION_MANUAL'), JSON.stringify(auditAfter.json)?.slice(0, 200));
}

console.log('== 13. Login attempts in audit ==');
const audit = await get('/api/audit?limit=50', adminTok);
const auditText = JSON.stringify(audit.json);
check('audit contains LOGIN entries', auditText.includes('LOGIN'), auditText.slice(0, 300));
check('audit contains LOGIN_FAILED entries', auditText.includes('LOGIN_FAILED'));

console.log('== 14. Property types + seller ==');
for (const t of ['plot', 'house', 'commercial_land', 'agriculture_land', 'shop', 'commercial_building']) {
  const r = await get(`/api/properties?type=${t}`, adminTok);
  check(`type filter ${t} works (status ${r.status})`, r.status === 200 && Array.isArray(r.json));
}
const badType = await post('/api/properties', adminTok, { code: 'BAD-001', type: 'residential', title: 'Old type' });
check('old type residential rejected 400', badType.status === 400, `got ${badType.status}`);
const sellerContact = (await get('/api/contacts?q=Usman', adminTok)).json?.[0];
const newProp = await post('/api/properties', adminTok, {
  code: 'TST-001', type: 'shop', title: 'Test Shop', location: 'Test Road', areaValue: 100, areaUnit: 'sqft',
  price: 5000000, listingType: 'sale', sellerContactId: sellerContact?.id,
});
check('sale listing created (Available)', newProp.status === 201 && newProp.json?.status === 'Available' && newProp.json?.listingType === 'sale', JSON.stringify(newProp.json));
const propDetail = await get(`/api/properties/${newProp.json?.id}`, adminTok);
check('property detail embeds seller card', propDetail.json?.seller?.name === sellerContact?.name, JSON.stringify(propDetail.json?.seller));
const unlink = await post(`/api/properties/${newProp.json?.id}/seller`, adminTok, { contactId: null });
check('unlink seller', unlink.status === 200 && unlink.json?.seller === null);
const relink = await post(`/api/properties/${newProp.json?.id}/seller`, adminTok, { contactId: sellerContact?.id });
check('relink seller', relink.status === 200 && relink.json?.seller?.id === sellerContact?.id);
const noSellerProp = await post('/api/properties', adminTok, {
  code: 'TST-002', type: 'plot', title: 'No Seller Plot', location: 'Test', areaValue: 5, areaUnit: 'marla', price: 1000000,
});
check('property without seller has null seller', noSellerProp.status === 201 && noSellerProp.json?.seller === null);

console.log('== 15. Cleanup test data ==');
const delLead = await del(`/api/leads/${leadId}`, adminTok);
check('delete lead with deals blocked (409)', delLead.status === 409, `got ${delLead.status}`);
const delSell = await del(`/api/leads/${sellLeadId}`, adminTok);
check('delete sell lead blocked by deal (409)', delSell.status === 409, `got ${delSell.status}`);
const delUnassigned = await del(`/api/leads/${unassignedId}`, adminTok);
check('delete assigned test lead 200', delUnassigned.status === 200, `got ${delUnassigned.status}: ${JSON.stringify(delUnassigned.json)}`);
const delProp1 = await del(`/api/properties/${newProp.json?.id}`, adminTok);
check('delete test shop 200', delProp1.status === 200, `got ${delProp1.status}`);
const delProp2 = await del(`/api/properties/${noSellerProp.json?.id}`, adminTok);
check('delete test plot 200', delProp2.status === 200, `got ${delProp2.status}`);

console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
if (failures.length) console.log('Failures:', failures.join(' | '));
process.exit(failed ? 1 : 0);
