// Document uploads (multer) — files stored under server/uploads/.

import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid } from '../util.js';

const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    cb(null, `${uid()}-${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router = Router();
router.use(requireAuth, requirePermission('crm'));

// GET /api/documents?entityType=&entityId=
router.get('/', ah(async (req, res) => {
  const { entityType, entityId } = req.query;
  const where = [];
  const params = [];
  if (entityType) { where.push('d.entity_type = ?'); params.push(entityType); }
  if (entityId) { where.push('d.entity_id = ?'); params.push(entityId); }
  const sql = `SELECT d.*, u.name AS uploaded_by_name FROM documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.created_at DESC`;
  res.json(db.prepare(sql).all(...params).map(camel));
}));

// POST /api/documents — multipart (file, entityType, entityId)
router.post('/', upload.single('file'), ah(async (req, res) => {
  const { entityType, entityId } = req.body || {};
  if (!req.file) throw httpError(400, 'A file is required (field name "file").');
  if (!entityType || !entityId) {
    fs.unlink(req.file.path, () => {});
    throw httpError(400, 'entityType and entityId are required.');
  }
  const id = uid();
  db.prepare(`INSERT INTO documents (id, entity_type, entity_id, filename, original_name, mime, size, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, entityType, entityId, req.file.filename, req.file.originalname,
      req.file.mimetype || '', req.file.size || 0, req.user.sub);
  auditReq(req, 'DOCUMENT_UPLOAD', { entityType, entityId, details: `Uploaded ${req.file.originalname} (${req.file.size} bytes).` });
  res.status(201).json(camel(db.prepare('SELECT * FROM documents WHERE id = ?').get(id)));
}));

// GET /api/documents/:id/download
router.get('/:id/download', ah(async (req, res) => {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Document not found.');
  const filePath = path.join(UPLOAD_DIR, row.filename);
  if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) {
    throw httpError(404, 'File is missing from storage.');
  }
  res.download(filePath, row.original_name);
}));

// DELETE /api/documents/:id
router.delete('/:id', ah(async (req, res) => {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Document not found.');
  const filePath = path.join(UPLOAD_DIR, row.filename);
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  if (filePath.startsWith(UPLOAD_DIR)) fs.unlink(filePath, () => {});
  auditReq(req, 'DOCUMENT_DELETE', { entityType: row.entity_type, entityId: row.entity_id, details: `Deleted document ${row.original_name}.` });
  res.json({ ok: true });
}));

export default router;
