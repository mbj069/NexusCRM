// WhatsApp: Meta webhook verification + inbound handling, plus admin
// Cloud API config and a send-test endpoint.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { audit, auditReq } from '../audit.js';
import { ah, httpError, uid } from '../util.js';

async function getWAConfig() {
  const row = await db.prepare('SELECT * FROM whatsapp_config WHERE id = 1').get();
  return {
    phoneNumberId: row?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    token: row?.token || process.env.WHATSAPP_TOKEN || '',
    verifyToken: row?.verify_token || process.env.WHATSAPP_VERIFY_TOKEN || '',
    enabled: !!(row?.enabled ?? 0),
  };
}

// --- Inbound webhook (mounted at /api/webhooks/whatsapp, no auth) ------------

export const webhookRouter = Router();

// GET — Meta verification handshake
webhookRouter.get('/', ah(async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const cfg = await getWAConfig();
  if (mode === 'subscribe' && token && cfg.verifyToken && token === cfg.verifyToken) {
    return res.status(200).type('text/plain').send(challenge);
  }
  return res.status(403).json({ error: 'Verification failed.' });
}));

// POST — inbound events
webhookRouter.post('/', ah(async (req, res) => {
  const payload = req.body || {};
  audit({
    actorId: '', actorName: 'whatsapp-webhook', role: '',
    action: 'WHATSAPP_EVENT', details: `Inbound webhook: ${JSON.stringify(payload).slice(0, 500)}`,
  });

  try {
    const changes = payload?.entry?.[0]?.changes || [];
    for (const change of changes) {
      const value = change?.value || {};
      const messages = value.messages || [];
      for (const msg of messages) {
        if (msg.type !== 'text' || !msg.text?.body) continue;
        const sender = msg.from || '';
        const text = msg.text.body.trim().slice(0, 1000);
        const profileName = value.contacts?.find((c) => c.wa_id === sender)?.profile?.name || '';
        handleInboundMessage(sender, text, profileName).catch((e) =>
          console.error('whatsapp inbound message handling failed:', e.message));
      }
    }
  } catch (e) {
    console.error('whatsapp inbound handling failed:', e.message);
  }
  res.status(200).type('text/plain').send('EVENT_RECEIVED');
}));

/** Create or update a WhatsApp-sourced lead from an inbound text message. */
async function handleInboundMessage(sender, text, profileName) {
  if (!sender) return;
  let lead = await db.prepare("SELECT * FROM leads WHERE (phone = ? OR whatsapp = ?) AND source = 'WhatsApp' ORDER BY updated_at DESC LIMIT 1")
    .get(sender, sender);
  if (lead) {
    await db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE id = ?").run(lead.id);
  } else {
    const id = uid();
    await db.prepare(`INSERT INTO leads (id, name, phone, whatsapp, source, interest, stage, notes)
      VALUES (?, ?, ?, ?, 'WhatsApp', '', 'new', 'Created from inbound WhatsApp message.')`)
      .run(id, profileName || sender, sender, sender);
    lead = await db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    audit({
      actorId: '', actorName: 'whatsapp-webhook', role: '',
      action: 'LEAD_CREATE', entityType: 'lead', entityId: id,
      details: `Lead created from inbound WhatsApp message (${sender}).`,
    });
  }
  await db.prepare(`INSERT INTO activities (id, entity_type, entity_id, actor_id, kind, text)
    VALUES (?, 'lead', ?, NULL, 'message', ?)`)
    .run(uid(), lead.id, `WhatsApp from ${sender}: ${text}`);
  audit({
    actorId: '', actorName: 'whatsapp-webhook', role: '',
    action: 'WHATSAPP_INBOUND', entityType: 'lead', entityId: lead.id,
    details: `Inbound WhatsApp message from ${sender} attached to lead ${lead.id}.`,
  });
}

// --- Admin config + send test (mounted at /api/whatsapp, auth) ---------------

export const whatsappRouter = Router();
whatsappRouter.use(requireAuth);

// GET /api/whatsapp/config — admin; token never returned
whatsappRouter.get('/config', requirePermission('whatsapp_config'), ah(async (req, res) => {
  const cfg = await getWAConfig();
  res.json({
    phoneNumberId: cfg.phoneNumberId,
    hasToken: !!cfg.token,
    hasVerifyToken: !!cfg.verifyToken,
    enabled: cfg.enabled,
  });
}));

// PUT /api/whatsapp/config { phoneNumberId, token, verifyToken, enabled } — admin
whatsappRouter.put('/config', requirePermission('whatsapp_config'), ah(async (req, res) => {
  const { phoneNumberId, token, verifyToken, enabled } = req.body || {};
  await db.prepare(`UPDATE whatsapp_config SET
      phone_number_id = COALESCE(?, phone_number_id),
      token = COALESCE(?, token),
      verify_token = COALESCE(?, verify_token),
      enabled = COALESCE(?, enabled),
      updated_at = datetime('now') WHERE id = 1`)
    .run(
      phoneNumberId !== undefined ? String(phoneNumberId) : null,
      token !== undefined ? String(token) : null,
      verifyToken !== undefined ? String(verifyToken) : null,
      enabled !== undefined ? (enabled ? 1 : 0) : null
    );
  auditReq(req, 'WHATSAPP_CONFIG_UPDATE', { details: 'WhatsApp Cloud API config updated.' });
  const cfg = await getWAConfig();
  res.json({ phoneNumberId: cfg.phoneNumberId, hasToken: !!cfg.token, hasVerifyToken: !!cfg.verifyToken, enabled: cfg.enabled });
}));

// POST /api/whatsapp/send-test { to, text } — admin
// Real Meta Cloud API send when credentials + enabled; honest dry-run otherwise.
whatsappRouter.post('/send-test', requirePermission('whatsapp_config'), ah(async (req, res) => {
  const { to, text } = req.body || {};
  if (!to?.trim() || !text?.trim()) throw httpError(400, 'to and text are required.');
  const cfg = await getWAConfig();
  if (!cfg.enabled || !cfg.phoneNumberId || !cfg.token) {
    return res.json({ dryRun: true, wouldSend: { to: to.trim(), text: text.trim() } });
  }
  let result;
  try {
    const resp = await fetch(`https://graph.facebook.com/v19.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.trim(),
        type: 'text',
        text: { body: text.trim() },
      }),
    });
    result = await resp.json();
    if (!resp.ok) {
      throw httpError(502, `Meta API error: ${result?.error?.message || resp.status}`);
    }
  } catch (e) {
    if (e.status) throw e;
    throw httpError(502, 'Could not reach the Meta WhatsApp API.');
  }
  auditReq(req, 'WHATSAPP_SEND', { details: `Test WhatsApp message sent to ${to.trim()}.` });
  res.json({ dryRun: false, result });
}));
