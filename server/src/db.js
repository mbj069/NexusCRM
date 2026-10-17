// ------------------------------------------------------------------
// SQLite database + schema using Node's built-in node:sqlite (no native
// dependencies). Money is stored as REAL in PKR; ids are TEXT uuids.
// ------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/nexuscrm.db';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function initSchema() {
  db.exec(`
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
  db.prepare('INSERT OR IGNORE INTO ai_config (id) VALUES (1)').run();
  db.prepare('INSERT OR IGNORE INTO whatsapp_config (id) VALUES (1)').run();
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
