// Server-side audit writer. Append-only — no update/delete path exists.
//
// audit() is async-safe: outside a transaction it fires the insert and
// returns immediately (failures are logged, never thrown, so a logging
// failure can never fail the request it describes). Pass a transaction
// db object as the second argument to write the entry inside that
// transaction — the caller MUST await the returned promise in that case,
// so the audit row commits or rolls back atomically with the rest.

import { db } from './db.js';

const INSERT_SQL = `
  INSERT INTO audit_log (actor_id, actor_name, role, action, entity_type, entity_id, details)
  VALUES (@actor_id, @actor_name, @role, @action, @entity_type, @entity_id, @details)
`;

export function audit({ actorId = '', actorName = '', role = '', action, entityType = null, entityId = null, details = '' }, dbOverride) {
  const target = dbOverride || db;
  const p = target.prepare(INSERT_SQL).run({
    actor_id: actorId,
    actor_name: actorName,
    role,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details,
  });
  if (dbOverride) return p; // inside a transaction: caller awaits, so a failure rolls back
  p.catch((e) => console.error('audit write failed:', e.message));
  return p;
}

/** Convenience: build an audit entry from the authenticated request. */
export function auditReq(req, action, { entityType = null, entityId = null, details = '' } = {}, dbOverride) {
  return audit({
    actorId: req.user?.sub || '',
    actorName: req.user?.name || '',
    role: req.user?.role || '',
    action,
    entityType,
    entityId,
    details,
  }, dbOverride);
}
