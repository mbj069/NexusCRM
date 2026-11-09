// Document uploads.
//
// Storage is persistent on every host — the old disk storage under
// server/uploads/ does not survive on Vercel (ephemeral filesystem), so:
//   - BLOB_READ_WRITE_TOKEN set  -> file goes to Vercel Blob (`put`); the
//     public URL is stored in documents.url. If the Blob upload fails
//     (bad token, network), the upload falls back to database storage
//     instead of failing or pretending — the stored row says which
//     backend actually holds the bytes (see `storage` in responses).
//   - Otherwise                  -> file bytes are stored in the database
//     (documents.data BLOB, capped at 5 MB — larger files get 413).
// Download serves from the Blob URL (redirect) or the DB bytes.
// Rows created before this change (disk-era, no url and no data) still
// resolve from the legacy uploads/ directory when the file is there.

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

// Legacy disk location (pre-migration rows only; new uploads never land here).
const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');

const MAX_FILE_BYTES = 25 * 1024 * 1024; // multer limit, unchanged
const MAX_DB_BYTES = 5 * 1024 * 1024; // database-stored files cap

// Memory storage: nothing touches the (possibly ephemeral) disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

const router = Router();
router.use(requireAuth, requirePermission('crm'));

const isAgent = (req) => req.user.role === 'agent';

// Agents may only touch documents on entities they can see: their assigned
// leads, their own deals, contacts linked to their own leads/deals.
// Properties are browseable by every role, so their documents are too.
async function assertEntityVisible(req, entityType, entityId) {
  if (!isAgent(req)) return;
  const me = req.user.sub;
  if (entityType === 'property') return;
  if (entityType === 'lead') {
    const row = await db.prepare('SELECT assigned_to FROM leads WHERE id = ?').get(entityId);
    if (!row || row.assigned_to !== me) throw httpError(403, 'Lead not assigned to you.');
  } else if (entityType === 'deal') {
    const row = await db.prepare('SELECT agent_id FROM deals WHERE id = ?').get(entityId);
    if (!row || row.agent_id !== me) throw httpError(403, 'Deal not assigned to you.');
  } else if (entityType === 'contact') {
    const row = await db.prepare(`SELECT id FROM contacts WHERE id = ? AND (
        id IN (SELECT contact_id FROM leads WHERE assigned_to = ?)
        OR id IN (SELECT l.contact_id FROM leads l JOIN deals d ON d.lead_id = l.id WHERE d.agent_id = ?)
        OR id IN (SELECT pp.contact_id FROM payment_plans pp JOIN deals d ON d.id = pp.deal_id WHERE d.agent_id = ?))`)
      .get(entityId, me, me, me);
    if (!row) throw httpError(403, 'Contact not linked to your leads or deals.');
  }
}

/** Public shape of a document row — never leaks the stored bytes. */
function mapDocument(row) {
  if (!row) return null;
  const d = camel(row);
  delete d.data;
  delete d.hasData; // internal list-query flag, not part of the API shape
  d.storage = row.url ? 'blob' : row.data ? 'db' : 'legacy';
  return d;
}

/** Store the buffer; returns { url, data } for the documents row. */
async function storeFile(filename, buffer, mime) {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  if (token) {
    try {
      const { put } = await import('@vercel/blob');
      const blob = await put(`documents/${filename}`, buffer, {
        access: 'public',
        contentType: mime || 'application/octet-stream',
        token,
      });
      return { url: blob.url, data: null };
    } catch (e) {
      // Blob is unavailable (bad token, network) — fall through to the
      // database instead of losing the upload. The row records storage=db,
      // so nothing pretends the file is in Blob.
      console.error('Vercel Blob upload failed, storing file in database instead:', e.message);
    }
  }
  if (buffer.length > MAX_DB_BYTES) {
    throw httpError(413, 'File exceeds the 5 MB limit for database storage. Set BLOB_READ_WRITE_TOKEN to allow larger files (up to 25 MB).');
  }
  return { url: null, data: buffer };
}

// GET /api/documents?entityType=&entityId=
router.get('/', ah(async (req, res) => {
  const { entityType, entityId } = req.query;
  const where = [];
  const params = [];
  if (entityType) { where.push('d.entity_type = ?'); params.push(entityType); }
  if (entityId) { where.push('d.entity_id = ?'); params.push(entityId); }
  if (isAgent(req)) {
    if (entityType && entityId) {
      await assertEntityVisible(req, entityType, entityId);
    } else {
      // No entity filter: restrict to the agent's own entities.
      where.push(`(d.entity_type = 'property'
        OR (d.entity_type = 'lead' AND d.entity_id IN (SELECT id FROM leads WHERE assigned_to = ?))
        OR (d.entity_type = 'deal' AND d.entity_id IN (SELECT id FROM deals WHERE agent_id = ?))
        OR (d.entity_type = 'contact' AND d.entity_id IN (SELECT contact_id FROM leads WHERE assigned_to = ?))
        OR (d.entity_type = 'contact' AND d.entity_id IN (SELECT pp.contact_id FROM payment_plans pp JOIN deals d ON d.id = pp.deal_id WHERE d.agent_id = ?)))`);
      params.push(req.user.sub, req.user.sub, req.user.sub, req.user.sub);
    }
  }
  const sql = `SELECT d.id, d.entity_type, d.entity_id, d.filename, d.original_name, d.mime,
      d.size, d.uploaded_by, d.created_at, d.url,
      CASE WHEN d.data IS NOT NULL THEN 1 ELSE 0 END AS has_data,
      u.name AS uploaded_by_name FROM documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.created_at DESC`;
  const rows = await db.prepare(sql).all(...params);
  res.json(rows.map((r) => mapDocument({ ...r, data: r.has_data ? true : null })));
}));

// POST /api/documents — multipart (file, entityType, entityId)
router.post('/', upload.single('file'), ah(async (req, res) => {
  const { entityType, entityId } = req.body || {};
  if (!req.file) throw httpError(400, 'A file is required (field name "file").');
  if (!entityType || !entityId) {
    throw httpError(400, 'entityType and entityId are required.');
  }
  await assertEntityVisible(req, entityType, entityId);
  const safe = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
  const filename = `${uid()}-${safe}`;
  const stored = await storeFile(filename, req.file.buffer, req.file.mimetype);
  const id = uid();
  await db.prepare(`INSERT INTO documents (id, entity_type, entity_id, filename, original_name, mime, size, uploaded_by, url, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, entityType, entityId, filename, req.file.originalname,
      req.file.mimetype || '', req.file.size || 0, req.user.sub, stored.url, stored.data);
  auditReq(req, 'DOCUMENT_UPLOAD', { entityType, entityId, details: `Uploaded ${req.file.originalname} (${req.file.size} bytes, storage: ${stored.url ? 'blob' : 'db'}).` });
  const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  res.status(201).json(mapDocument(row));
}));

// GET /api/documents/:id/download
router.get('/:id/download', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Document not found.');
  await assertEntityVisible(req, row.entity_type, row.entity_id);
  if (row.url) return res.redirect(row.url);
  if (row.data) {
    const bytes = Buffer.from(row.data);
    res.type(row.mime || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${String(row.original_name).replace(/"/g, '')}"`);
    return res.send(bytes);
  }
  // Legacy disk-era row: serve from uploads/ if the file is still there.
  const filePath = path.join(UPLOAD_DIR, row.filename);
  if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) {
    throw httpError(404, 'File is missing from storage.');
  }
  res.download(filePath, row.original_name);
}));

// DELETE /api/documents/:id
router.delete('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Document not found.');
  await assertEntityVisible(req, row.entity_type, row.entity_id);
  await db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  if (row.url) {
    // Best-effort Blob cleanup; the row is already gone, so a Blob
    // failure here must not fail the delete.
    try {
      const { del } = await import('@vercel/blob');
      await del(row.url, { token: process.env.BLOB_READ_WRITE_TOKEN || undefined });
    } catch (e) {
      console.error('Vercel Blob delete failed (row already deleted):', e.message);
    }
  } else if (!row.data) {
    // Legacy disk-era row: remove the file if it is still on disk.
    const filePath = path.join(UPLOAD_DIR, row.filename);
    if (filePath.startsWith(UPLOAD_DIR)) fs.unlink(filePath, () => {});
  }
  auditReq(req, 'DOCUMENT_DELETE', { entityType: row.entity_type, entityId: row.entity_id, details: `Deleted document ${row.original_name}.` });
  res.json({ ok: true });
}));

export default router;
