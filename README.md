# NexusCRM v1.2

A generic CRM with a property-dealer module. The core (contacts, leads, pipeline,
follow-ups, users, analytics) works for any small business; the property module
(inventory with Available/Booked/Sold/Blocked statuses, one-click unit assignment
with a double-booking guard, payment plans, installments, receipts, client ledgers,
commissions) is built for property dealers. Trust Property Real Estate Agency
(Sargodha) is the demo dataset's agency — customer #1, not the whole product.

v1.1 adds: leads with BUY/SELL intent and society filters; lead assignment to
agents with server-side agent scoping (agents see only their assigned leads,
own deals, own commissions); six inventory types (plot, house, commercial
land, agriculture land, shop, commercial building); properties listed "For
Sale" straight into inventory; owner/seller cards on property pages with
link/unlink; the Token → Bayana → Installments (optional) → Final payment
hierarchy with the final payment auto-computed as the remainder; admin-only
manual commission overrides (audit-logged); role-specific dashboards (admin
sees full money totals, manager sees the team view with no grand totals,
agents see only their own numbers); and every login attempt — success and
failure — written to the audit log (admin-only to view).

v1.2 adds: rental listings — properties listed "For Rent" with a monthly rent
(Rs X / month, price stored as 0) and a listing filter (All / For Sale /
For Rent) that composes with type and status on both the list and search
endpoints, where price filters use the effective price (rent per month for
rentals); RENT lead intent; rental deals whose value IS the first month's
rent (taken from the property, bayana forced to 0) with a manual commission
— half-month / full-month quick picks or a free amount, stored via the
manual-commission path (manual=1, audit-logged); simplified two-stage rental
payment plans (optional advance/token, then the final first month's rent —
no bayana, no installments); a 'Rented' terminal property status (a closed
rental deal rents the property instead of selling it); commissions-first
dashboards (admin Total/Pending commission up front, manager commission
counts with no money, agent My Total/Pending commission) and a Quick Add
bar on the dashboard that opens any section's add form.

Stack: React (Vite) frontend · Express backend · Turso (libSQL) database —
remote Turso in production, local libSQL file in development · bcrypt password
hashing · JWT auth · server-enforced RBAC (admin / manager / agent) ·
append-only audit log · Vercel Blob or database storage for uploads.

```
app/
  api/        Vercel serverless entry — re-exports the Express app
  server/     Express API (port 4000) — see server/README.md
  client/     React + Vite UI (dev port 5173, proxies /api → :4000) — see client/README.md
  vercel.json Build (Vite) + rewrite /api/* → /api/index
  package.json Root dependencies for the Vercel function (mirrors server/)
```

## Architecture

One URL serves everything. The Express app mounts all routes under `/api`
and the Vite client calls relative `/api` paths, so there is no API base URL
to configure — locally the Vite dev server proxies `/api` to `localhost:4000`;
on Vercel the rewrite sends `/api/*` to the serverless function, which
receives the original path, so the same `/api` routes match.

The data layer (`server/src/db.js`) is a small async adapter over
`@libsql/client` with the same call shape everywhere:
`db.prepare(sql).run/get/all(...)`, `db.exec(sql)` for schema, and
`withTransaction(fn)` for atomic multi-statement work (deal booking, plan
creation, payments — the double-booking guard is a write transaction that
re-checks the property status inside it). Parameters are `?` positional or
`@name` named (single object arg). With `TURSO_DATABASE_URL` set the
adapter talks to Turso; without it, it uses a local libSQL file, so local
development works with no cloud account. On Vercel the Turso variables are
required — a local file would not persist across serverless invocations, so
startup fails loudly instead of silently losing data.

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

## Environment variables (server/.env, or Vercel project settings)

| Variable                  | Purpose |
|---------------------------|---------|
| `PORT`                    | API port (default 4000) |
| `JWT_SECRET`              | **Required.** Long random string for signing tokens |
| `JWT_EXPIRES_IN`          | Token lifetime (default `8h`) |
| `DB_PATH`                 | Local libSQL file (default `./data/nexuscrm.db`) — used only when `TURSO_DATABASE_URL` is unset |
| `TURSO_DATABASE_URL`      | Turso database URL (`libsql://…`). **Required on Vercel** |
| `TURSO_AUTH_TOKEN`        | Turso auth token |
| `BLOB_READ_WRITE_TOKEN`   | Vercel Blob token (optional — see Uploads below) |
| `AI_PROVIDER_URL`         | OpenAI-compatible base URL (default `https://api.openai.com/v1`) |
| `AI_API_KEY`              | Provider key — or set it in Settings → AI (DB value wins) |
| `AI_MODEL`                | Model name (default `gpt-4o-mini`) |
| `WHATSAPP_PHONE_NUMBER_ID`| Meta Cloud API phone number ID |
| `WHATSAPP_TOKEN`          | Meta permanent system-user token |
| `WHATSAPP_VERIFY_TOKEN`   | Token you invent; must match the Meta dashboard entry |

Never commit a real `.env` (both `server/.gitignore` and good sense cover this).

## Seeding live (Turso)

Seeding wipes and re-creates the demo dataset — only run it against a
database you are happy to wipe (local dev, or a fresh Turso database):

```bash
cd server
TURSO_DATABASE_URL='libsql://<your-db>-<org>.turso.io' \
TURSO_AUTH_TOKEN='<token>' \
npm run seed
```

Without the `TURSO_*` variables the same command seeds the local file
database instead. The seed is a single write transaction: if any insert
fails, nothing is partially written.

## Uploads: Blob vs database

Document uploads never touch the local disk (disk storage does not persist
on Vercel), and the API shape is unchanged (multipart `file` + `entityType`
+ `entityId`, 25 MB limit; responses add a `storage` field: `"blob"`,
`"db"`, or `"legacy"`):

- **`BLOB_READ_WRITE_TOKEN` set** — files go to Vercel Blob (`put`) and the
  public URL is stored on the document row; downloads redirect to it.
  Deleting a document also deletes the Blob object (best-effort).
- **Otherwise** — file bytes are stored in the database (`documents.data`
  BLOB). Files over **5 MB** get `413` with a message saying to configure
  Blob for larger files.
- **If a Blob upload fails** (bad token, network), the upload falls back to
  database storage instead of failing or pretending — the row records
  `storage: "db"`, so what actually holds the bytes is always visible.
- Rows created before this change (disk-era, no URL and no bytes) still
  resolve from the legacy `server/uploads/` directory when the file is there.

## Production run (Vercel)

One Vercel project, one URL:

1. Create a Turso database (`turso db create nexuscrm`) and a token
   (`turso db tokens create nexuscrm`).
2. In the Vercel project, set `JWT_SECRET`, `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, and (optionally) `BLOB_READ_WRITE_TOKEN` plus the
   AI/WhatsApp variables. Create a Blob store in the Vercel dashboard if
   you want Blob uploads.
3. Deploy. Vercel installs the root dependencies, builds the Vite client
   (`client/dist`), and serves the Express app from `api/index.js` for
   `/api/*`. The schema is created on first cold start (`initSchema` runs
   at import), and `documents.data` / `documents.url` columns are added
   idempotently for databases created before this migration.
4. Seed the live database once (see "Seeding live" above) — or skip it and
   create the admin user through the app.

Local production-style run (no Vercel):

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

**v1.1 — shipped:** leads with BUY/SELL intent + society filters and
assignment to agents (agents see only assigned leads, own deals, own
commissions — enforced server-side); six inventory types with type filter;
"For Sale" listings straight into inventory; owner/seller card on property
detail with link/unlink; payment hierarchy Token → Bayana → Installments
(optional) → Final (auto-computed remainder); admin-only manual commission
override (audit-logged); role-specific dashboards (admin full totals, manager
team view without money totals, agent own numbers only); login attempts
(success and failure) in the audit log, admin-only to view.

**v1.2 — shipped:** rental listings ("For Rent" with rent per month, shown
as Rs X / month; listing filter composes with type/status; search price
filters use the effective price); RENT lead intent; rental deals (deal value
= first month's rent, bayana 0, manual commission via half/full-month picks
or a free amount, audit-logged); simplified two-stage rental payment plans
(advance → final first month's rent, no bayana/installments); 'Rented'
terminal property status on closed rental deals; commissions-first
dashboards (admin Total/Pending commission, manager commission counts with
no money, agent My Total/Pending commission) and a Quick Add bar on the
dashboard that opens each section's add form.

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

The Turso/Vercel migration was verified the same way against a fresh local
libSQL file database, plus: seed via a single write transaction, upload with
and without a (fake) Blob token (Blob failure falls back to database storage
with `storage: "db"`; files over 5 MB get 413 on the database path),
`api/index.js` importing cleanly as the serverless entry, and `vite build`
passing with zero errors. Live Turso + Vercel behaviour is untested until
first deploy (no deployment was done as part of this migration).
