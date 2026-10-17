// ------------------------------------------------------------------
// AI gateway. The provider API key NEVER leaves the server — the frontend
// calls these endpoints, and the backend calls the provider.
// Every AI call is audit-logged. Without a key: 503 NO_API_KEY, never a crash.
// ------------------------------------------------------------------

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, todayStr } from '../util.js';

const router = Router();
router.use(requireAuth);

// --- Provider config (DB row, env fallback) --------------------------------

function getAIConfig() {
  const row = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
  return {
    baseUrl: row?.base_url || process.env.AI_PROVIDER_URL || 'https://api.openai.com/v1',
    // Admin-set key wins; otherwise env var. Never sent to the client.
    apiKey: row?.api_key || process.env.AI_API_KEY || '',
    model: row?.model || process.env.AI_MODEL || 'gpt-4o-mini',
  };
}

async function providerChat({ messages, temperature = 0.3 }) {
  const { baseUrl, apiKey, model } = getAIConfig();
  if (!apiKey) {
    const err = new Error('No AI provider API key configured.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature }),
    });
  } catch {
    const err = new Error('Could not reach the AI provider.');
    err.code = 'NETWORK_ERROR';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(
      res.status === 401 || res.status === 403
        ? 'The AI provider rejected the API key.'
        : `AI provider error (${res.status}).`
    );
    err.code = res.status === 401 || res.status === 403 ? 'AUTH_ERROR' : 'PROVIDER_ERROR';
    throw err;
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) {
    const err = new Error('The AI provider returned an empty response.');
    err.code = 'PROVIDER_ERROR';
    throw err;
  }
  return { message: choice.message, usage: data.usage || null };
}

const aiError = (res, e) => {
  const status = e.code === 'NO_API_KEY' ? 503 : e.code === 'AUTH_ERROR' ? 502 : 500;
  res.status(status).json({ error: e.message, code: e.code || 'AI_ERROR' });
};

// --- Lead context for prompts (facts only, nothing invented) ----------------

function leadText(leadId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return null;
  const contact = lead.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(lead.contact_id) : null;
  const acts = db.prepare(`SELECT kind, text, created_at FROM activities
    WHERE entity_type = 'lead' AND entity_id = ? ORDER BY created_at DESC LIMIT 10`).all(leadId);
  const lines = [
    `Name: ${lead.name}`,
    `Phone: ${lead.phone || '—'} | WhatsApp: ${lead.whatsapp || '—'}`,
    `Source: ${lead.source} | Stage: ${lead.stage} | Interest: ${lead.interest || '—'}`,
    `Budget: ${lead.budget_min || '—'} – ${lead.budget_max || '—'} PKR`,
    `Rules-based score: ${lead.score}/100`,
  ];
  if (contact) lines.push(`Linked contact: ${contact.name} (${contact.type})`);
  if (acts.length) {
    lines.push('Recent activity:');
    for (const a of acts) lines.push(`- [${a.kind}] ${a.text} (${String(a.created_at).slice(0, 10)})`);
  } else {
    lines.push('Recent activity: none recorded.');
  }
  return { lead, text: lines.join('\n') };
}

function overdueText() {
  const rows = db.prepare(`SELECT s.*, pp.total_amount, c.name AS contact_name, c.phone AS contact_phone,
      d.id AS deal_id, pr.code AS property_code FROM payment_schedule s
    JOIN payment_plans pp ON pp.id = s.plan_id
    JOIN contacts c ON c.id = pp.contact_id
    LEFT JOIN deals d ON d.id = pp.deal_id
    LEFT JOIN properties pr ON pr.id = d.property_id
    WHERE s.status = 'pending' AND s.due_date < ?
    ORDER BY s.due_date`).all(todayStr());
  if (!rows.length) return 'No overdue installments right now.';
  const lines = rows.map((r) => {
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE schedule_id = ?').get(r.id).s;
    const kind = { down_payment: 'down payment', installment: `installment #${r.seq}`, possession: 'possession' }[r.kind] || r.kind;
    return `- ${r.contact_name} (${r.contact_phone}): ${kind} of ${Number(r.amount).toLocaleString()} PKR due ${r.due_date}, paid so far ${Number(paid).toLocaleString()} — property ${r.property_code || '—'}`;
  });
  return `Overdue installments (${rows.length}):\n` + lines.join('\n');
}

// --- Endpoints ----------------------------------------------------------------

// POST /api/ai/score-lead { leadId } -> { aiScore, reason }, stored on the lead
router.post('/score-lead', async (req, res) => {
  try {
    const { leadId } = req.body || {};
    if (!leadId) throw httpError(400, 'leadId is required.');
    const ctx = leadText(leadId);
    if (!ctx) throw httpError(404, 'Lead not found.');
    const { message, usage } = await providerChat({
      messages: [
        {
          role: 'system',
          content: `You score real-estate sales leads 0-100. Reply with ONLY a JSON object: {"score": <0-100 integer>, "reason": "<one or two sentences>"}.

Rules:
- Base the score strictly on the facts given. Do not invent data.
- Higher: further along the pipeline, reachable (phone/WhatsApp), stated budget, recent engagement.
- Lower: no contact details, stale or lost, no budget signal.
- Output JSON only, no markdown, no extra text.`,
        },
        { role: 'user', content: `Score this lead:\n${ctx.text}` },
      ],
      temperature: 0.2,
    });
    const raw = (message.content || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw Object.assign(new Error('The AI provider returned an unreadable score.'), { code: 'PROVIDER_ERROR' });
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch {
      throw Object.assign(new Error('The AI provider returned an unreadable score.'), { code: 'PROVIDER_ERROR' });
    }
    const aiScore = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
    if (!Number.isFinite(aiScore) || !parsed.reason) {
      throw Object.assign(new Error('The AI provider returned an unreadable score.'), { code: 'PROVIDER_ERROR' });
    }
    db.prepare('UPDATE leads SET ai_score = ?, ai_score_reason = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(aiScore, String(parsed.reason).slice(0, 500), leadId);
    auditReq(req, 'AI_SCORE', {
      entityType: 'lead', entityId: leadId,
      details: `AI scored lead ${ctx.lead.name}: ${aiScore}/100.${usage ? ` ${usage.total_tokens} tokens.` : ''}`,
    });
    res.json({ aiScore, reason: parsed.reason });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    aiError(res, e);
  }
});

// POST /api/ai/summarize { kind: 'lead' | 'overdue', id? } -> { summary }
router.post('/summarize', async (req, res) => {
  try {
    const { kind, id } = req.body || {};
    let prompt;
    let auditDetails;
    if (kind === 'lead') {
      if (!id) throw httpError(400, 'id (leadId) is required for kind "lead".');
      const ctx = leadText(id);
      if (!ctx) throw httpError(404, 'Lead not found.');
      prompt = `Summarize this sales lead for the agent in 4-6 short bullet points: who they are, what they want, where they stand in the pipeline, and the single best next action. Facts only — do not invent data.\n\n${ctx.text}`;
      auditDetails = `AI summary for lead ${ctx.lead.name}.`;
    } else if (kind === 'overdue') {
      prompt = `You are a collections assistant for a property dealership. Given the overdue installment list below, write a short briefing: total overdue amount, the most urgent accounts (oldest dues first), and a suggested follow-up order. Facts only — do not invent data. If the list is empty, say there is nothing overdue.\n\n${overdueText()}`;
      auditDetails = 'AI overdue-installments briefing.';
    } else {
      throw httpError(400, 'kind must be "lead" or "overdue".');
    }
    const { message, usage } = await providerChat({
      messages: [
        { role: 'system', content: 'You are NexusCRM AI, a concise sales assistant. Be factual and brief.' },
        { role: 'user', content: prompt },
      ],
    });
    auditReq(req, 'AI_SUMMARY', { details: auditDetails + (usage ? ` ${usage.total_tokens} tokens.` : '') });
    res.json({ summary: message.content });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    aiError(res, e);
  }
});

// GET /api/ai/config — admin; key presence only, never the key itself
router.get('/config', requirePermission('ai_config'), (req, res) => {
  const c = getAIConfig();
  const dbRow = db.prepare('SELECT api_key FROM ai_config WHERE id = 1').get();
  res.json({
    baseUrl: c.baseUrl,
    model: c.model,
    hasApiKey: !!c.apiKey,
    keySource: c.apiKey ? (dbRow?.api_key ? 'database' : 'environment') : 'none',
  });
});

// PUT /api/ai/config { baseUrl, apiKey, model } — admin
router.put('/config', requirePermission('ai_config'), (req, res) => {
  const { baseUrl, apiKey, model } = req.body || {};
  db.prepare(`UPDATE ai_config SET base_url = COALESCE(?, base_url), api_key = COALESCE(?, api_key),
    model = COALESCE(?, model), updated_at = datetime('now') WHERE id = 1`)
    .run(baseUrl || null, apiKey || null, model || null);
  auditReq(req, 'AI_CONFIG_UPDATE', { details: `AI provider config updated (model: ${model || '(unchanged)'}).` });
  res.json({ ok: true });
});

// POST /api/ai/test — admin connectivity check
router.post('/test', requirePermission('ai_config'), async (req, res) => {
  try {
    const { message } = await providerChat({
      messages: [
        { role: 'system', content: 'You are a connectivity probe. Reply with exactly: OK' },
        { role: 'user', content: 'ping' },
      ],
      temperature: 0,
    });
    auditReq(req, 'AI_CONFIG_TEST', { details: 'AI provider connection test succeeded.' });
    res.json({ ok: true, reply: message.content?.slice(0, 50) });
  } catch (e) {
    aiError(res, e);
  }
});

export default router;
