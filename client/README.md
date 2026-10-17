# NexusCRM — Frontend

Vite + React frontend for NexusCRM v1 (generic CRM with a property-dealer module).
Hand-rolled CSS design system (slate/indigo), React Router, no UI framework.

## Development

```bash
npm install
npm run dev        # serves on http://localhost:5173
```

The dev server proxies `/api/*` to the Express backend at `http://localhost:4000`
(see `vite.config.js`). The backend must be running for any data to load.

## Production build

```bash
npm run build      # outputs to dist/
```

## How it works

- `src/api.js` — fetch wrapper. Attaches `Authorization: Bearer <token>` from
  `localStorage` to every request. No secrets are stored client-side beyond the
  session JWT; AI keys and WhatsApp tokens are typed into Settings forms and
  sent straight to the server.
- `src/auth.jsx` — auth context (login, logout, force-change-password on first
  login, role helpers). Routes are guarded; `/settings` requires manager/admin.
- `src/components/` — `Layout.jsx` (sidebar, topbar, notifications bell),
  `ui.jsx` (badges, cards, tables, modals, PKR/date formatters, wa.me links),
  `DealModal.jsx` (shared create-deal dialog used from leads and inventory).
- `src/pages/` — Login, Dashboard, Leads, Contacts, Inventory, Deals, Payments
  (plans + receipts + contact ledgers), Commissions, Followups, Settings
  (AI / WhatsApp / Users / Audit tabs).

## Conventions

- All money renders as `PKR 8,500,000` via the `pkr()` helper.
- Area renders as e.g. `5 marla`, `1 kanal`, `250 sqft`.
- Record IDs are UUID strings — never coerce them with `Number()`.
- WhatsApp click-to-chat uses `https://wa.me/<digits>?text=…` (digits only).
- Product name is "NexusCRM" throughout; no AI attribution, no invented copy.

## Seed accounts (backend)

- `admin@nexuscrm.local` / `changeme123` (must change on first login)
- `manager@nexuscrm.local` / `manager123`
- `agent@nexuscrm.local` / `agent123`
