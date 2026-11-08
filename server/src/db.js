// ------------------------------------------------------------------
// Database layer: Turso (libSQL) with a local-file fallback.
//
// The rest of the server talks to `db` through the same call shape the
// previous local-only layer had, but async:
//
//   db.prepare(sql) -> { run(...args), get(...args), all(...args) }
//     run() -> Promise<{ changes, lastInsertRowid }>
//     get() -> Promise<row | null>        (first row, or null)
//     all() -> Promise<row[]>             (plain objects keyed by column)
//   db.exec(sql)    -> Promise<void>      (multi-statement schema only)
//   withTransaction(fn) -> runs fn(txDb) inside BEGIN IMMEDIATE;
//     commits on success, rolls back and rethrows on error.
//
// Parameters: `?` positional args, or `@name` named params passed as a
// single object ({ name: value } — the `@` is stripped). libsql accepts
// bare keys for `@name` placeholders, so named args pass through as-is.
//
// Backend selection (decided once at import):
//   TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) set -> remote Turso database.
//   Otherwise -> local libSQL file at DB_PATH (default ./data/nexuscrm.db),
//   which keeps local development working exactly as before.
// On Vercel the Turso vars are required: a local file would not persist
// across serverless invocations, so a missing TURSO_DATABASE_URL there
// fails loudly at import instead of silently losing data.
// ------------------------------------------------------------------

import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const isRemote = !!TURSO_URL;

if (process.env.VERCEL && !isRemote) {
  throw new Error('TURSO_DATABASE_URL is required on Vercel (local SQLite files do not persist in serverless functions).');
}

let client;
if (isRemote) {
  client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined });
} else {
  const DB_PATH = process.env.DB_PATH || './data/nexuscrm.db';
  const resolved = path.resolve(DB_PATH);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  client = createClient({ url: `file:${resolved}` });
}

// --- Value normalization -----------------------------------------------------
// libsql returns INTEGERs as numbers in the normal range, but lastInsertRowid
// (and out-of-range integers) arrive as bigint, which JSON.stringify rejects
// and which breaks arithmetic. Normalize bigints to numbers. BLOBs arrive as
// ArrayBuffer and are passed through untouched.

function plainValue(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

function plainRow(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = plainValue(v);
  return out;
}

function normalizeArg(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// Accepts: no args, positional values, or a single object for @name params.
function normalizeArgs(sql, args) {
  if (args.length === 0) return { sql, args: [] };
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !ArrayBuffer.isView(args[0]) && !Buffer.isBuffer(args[0])) {
    return { sql, args: args[0] };
  }
  return { sql, args: args.map(normalizeArg) };
}

// A statement bound to one executor (the shared client, or one transaction).
// prepare() itself is synchronous (it only builds the statement object);
// run/get/all are async and do the actual I/O.
function makeStatement(executor, sql) {
  return {
    async run(...args) {
      const { sql: s, args: a } = normalizeArgs(sql, args);
      const r = await executor.execute({ sql: s, args: a });
      return { changes: r.rowsAffected ?? 0, lastInsertRowid: plainValue(r.lastInsertRowid) };
    },
    async get(...args) {
      const { sql: s, args: a } = normalizeArgs(sql, args);
      const r = await executor.execute({ sql: s, args: a });
      return r.rows.length ? plainRow(r.rows[0]) : null;
    },
    async all(...args) {
      const { sql: s, args: a } = normalizeArgs(sql, args);
      const r = await executor.execute({ sql: s, args: a });
      return r.rows.map(plainRow);
    },
  };
}

function makeDb(executor) {
  return {
    prepare: (sql) => makeStatement(executor, sql),
    // Multi-statement SQL only (schema). Never route BEGIN/COMMIT/ROLLBACK
    // through exec — use withTransaction() for that.
    exec: async (sql) => {
      await executor.executeMultiple(sql);
    },
  };
}

export const db = makeDb(client);

/** Run fn(txDb) inside a write transaction (BEGIN IMMEDIATE in libsql). */
export async function withTransaction(fn) {
  const tx = await client.transaction('write');
  try {
    const result = await fn(makeDb(tx));
    await tx.commit();
    return result;
  } catch (e) {
    try { await tx.rollback(); } catch { /* already rolled back */ }
    throw e;
  }
}

export async function initSchema() {
  // WAL is a local-file optimisation and is rejected by remote databases.
  if (!isRemote) {
    await client.execute('PRAGMA journal_mode = WAL');
  }
  // Foreign-key enforcement. Attempted on remote too, but a remote that
  // rejects the pragma must not break startup.
  try {
    await client.execute('PRAGMA foreign_keys = ON');
  } catch (e) {
    console.error('PRAGMA foreign_keys = ON was rejected (continuing):', e.message);
  }

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','manager','agent')),
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      whatsapp TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'buyer' CHECK (type IN ('buyer','seller')),
      source TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      owner_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      whatsapp TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('website','WhatsApp','social','manual','referral')),
      interest TEXT NOT NULL DEFAULT '',
      budget_min REAL NOT NULL DEFAULT 0,
      budget_max REAL NOT NULL DEFAULT 0,
      stage TEXT NOT NULL DEFAULT 'new'
        CHECK (stage IN ('new','contacted','viewing','negotiating','won','lost')),
      score INTEGER NOT NULL DEFAULT 0,
      ai_score REAL,
      ai_score_reason TEXT NOT NULL DEFAULT '',
      owner_id TEXT REFERENCES users(id),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
    CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('lead','contact','deal')),
      entity_id TEXT NOT NULL,
      actor_id TEXT REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('note','call','viewing','message','stage_change')),
      text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS followups (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      title TEXT NOT NULL,
      due_date TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      owner_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_followups_owner ON followups(owner_id);
    CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(due_date);

    CREATE TABLE IF NOT EXISTS properties (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('plot','residential','commercial')),
      title TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      area_value REAL NOT NULL DEFAULT 0,
      area_unit TEXT NOT NULL DEFAULT 'marla' CHECK (area_unit IN ('marla','kanal','sqft')),
      price REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Available'
        CHECK (status IN ('Available','Booked','Sold','Blocked')),
      description TEXT NOT NULL DEFAULT '',
      owner_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_properties_status ON properties(status);
    CREATE INDEX IF NOT EXISTS idx_properties_code ON properties(code);

    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
      property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES users(id),
      stage TEXT NOT NULL DEFAULT 'proposed'
        CHECK (stage IN ('proposed','token_paid','in_progress','closed_won','closed_lost','cancelled')),
      deal_value REAL NOT NULL DEFAULT 0,
      bayana_amount REAL NOT NULL DEFAULT 0,
      commission_type TEXT NOT NULL DEFAULT 'percent' CHECK (commission_type IN ('percent','fixed')),
      commission_value REAL NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
    CREATE INDEX IF NOT EXISTS idx_deals_agent ON deals(agent_id);

    CREATE TABLE IF NOT EXISTS payment_plans (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      total_amount REAL NOT NULL DEFAULT 0,
      down_payment REAL NOT NULL DEFAULT 0,
      possession_amount REAL NOT NULL DEFAULT 0,
      num_installments INTEGER NOT NULL DEFAULT 0,
      installment_amount REAL NOT NULL DEFAULT 0,
      start_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_schedule (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      kind TEXT NOT NULL CHECK (kind IN ('down_payment','installment','possession')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
      paid_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_plan ON payment_schedule(plan_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_due ON payment_schedule(due_date, status);

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
      schedule_id TEXT NOT NULL REFERENCES payment_schedule(id),
      amount REAL NOT NULL DEFAULT 0,
      method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','bank','transfer')),
      received_by TEXT REFERENCES users(id),
      receipt_no TEXT UNIQUE NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payments_plan ON payments(plan_id);
    CREATE INDEX IF NOT EXISTS idx_payments_schedule ON payments(schedule_id);

    -- Named counters, e.g. receipt_2026 -> next receipt sequence number.
    CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      next INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS commissions (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES users(id),
      amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_commissions_agent ON commissions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status);

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      uploaded_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      kind TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

    -- Single-row AI provider config (id = 1). An admin-set key here
    -- overrides the AI_API_KEY env var (encrypt at rest in production).
    CREATE TABLE IF NOT EXISTS ai_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      base_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Single-row WhatsApp Cloud API config (id = 1).
    CREATE TABLE IF NOT EXISTS whatsapp_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      phone_number_id TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL DEFAULT '',
      verify_token TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Append-only audit trail. No UPDATE/DELETE path exists for this table.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      actor_id TEXT NOT NULL DEFAULT '',
      actor_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
  `);

  // Upload storage columns (added idempotently for databases created
  // before this migration). `url` = Vercel Blob public URL when Blob is
  // configured; `data` = raw file bytes when stored in the database.
  const cols = await db.prepare('PRAGMA table_info(documents)').all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('data')) {
    await db.exec('ALTER TABLE documents ADD COLUMN data BLOB');
  }
  if (!names.has('url')) {
    await db.exec('ALTER TABLE documents ADD COLUMN url TEXT');
  }

  await db.prepare('INSERT OR IGNORE INTO ai_config (id) VALUES (1)').run();
  await db.prepare('INSERT OR IGNORE INTO whatsapp_config (id) VALUES (1)').run();
}

// --- Row mappers (snake_case -> camelCase) ----------------------------------

/** Convert a row's snake_case keys to camelCase. */
export function camel(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

/** User row minus the password hash, with camelCase keys. */
export function mapUser(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  const u = camel(rest);
  u.mustChangePassword = !!u.mustChangePassword;
  return u;
}
