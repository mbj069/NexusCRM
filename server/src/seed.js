// Demo seed for NexusCRM. Wipe-and-seed: safe to re-run.
// The demo agency is "Trust Property Real Estate Agency" (seed data only);
// the product itself is the generic NexusCRM.
//
// v1.1 seed demonstrates every new feature: BUY/SELL intents + societies,
// lead assignment (two agents + one unassigned lead), all six inventory
// types, owner/seller links on properties, Token → Bayana → Installments
// → Final payment plans, and a manually overridden commission.
//
// v1.2 adds rentals: RENT intent, For Rent listings with rent per month,
// a rental deal whose value is the first month's rent with a half-month
// manual commission, and a two-stage rental plan (advance → final).

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { initSchema, withTransaction } from './db.js';

await initSchema();

const uid = () => crypto.randomUUID();
const hash = (pw) => bcrypt.hashSync(pw, 10);

try {
  await withTransaction(async (tx) => {
    // --- Wipe (child tables first) -------------------------------------------
    for (const t of ['payments', 'payment_schedule', 'payment_plans', 'commissions',
      'deals', 'activities', 'followups', 'documents', 'notifications',
      'leads', 'contacts', 'properties', 'users', 'counters', 'audit_log']) {
      await tx.prepare(`DELETE FROM ${t}`).run();
    }

    // --- Users -----------------------------------------------------------------
    const adminId = uid(), managerId = uid(), agentId = uid(), agent2Id = uid();
    const insUser = tx.prepare(`INSERT INTO users (id, username, password_hash, name, role, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?)`);
    await insUser.run(adminId, 'admin@nexuscrm.local', hash('changeme123'), 'Administrator', 'admin', 1);
    await insUser.run(managerId, 'manager@nexuscrm.local', hash('manager123'), 'Sara Ahmed', 'manager', 0);
    await insUser.run(agentId, 'agent@nexuscrm.local', hash('agent123'), 'Bilal Hussain', 'agent', 0);
    await insUser.run(agent2Id, 'omar@nexuscrm.local', hash('omar123'), 'Omar Farooq', 'agent', 0);

    // --- Contacts ---------------------------------------------------------------
    const C = {};
    const insContact = tx.prepare(`INSERT INTO contacts
      (id, name, phone, whatsapp, type, source, email, notes, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const contacts = [
      ['Ahmed Raza', '+923001234567', '+923001234567', 'buyer', 'referral', 'ahmed.raza@example.com', 'Prefers corner plots.', agentId],
      ['Fatima Khan', '+923219876543', '', 'buyer', 'website', 'fatima.k@example.com', 'Looking near University Road.', managerId],
      ['Usman Tariq', '+923334455667', '+923334455667', 'seller', 'manual', '', 'Wants to sell 10 marla in Model City.', agentId],
      ['Ayesha Malik', '+923457788990', '+923457788990', 'buyer', 'WhatsApp', '', 'First-time buyer.', agentId],
      ['Imran Sheikh', '+923007766554', '', 'buyer', 'social', '', 'Investor, commercial interest.', managerId],
      ['Hina Aslam', '+923216655443', '+923216655443', 'seller', 'referral', '', 'Inherited plot, motivated seller.', managerId],
      ['Kashif Mehmood', '+923339988776', '+923339988776', 'buyer', 'manual', '', 'Asked about Gulberg City kanal plots.', agentId],
      ['Nadia Akram', '+923115544332', '', 'buyer', 'website', 'nadia.a@example.com', 'Budget-conscious, 3 marla range.', agentId],
      ['Tariq Aziz', '+923008877665', '+923008877665', 'buyer', 'WhatsApp', '', 'Booked 10 marla in Model City.', managerId],
      ['Saima Nawaz', '+923224433221', '', 'seller', 'social', '', 'Shop owner on Kachehri Road.', agentId],
      ['Zahid Mahmood', '+923006655443', '+923006655443', 'buyer', 'referral', '', 'Closed deal on HSE-003.', managerId],
      ['Malik Ashfaq', '+923005566778', '+923005566778', 'seller', 'manual', '', 'Agriculture land owner, Sargodha outskirts.', agentId],
      ['Chaudhry Riaz', '+923017788990', '', 'seller', 'referral', '', 'Commercial land owner on University Road.', managerId],
      ['Bilal Ahmed', '+923001234568', '+923001234568', 'buyer', 'website', '', 'Looking for a 5 marla house on rent in Satellite Town.', agent2Id],
    ];
    for (const [name, phone, wa, type, source, email, notes, owner] of contacts) {
      const id = uid();
      C[name] = id;
      await insContact.run(id, name, phone, wa, type, source, email, notes, owner);
    }

    // --- Properties (Sargodha inventory — all six types, each with a seller) ---
    // Each entry: [code, type, title, location, area, unit, price, status, desc, seller, listing, rentPerMonth]
    // Sale listings carry price (rent NULL); rent listings carry rentPerMonth (price 0).
    const P = {};
    const insProp = tx.prepare(`INSERT INTO properties
      (id, code, type, title, location, area_value, area_unit, price, rent_per_month, status, description, owner_id, listing_type, seller_contact_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const props = [
      ['PLT-001', 'plot', '5 Marla Residential Plot', 'Wadi-e-Sitara Housing Scheme, Sargodha', 5, 'marla', 2800000, 'Available', 'East-facing plot near the scheme park.', 'Hina Aslam', 'sale', null],
      ['PLT-002', 'plot', '10 Marla Residential Plot', 'Model City, Sargodha', 10, 'marla', 6500000, 'Booked', 'Corner plot on 40-ft road.', 'Usman Tariq', 'sale', null],
      ['PLT-003', 'plot', '1 Kanal Residential Plot', 'Gulberg City, Sargodha', 1, 'kanal', 14000000, 'Available', 'Prime block, clear title.', 'Hina Aslam', 'sale', null],
      ['PLT-004', 'plot', '7 Marla Residential Plot', 'Wadi-e-Sitara Housing Scheme, Sargodha', 7, 'marla', 3900000, 'Booked', 'Near commercial area.', 'Usman Tariq', 'sale', null],
      ['HSE-001', 'house', '5 Marla House (Double Storey)', 'Satellite Town, Sargodha', 5, 'marla', 9500000, 'Available', '4 bed, 3 bath, tiled flooring.', 'Saima Nawaz', 'sale', null],
      ['HSE-002', 'house', '10 Marla House (Designer)', 'University Road, Sargodha', 10, 'marla', 18000000, 'Available', '5 bed with lawn, near university.', 'Usman Tariq', 'sale', null],
      ['HSE-003', 'house', '5 Marla House (Single Storey)', 'Model City, Sargodha', 5, 'marla', 8750000, 'Sold', '3 bed, mumty, sold Oct 2026.', 'Hina Aslam', 'sale', null],
      ['CLD-001', 'commercial_land', '2 Kanal Commercial Land', 'University Road, Sargodha', 2, 'kanal', 22000000, 'Available', 'Main-road commercial frontage.', 'Chaudhry Riaz', 'sale', null],
      ['AGL-001', 'agriculture_land', '10 Kanal Agriculture Land', 'Sargodha Outskirts', 10, 'kanal', 8000000, 'Available', 'Fertile land with water access.', 'Malik Ashfaq', 'sale', null],
      ['SHP-001', 'shop', 'Corner Shop', 'Faisalabad Road, Sargodha', 250, 'sqft', 12000000, 'Available', 'High footfall commercial strip.', 'Saima Nawaz', 'sale', null],
      ['CMB-001', 'commercial_building', 'Plaza First Floor (Hall)', 'Kachehri Road, Sargodha', 1200, 'sqft', 35000000, 'Available', 'Open hall, suitable for offices.', 'Saima Nawaz', 'sale', null],
      ['CMB-002', 'commercial_building', 'Main Boulevard Commercial Building', 'Faisalabad Road, Sargodha', 900, 'sqft', 28000000, 'Blocked', 'Title verification in progress.', 'Chaudhry Riaz', 'sale', null],
      ['RNT-HSE-001', 'house', '5 Marla House on Rent', 'Satellite Town, Sargodha', 5, 'marla', 0, 'Booked', '3 bed, 2 bath, family house on rent.', 'Saima Nawaz', 'rent', 45000],
      ['RNT-SHP-001', 'shop', 'Shop on Rent', 'Kachehri Road, Sargodha', 250, 'sqft', 0, 'Available', 'Main-road shop, ideal for retail.', 'Saima Nawaz', 'rent', 60000],
      ['RNT-HSE-002', 'house', '3 Marla House on Rent', 'Model City, Sargodha', 3, 'marla', 0, 'Available', '2 bed, newly painted, small family.', 'Hina Aslam', 'rent', 35000],
    ];
    for (const [code, type, title, location, area, unit, price, status, desc, seller, listing, rent] of props) {
      const id = uid();
      P[code] = id;
      await insProp.run(id, code, type, title, location, area, unit, price, rent, status, desc, managerId, listing, C[seller]);
    }

    // --- Leads (intents + societies + assignment) ------------------------------
    const L = {};
    const insLead = tx.prepare(`INSERT INTO leads
      (id, contact_id, name, phone, whatsapp, source, interest, intent, society, budget_min, budget_max, stage, score, owner_id, assigned_to, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const leads = [
      [C['Ahmed Raza'], 'Ahmed Raza', '+923001234567', '+923001234567', 'referral', '5 marla plot in Wadi-e-Sitara', 'buy', 'Wadi-e-Sitara', 2500000, 3200000, 'negotiating', 65, agentId, agentId, 'Negotiating payment terms.'],
      [C['Fatima Khan'], 'Fatima Khan', '+923219876543', '', 'website', '10 marla house near University Road', 'buy', 'Gulberg City', 16000000, 19000000, 'viewing', 50, managerId, agent2Id, 'Second site visit done.'],
      [null, 'Danish Ali', '+923001112223', '+923001112223', 'WhatsApp', 'Shop on Faisalabad Road', 'buy', 'Model City', 10000000, 13000000, 'new', 30, agentId, agent2Id, 'Inbound WhatsApp inquiry.'],
      [C['Ayesha Malik'], 'Ayesha Malik', '+923457788990', '+923457788990', 'WhatsApp', '5 marla plot', 'sell', 'Satellite Town', 2800000, 3500000, 'contacted', 40, agentId, agentId, 'Wants to sell her plot, shared options.'],
      [C['Imran Sheikh'], 'Imran Sheikh', '+923007766554', '', 'social', 'Commercial plaza investment', 'buy', 'Gulberg City', 30000000, 40000000, 'new', 10, managerId, null, 'Waiting on investment deck. Unassigned — manager assigns.'],
      [C['Kashif Mehmood'], 'Kashif Mehmood', '+923339988776', '+923339988776', 'manual', '1 kanal plot in Gulberg City', 'buy', 'Gulberg City', 13000000, 15000000, 'viewing', 50, agentId, agentId, 'Liked PLT-003.'],
      [C['Nadia Akram'], 'Nadia Akram', '+923115544332', '', 'website', '3 marla house', 'buy', 'Model City', 6500000, 7500000, 'contacted', 30, agentId, agent2Id, 'Sent HSE-004 details.'],
      [C['Tariq Aziz'], 'Tariq Aziz', '+923008877665', '+923008877665', 'WhatsApp', '10 marla plot in Model City', 'buy', 'Model City', 6000000, 7000000, 'won', 75, managerId, agentId, 'Deal closed, plan active.'],
      [null, 'Farhan Iqbal', '+923004445556', '', 'manual', '4 marla plot in Satellite Town', 'sell', 'Satellite Town', 3000000, 3400000, 'lost', 10, agentId, agent2Id, 'Went with another dealer.'],
      [null, 'Rabia Anwar', '+923215566778', '+923215566778', 'referral', '5 marla house in Satellite Town', 'sell', 'Satellite Town', 9000000, 10000000, 'new', 35, managerId, agentId, 'Referred by Hina Aslam. Wants to sell.'],
      [C['Zahid Mahmood'], 'Zahid Mahmood', '+923006655443', '+923006655443', 'referral', '5 marla house in Model City', 'buy', 'Model City', 8500000, 9000000, 'won', 80, managerId, agentId, 'Deal closed Oct 2026.'],
      [C['Bilal Ahmed'], 'Bilal Ahmed', '+923001234568', '+923001234568', 'website', '5 marla house on rent', 'rent', 'Satellite Town', 30000, 50000, 'viewing', 40, agent2Id, agent2Id, 'Wants a 5 marla house on rent in Satellite Town.'],
    ];
    for (const [cid, name, phone, wa, source, interest, intent, society, bmin, bmax, stage, score, owner, assignee, notes] of leads) {
      const id = uid();
      L[name] = id;
      await insLead.run(id, cid, name, phone, wa, source, interest, intent, society, bmin, bmax, stage, score, owner, assignee, notes);
    }

    // --- Activities ---------------------------------------------------------------
    const insAct = tx.prepare(`INSERT INTO activities (id, entity_type, entity_id, actor_id, kind, text, created_at)
      VALUES (?, 'lead', ?, ?, ?, ?, ?)`);
    const acts = [
      [L['Ahmed Raza'], agentId, 'note', 'Buyer wants a corner plot preference if available.', '2026-10-10 10:00:00'],
      [L['Ahmed Raza'], agentId, 'call', 'Discussed payment plan options; buyer asked for 12 installments.', '2026-10-12 15:30:00'],
      [L['Ahmed Raza'], agentId, 'stage_change', 'Stage changed: viewing → negotiating', '2026-10-13 11:00:00'],
      [L['Fatima Khan'], managerId, 'viewing', 'Site visit to University Road house; buyer liked the lawn.', '2026-10-14 17:00:00'],
      [L['Danish Ali'], agent2Id, 'message', 'WhatsApp: inquired about Faisalabad Road shops.', '2026-10-16 09:15:00'],
      [L['Kashif Mehmood'], agentId, 'viewing', 'Showed 1 kanal plot in Gulberg City.', '2026-10-15 12:00:00'],
    ];
    for (const [leadId, actor, kind, text, at] of acts) await insAct.run(uid(), leadId, actor, kind, text, at);

    // --- Follow-ups (one overdue) ---------------------------------------------------
    const insFu = tx.prepare(`INSERT INTO followups (id, entity_type, entity_id, title, due_date, done, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    await insFu.run(uid(), 'lead', L['Danish Ali'], 'Call back about shop options', '2026-10-16', 0, agent2Id);
    await insFu.run(uid(), 'lead', L['Ahmed Raza'], 'Remind about next installment', '2026-10-20', 0, agentId);
    await insFu.run(uid(), 'lead', L['Fatima Khan'], 'Schedule third site visit', '2026-10-18', 0, managerId);
    await insFu.run(uid(), 'contact', C['Ahmed Raza'], 'Send payment receipt copy', '2026-10-22', 1, agentId);

    // --- Deals ----------------------------------------------------------------------
    const insDeal = tx.prepare(`INSERT INTO deals
      (id, lead_id, property_id, agent_id, stage, deal_value, bayana_amount, commission_type, commission_value, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const D1 = uid(), D2 = uid(), D3 = uid(), D4 = uid();
    await insDeal.run(D1, L['Ahmed Raza'], P['PLT-004'], agentId, 'in_progress', 3900000, 200000, 'percent', 2, 'Token received, plan active.', '2026-08-01 10:00:00');
    await insDeal.run(D2, L['Tariq Aziz'], P['PLT-002'], agentId, 'in_progress', 6500000, 300000, 'fixed', 100000, 'Corporate buyer, bank transfers.', '2026-05-01 10:00:00');
    await insDeal.run(D3, L['Zahid Mahmood'], P['HSE-003'], managerId, 'closed_won', 8750000, 0, 'percent', 1.5, 'Full payment received.', '2026-09-05 10:00:00');
    // D4 (v1.2 rental): deal value is the first month's rent (45,000),
    // bayana 0, commission is a fixed half-month manual amount (22,500).
    await insDeal.run(D4, L['Bilal Ahmed'], P['RNT-HSE-001'], agent2Id, 'in_progress', 45000, 0, 'fixed', 22500, 'Rental — first month rent, advance received.', '2026-11-01 10:00:00');

    // --- Commissions ------------------------------------------------------------------
    // D2's commission is the manual-override example: the auto fixed amount
    // was 100,000; the admin set 125,000 manually (manual=1).
    // D4's commission is the rental manual example: half a month's rent
    // (22,500), set at deal creation (manual=1).
    const insComm = tx.prepare(`INSERT INTO commissions (id, deal_id, agent_id, amount, status, paid_at, manual)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    await insComm.run(uid(), D1, agentId, 78000, 'pending', null, 0);
    await insComm.run(uid(), D2, agentId, 125000, 'pending', null, 1);
    await insComm.run(uid(), D3, managerId, 131250, 'paid', '2026-10-05T10:00:00.000Z', 0);
    await insComm.run(uid(), D4, agent2Id, 22500, 'pending', null, 1);

    // --- Payment plans + schedules (Token → Bayana → Installments → Final) ---------
    const insPlan = tx.prepare(`INSERT INTO payment_plans
      (id, deal_id, contact_id, total_amount, token_amount, bayana_amount, final_amount, num_installments, installment_amount, start_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insSched = tx.prepare(`INSERT INTO payment_schedule
      (id, plan_id, seq, due_date, amount, kind, status, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insPay = tx.prepare(`INSERT INTO payments
      (id, plan_id, schedule_id, amount, method, received_by, receipt_no, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    // Plan 1: 3,900,000 = token 100,000 + bayana 200,000 + 12 x 227,500 + final 870,000
    const P1 = uid();
    await insPlan.run(P1, D1, C['Ahmed Raza'], 3900000, 100000, 200000, 870000, 12, 227500, '2026-08-01');
    const sched1 = [
      ['2026-08-01', 100000, 'token', 'paid', 'RCP-2026-0001', 100000, 'cash', '2026-08-01 11:00:00'],
      ['2026-08-01', 200000, 'bayana', 'paid', 'RCP-2026-0002', 200000, 'cash', '2026-08-01 11:00:00'],
      ['2026-09-01', 227500, 'installment', 'paid', 'RCP-2026-0003', 227500, 'bank', '2026-09-02 11:00:00'],
    ];
    let seq = 0;
    for (const [due, amt, kind, status, rcp, payAmt, method, at] of sched1) {
      const sid = uid();
      await insSched.run(sid, P1, seq, due, amt, kind, status, status === 'paid' ? at : null);
      await insPay.run(uid(), P1, sid, payAmt, method, agentId, rcp, '', at);
      seq++;
    }
    const rest1 = ['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01',
      '2027-04-01', '2027-05-01', '2027-06-01', '2027-07-01', '2027-08-01'];
    for (const due of rest1) { await insSched.run(uid(), P1, seq++, due, 227500, 'installment', 'pending', null); }
    await insSched.run(uid(), P1, seq, '2027-09-01', 870000, 'final', 'pending', null);

    // Plan 2: 6,500,000 = token 150,000 + bayana 300,000 + 10 x 455,000 + final 1,500,000
    const P2 = uid();
    await insPlan.run(P2, D2, C['Tariq Aziz'], 6500000, 150000, 300000, 1500000, 10, 455000, '2026-05-01');
    const sched2 = [
      ['2026-05-01', 150000, 'token', 'paid', 'RCP-2026-0004', 150000, 'bank', '2026-05-01 11:00:00'],
      ['2026-05-01', 300000, 'bayana', 'paid', 'RCP-2026-0005', 300000, 'bank', '2026-05-01 11:00:00'],
      ['2026-06-01', 455000, 'installment', 'paid', 'RCP-2026-0006', 455000, 'transfer', '2026-06-03 11:00:00'],
      ['2026-07-01', 455000, 'installment', 'paid', 'RCP-2026-0007', 455000, 'transfer', '2026-07-02 11:00:00'],
    ];
    seq = 0;
    for (const [due, amt, kind, status, rcp, payAmt, method, at] of sched2) {
      const sid = uid();
      await insSched.run(sid, P2, seq, due, amt, kind, status, status === 'paid' ? at : null);
      await insPay.run(uid(), P2, sid, payAmt, method, agentId, rcp, '', at);
      seq++;
    }
    const rest2 = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01'];
    for (const due of rest2) { await insSched.run(uid(), P2, seq++, due, 455000, 'installment', 'pending', null); }
    await insSched.run(uid(), P2, seq, '2027-04-01', 1500000, 'final', 'pending', null);

    // Plan 3 (v1.2 rental): 45,000 = advance (token) 20,000 + final 25,000.
    // No bayana, no installments — exactly two stages.
    const P3 = uid();
    await insPlan.run(P3, D4, C['Bilal Ahmed'], 45000, 20000, 0, 25000, 0, 0, '2026-11-01');
    const tokenSid = uid();
    await insSched.run(tokenSid, P3, 0, '2026-11-01', 20000, 'token', 'paid', '2026-11-01 11:00:00');
    await insPay.run(uid(), P3, tokenSid, 20000, 'cash', agent2Id, 'RCP-2026-0008', '', '2026-11-01 11:00:00');
    await insSched.run(uid(), P3, 1, '2026-12-01', 25000, 'final', 'pending', null);

    await tx.prepare('INSERT INTO counters (name, next) VALUES (?, ?)').run('receipt_2026', 9);

    // --- Notifications ------------------------------------------------------------------
    const insNotif = tx.prepare(`INSERT INTO notifications (id, user_id, kind, title, body, link, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    await insNotif.run(uid(), null, 'overdue_installment', 'Overdue installments need attention',
      '4 installment(s) are past due. Run an overdue scan for details.', '', 0);
    await insNotif.run(uid(), managerId, 'info', 'Welcome to NexusCRM',
      'Seed data loaded for Trust Property Real Estate Agency.', '', 1);

  });
  console.log('Seed complete: 4 users, 15 properties, 14 contacts, 12 leads, 4 deals, 3 plans, 8 payments.');
} catch (e) {
  console.error('Seed failed:', e);
  process.exit(1);
}
