// Audit log read API — admin and manager only. No write path exists here;
// entries are written server-side by the audit() helper.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ah } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('view_audit_log'));

// GET /api/audit?limit=100&entityType=&entityId=&action=
router.get('/', ah(async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const { entityType, entityId, action } = req.query;
  const where = [];
  const params = [];
  if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  if (action) { where.push('action = ?'); params.push(action); }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  res.json((await db.prepare(sql).all(...params, limit)).map(camel));
}));

export default router;
