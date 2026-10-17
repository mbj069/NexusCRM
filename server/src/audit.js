// Server-side audit writer. Append-only — no update/delete path exists.

import { db } from './db.js';

const insert = db.prepare(`
  INSERT INTO audit_log (actor_id, actor_name, role, action, entity_type, entity_id, details)
  VALUES (@actor_id, @actor_name, @role, @action, @entity_type, @entity_id, @details)
`);

export function audit({ actorId = '', actorName = '', role = '', action, entityType = null, entityId = null, details = '' }) {
  try {
    insert.run({
      actor_id: actorId,
      actor_name: actorName,
      role,
      action,
      entity_type: entityType,
      entity_id: entityId,
      details,
    });
  } catch (e) {
    console.error('audit write failed:', e.message);
  }
}

/** Convenience: build an audit entry from the authenticated request. */
export function auditReq(req, action, { entityType = null, entityId = null, details = '' } = {}) {
  audit({
    actorId: req.user?.sub || '',
    actorName: req.user?.name || '',
    role: req.user?.role || '',
    action,
    entityType,
    entityId,
    details,
  });
}
