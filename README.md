# NexusCRM v1

A generic CRM with a property-dealer module. The core (contacts, leads, pipeline,
follow-ups, users, analytics) works for any small business; the property module
(inventory with Available/Booked/Sold/Blocked statuses, one-click unit assignment
with a double-booking guard, payment plans, installments, receipts, client ledgers,
commissions) is built for property dealers. Trust Property Real Estate Agency
(Sargodha) is the demo dataset's agency — customer #1, not the whole product.

Stack: React (Vite) frontend · Express backend · Node built-in SQLite
(`node:sqlite`, zero native dependencies) · bcrypt password hashing · JWT auth ·
server-enforced RBAC (admin / manager / agent) · append-only audit log.

```
app/
  server/   Express API (port 4000) — see server/README.md
  client/   React + Vite UI (dev port 5173, proxies /api → :4000) — see client/README.md
```

## Quick start (development)

```bash
# 1. Backend
cd server
npm install
cp .env.example .env        # then set a real JWT_SECRET in .env
npm run seed                # demo dataset (Sargodha properties, leads, deals)
npm run dev                 # http://localhost:4000 (watch mode)

# 2. Frontend (new terminal)
cd client
npm install
npm run dev                 # http://localhost:5173
```

Open http://localhost:5173 and log in:

| Role    | Username               | Password      |
|---------|------------------------|---------------|
| admin   | admin@nexuscrm.local   | changeme123   |
| manager | manager@nexuscrm.local | manager123    |
| agent   | agent@nexuscrm.local   | agent123      |

The admin account must change its password on first login. These are demo
credentials — change them (and `JWT_SECRET`) before any non-local use.

## Environment variables (server/.env)

| Variable                  | Purpose |
|---------------------------|---------|
| `PORT`                    | API port (default 4000) |
| `JWT_SECRET`              | **Required.** Long random string for signing tokens |
| `JWT_EXPIRES_IN`          | Token lifetime (default `8h`) |
| `DB_PATH`                 | SQLite file (default `./data/nexuscrm.db`) |
| `AI_PROVIDER_URL`         | OpenAI-compatible base URL (default `https://api.openai.com/v1`) |
| `AI_API_KEY`              | Provider key — or set it in Settings → AI (DB value wins) |
| `AI_MODEL`                | Model name (default `gpt-4o-mini`) |
| `WHATSAPP_PHONE_NUMBER_ID`| Meta Cloud API phone number ID |
| `WHATSAPP_TOKEN`          | Meta permanent system-user token |
| `WHATSAPP_VERIFY_TOKEN`   | Token you invent; must match the Meta dashboard entry |

Never commit a real `.env` (both `server/.gitignore` and good sense cover this).

## Production run

```bash
cd server && npm install --omit=dev && npm run seed && npm start
cd client && npm install && npm run build   # serve client/dist/ statically
```

Serve `client/dist` from the same host (Nginx/Caddy reverse-proxying `/api` to the
Node process) or any static host pointing its API base at the server.

**VPS with systemd** (`/etc/systemd/system/nexuscrm.service`):

```ini
[Unit]
Description=NexusCRM API
After=network.target

[Service]
WorkingDirectory=/opt/nexuscrm/server
ExecStart=/usr/bin/node src/index.js
Restart=always
Environment=PORT=4000
Environment=JWT_SECRET=<long-random-string>
Environment=DB_PATH=/opt/nexuscrm/server/data/nexuscrm.db
User=nexuscrm

[Install]
WantedBy=multi-user.target
```

Then `systemctl enable --now nexuscrm`. Put Caddy/Nginx in front for HTTPS and
serve `client/dist` as the site root with `/api/*` proxied to `localhost:4000`.

## Plugging in an AI key (bring-your-own-key)

No AI features work without a key — endpoints return
`503 {"code":"NO_API_KEY"}` instead of crashing. To enable:

1. Log in as **admin** → Settings → AI Configuration.
2. Enter the OpenAI-compatible base URL, API key, and model → Save → **Test**.
3. Use "AI score" on any lead, or "Summarize" for a lead / the overdue list.

Every AI call runs with the signed-in user's RBAC permissions and is written to
the audit log. The key lives server-side only — the browser never sees it.

## WhatsApp: what works today vs what needs Meta approval

**Works today (no approval):** every lead/contact phone number in the UI links to
a `wa.me` click-to-chat deep link with pre-filled text — agents tap and send
from their own WhatsApp.

**24/7 automation needs the client's Meta approval.** Rough path for the client:

1. Create a Meta developer account + Meta Business account; verify the business.
2. In the WhatsApp section, add a phone number (a number that can receive SMS/voice
   for verification — it becomes the business sender).
3. Create a system user with `whatsapp_business_messaging` permission and generate
   a permanent access token.
4. Set the webhook URL to `https://<your-domain>/api/webhooks/whatsapp` with the
   verify token from `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`.
5. Put `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_TOKEN` in the server `.env`
   (or Settings → WhatsApp) and use "Send test" to verify.

Until then, the webhook endpoints log inbound payloads and the send endpoint
honestly reports `{dryRun: true}` — nothing pretends to send.

## v1 scope (this build) vs v2

**v1 — shipped:** auth + RBAC + users; contacts; leads with pipeline stages,
rules-based scoring, activity timeline, follow-ups; property inventory with
search/filter and the transactional double-booking guard; deals with bayana and
stage-driven property status (Booked → Sold / released); auto-generated payment
plans (down payment + monthly installments + possession); payments with numbered
receipts and printable receipt HTML; per-client ledgers; transaction history per
property; commissions (percent/fixed, pending/paid, agent-scoped views);
document uploads per deal/contact/lead; notifications + overdue scan; dashboard
(revenue, funnel, inventory, agent performance, overdue); AI gateway (lead
scoring assist, summaries); WhatsApp webhook plumbing + wa.me fallback.

**v2 — deliberately deferred:** full 24/7 AI chat automation on WhatsApp
(needs the client's Meta approval above); social-channel lead capture; richer
reports/exports; multi-branch support; Urdu interface; PostgreSQL migration path
(the data-access layer is written so the SQL ports cleanly).

## Verification

The v1 build was smoke-tested end to end with curl: logins for all three roles,
RBAC denials (agent → 403 on users/audit), lead lifecycle + rules scoring,
property search, deal creation (Available→Booked), double-booking attempt
(**409, transaction rolled back**), payment plan generation, payment recording
with receipt numbering, printable receipt HTML, client ledger, deal close
(Booked→Sold), AI endpoints 503 without key, WhatsApp webhook verify round-trip
(200/403) + inbound lead creation, document upload/download/delete, overdue
scan, and audit-log coverage of every action. `vite build` passes with zero
errors.
