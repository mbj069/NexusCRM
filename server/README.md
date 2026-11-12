# NexusCRM Server

Backend API for NexusCRM — a generic CRM with a property-dealer module
(inventory, deals, payment plans, receipts, commissions, ledgers).

Stack: Node ≥ 22.5, Express 4, Turso (libSQL) via `@libsql/client` —
remote Turso when `TURSO_DATABASE_URL` is set, otherwise a local libSQL
file (same behaviour as before, no separate setup) — `bcryptjs`,
`jsonwebtoken`, `cors`, `dotenv`, `multer` (memory storage), `@vercel/blob`
for uploads when configured.

## Setup

```bash
npm install
cp .env.example .env   # then fill in JWT_SECRET and any provider keys
npm run seed           # wipe-and-seed demo data (safe to re-run)
npm run dev            # watch mode, or: npm start
```

The API listens on `PORT` (default `4000`).

## Demo credentials (seeded)

| Role    | Username                | Password     |
| ------- | ----------------------- | ------------ |
| admin   | admin@nexuscrm.local    | changeme123  |
| manager | manager@nexuscrm.local  | manager123   |
| agent   | agent@nexuscrm.local    | agent123     |

The admin account is flagged `mustChangePassword` — change it via
`POST /api/auth/change-password` after first login.

## Environment variables

| Variable                  | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `PORT`                    | HTTP port (default `4000`)                                     |
| `JWT_SECRET`              | Secret for signing auth tokens — set a long random value       |
| `JWT_EXPIRES_IN`          | Token lifetime, e.g. `8h` (default `8h`)                       |
| `DB_PATH`                 | Local libSQL file (default `./data/nexuscrm.db`) — used only when `TURSO_DATABASE_URL` is unset |
| `TURSO_DATABASE_URL`      | Turso database URL (`libsql://…`), e.g. from `turso db create`. **Required on Vercel** — local files do not persist in serverless functions |
| `TURSO_AUTH_TOKEN`        | Turso auth token (`turso db tokens create <db>`) |
| `BLOB_READ_WRITE_TOKEN`   | Vercel Blob token (optional). When set, uploads go to Blob; otherwise file bytes are stored in the database (5 MB cap per file) |
| `AI_PROVIDER_URL`         | OpenAI-compatible base URL (default `https://api.openai.com/v1`) |
| `AI_API_KEY`              | Provider key; an admin-set DB key overrides it                 |
| `AI_MODEL`                | Default model (default `gpt-4o-mini`)                          |
| `WHATSAPP_PHONE_NUMBER_ID`| Meta WhatsApp Cloud API phone number ID                        |
| `WHATSAPP_TOKEN`          | Meta system-user access token                                  |
| `WHATSAPP_VERIFY_TOKEN`   | Token that must match the Meta webhook verify token            |

Secrets live only in the environment (or the admin-configured DB rows);
never hardcode them.

## Roles

- **admin** — everything: users, AI config, WhatsApp config, audit log, all CRM data.
- **manager** — all CRM/inventory/deals/payments/documents CRUD, audit log,
  commissions view-only, expenses read-only. No user management, AI config,
  WhatsApp config, commission payouts, or expense writes.
- **agent** — same CRM CRUD as manager; commissions list is scoped to the
  agent's own rows and shows only their share figures (no owner totals);
  no audit log, no commission payouts, no expenses.

## API overview

All routes are under `/api` and require a `Bearer` token except
`POST /api/auth/login` and the WhatsApp webhook. Errors look like
`{ "error": "message" }`.

| Method & path                              | Description                                         |
| ------------------------------------------ | --------------------------------------------------- |
| `POST /api/auth/login`                     | Login → `{ token, user }`                           |
| `POST /api/auth/change-password`           | Change own password                                 |
| `GET/POST /api/users`                      | List / create users (admin)                         |
| `PUT/DELETE /api/users/:id`                | Update / delete user (admin)                        |
| `GET/POST /api/contacts`                   | List (`?q=`) / create contacts                       |
| `GET/PUT/DELETE /api/contacts/:id`         | Contact detail / update / delete                    |
| `GET/POST /api/leads`                      | List (`?stage=&q=`) / create leads                  |
| `GET/PUT/DELETE /api/leads/:id`            | Lead detail (with contact, activities, follow-ups)  |
| `POST /api/leads/:id/stage`                | Move lead pipeline stage                            |
| `POST /api/leads/:id/score`                | Rules-based score (stored on the lead)              |
| `GET /api/activities/:entityType/:entityId`| Timeline entries                                    |
| `POST /api/activities`                     | Add activity                                        |
| `GET/POST /api/followups`                  | List (`?overdue=1&mine=1`) / create                 |
| `PUT/DELETE /api/followups/:id`            | Update / delete follow-up                           |
| `GET/POST /api/properties`                 | List (`?status=&type=&q=`) / create                 |
| `GET /api/properties/search`               | Filtered inventory search (defaults to Available)   |
| `GET/PUT/DELETE /api/properties/:id`       | Property detail / update / delete                   |
| `POST /api/properties/:id/status`          | Available ↔ Blocked (Sold is terminal)              |
| `GET /api/properties/:id/transactions`     | Deals + payments for a property                     |
| `GET/POST /api/deals`                      | List (`?stage=&agentId=`) / create (books property, transactional; 409 on double-booking) |
| `GET /api/deals/:id`                       | Deal with lead, property, plans, payments           |
| `PUT /api/deals/:id`                       | Update deal terms                                   |
| `POST /api/deals/:id/stage`                | Stage move; `closed_won` → Sold, `closed_lost`/`cancelled` → release |
| `POST /api/plans`                          | Create plan + schedule (total must match deal value) |
| `GET /api/plans?dealId=` / `GET /api/plans/:id` | List / detail with schedule + payments         |
| `POST /api/payments`                       | Record payment (auto receipt no., marks schedule paid when covered) |
| `GET /api/payments?planId=`                | List payments                                       |
| `GET /api/receipts/:paymentId`             | Receipt JSON                                        |
| `GET /api/receipts/:paymentId/html`        | Printable HTML receipt                              |
| `GET /api/ledgers/:contactId`              | Client ledger: plans, schedule, totals              |
| `GET /api/commissions`                     | Commissions (`?agentId=&status=&from=&to=`; agents see own rows and only their share figures — owner `summary` omitted, `agentSummary` only) |
| `PUT /api/commissions/:id`                 | Manual override (admin): owner `amount`/`status`, and/or agent `agentAmount`/`agentStatus` |
| `POST /api/commissions/:id/pay`            | Mark the OWNER's commission received (admin; agent share untouched) |
| `POST /api/commissions/:id/pay-agent-share`| Mark only the agent share paid (admin; owner total untouched) |
| `GET /api/expenses?category=&from=&to=`    | List expenses + `{ total, byCategory }` (admin/manager) |
| `POST /api/expenses`                       | Record an expense (admin)                  |
| `GET /api/expenses/:id`                    | Expense detail (admin/manager)             |
| `PUT/DELETE /api/expenses/:id`             | Update / delete expense (admin)            |
| `GET/POST /api/documents`                  | List (`?entityType=&entityId=`) / upload (multipart) |
| `GET /api/documents/:id/download`          | Download file                                       |
| `DELETE /api/documents/:id`                | Delete document                                     |
| `POST /api/ai/score-lead`                  | AI lead score `{ leadId }` → stored on lead         |
| `POST /api/ai/summarize`                   | `{ kind: 'lead'|'overdue', id? }` → `{ summary }`   |
| `GET/PUT /api/ai/config`                   | Provider config (admin; key never returned)         |
| `POST /api/ai/test`                        | Provider connectivity check (admin)                 |
| `GET/POST /api/webhooks/whatsapp`          | Meta verification handshake + inbound events        |
| `GET/PUT /api/whatsapp/config`             | WhatsApp Cloud API config (admin; token never returned) |
| `POST /api/whatsapp/send-test`             | Real send when configured, honest dry-run otherwise (admin) |
| `GET /api/dashboard`                       | Commission totals + active leads + 6-month trend, pipeline, inventory — scoped per role (admin: owner money; manager: counts only; agent: own share only) |
| `GET /api/notifications`                   | Own + broadcast notifications                       |
| `POST /api/notifications/:id/read`         | Mark read                                           |
| `POST /api/notifications/scan-overdue`     | Create broadcast notifications for overdue installments |
| `GET /api/audit`                           | Audit log (`?limit=&entityType=&entityId=&action=`, admin/manager) |

### Notes

- **Commissions: owner vs agent share.** Every commission row tracks two
  independent amounts. `amount` + `status`/`paid_at` is the OWNER's total
  commission and whether the owner has received it; `agentAmount` +
  `agentStatus`/`agentPaidAt` is the agent's share of that total and
  whether the owner has paid it to the agent. Marking the owner paid
  (`POST /:id/pay`) never touches the share, and paying the share
  (`POST /:id/pay-agent-share`) never touches the owner total. Deal
  creation accepts `agentShareAmount` (wins) or `agentSharePercent`
  (server computes the amount from the total; only the amount is stored).
  Term edits (`PUT /api/deals/:id`) never touch the share — only the
  commission endpoints change it. Agents see only their own share figures
  (`agentSummary`); the owner `summary` is omitted for them entirely.
- **Leads are people looking to buy or rent.** `intent` is `buy` or
  `rent` only — `sell` is rejected (400). Old `sell` rows from before
  v1.3 stay in the database and remain readable under "All".
- **Expenses.** Office running costs (rent, utilities, marketing,
  salaries…). Reads need `view_expenses` (admin + manager); writes need
  `manage_expenses` (admin only); agents get 403 on every expenses
  endpoint. `recorded_by` is the creating user; creates/updates/deletes
  are audit-logged (`EXPENSE_CREATE` / `EXPENSE_UPDATE` / `EXPENSE_DELETE`).

- Deal creation runs in a write transaction (`withTransaction`, i.e.
  `BEGIN IMMEDIATE` … `COMMIT` in libSQL): the property row is
  re-checked inside the transaction, so two concurrent bookings of the same
  property cannot both succeed — the loser gets `409 { error: "Property is
  not available (current status: …)." }`.
- The audit log is append-only; there is no update/delete path for it.
  Audit writes inside a transaction use the transaction's connection, so
  they commit or roll back with it; outside transactions they are
  fire-and-forget and never fail a request.
- AI endpoints return `503 { error: "No AI provider API key configured.",
  code: "NO_API_KEY" }` when no key is set — they never crash.
- Uploaded files are stored in Vercel Blob when `BLOB_READ_WRITE_TOKEN`
  is set (public URL saved on the document row), otherwise as bytes in
  the database (`documents.data`, 5 MB cap — larger files get 413). If a
  Blob upload fails, the file falls back to database storage and the row
  records `storage: "db"`, so nothing pretends to be in Blob. Downloads
  redirect to the Blob URL or serve the database bytes. Rows from before
  this change (disk-era, no URL and no bytes) still resolve from the
  legacy `server/uploads/` directory when the file is there.
