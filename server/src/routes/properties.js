// Property inventory CRUD, status transitions, search, transactions,
// owner/seller linking.
//
// Note on ownership: `owner_id` is the staff user who owns the record;
// the owner/seller of the property itself is a contact, stored in
// `seller_contact_id` and shown on the property detail page.

import { Router } from 'express';
import { db, camel } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { auditReq } from '../audit.js';
import { ah, httpError, uid } from '../util.js';

const router = Router();
router.use(requireAuth, requirePermission('crm'));

const VALID_TYPES = ['plot', 'house', 'commercial_land', 'agriculture_land', 'shop', 'commercial_building'];
const VALID_STATUSES = ['Available', 'Booked', 'Sold', 'Blocked'];
const VALID_UNITS = ['marla', 'kanal', 'sqft'];
const VALID_LISTING_TYPES = ['sale'];

function filters(query) {
  const where = [];
  const params = [];
  const { status, type, q } = query;
  // Columns are qualified (p.) — the list query joins contacts, which also
  // has a `type` column.
  if (status) {
    if (!VALID_STATUSES.includes(status)) throw httpError(400, `Invalid status. Use one of: ${VALID_STATUSES.join(', ')}.`);
    where.push('p.status = ?'); params.push(status);
  }
  if (type) {
    if (!VALID_TYPES.includes(type)) throw httpError(400, `Invalid type. Use one of: ${VALID_TYPES.join(', ')}.`);
    where.push('p.type = ?'); params.push(type);
  }
  if (q?.trim()) {
    const like = `%${q.trim()}%`;
    where.push('(p.code LIKE ? OR p.title LIKE ? OR p.location LIKE ?)');
    params.push(like, like, like);
  }
  return { where, params };
}

async function sellerById(id) {
  if (!id) return null;
  return camel(await db.prepare('SELECT id, name, phone, whatsapp, email, type FROM contacts WHERE id = ?').get(id));
}

async function withSeller(row) {
  const prop = camel(row);
  prop.seller = await sellerById(row.seller_contact_id);
  return prop;
}

// GET /api/properties?status=&type=&q=
router.get('/', ah(async (req, res) => {
  const { where, params } = filters(req.query);
  const sql = `SELECT p.*, c.name AS seller_name FROM properties p
    LEFT JOIN contacts c ON c.id = p.seller_contact_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.code`;
  res.json((await db.prepare(sql).all(...params)).map(camel));
}));

// GET /api/properties/search?type=&location=&minPrice=&maxPrice=&minArea=&status=Available&q=
router.get('/search', ah(async (req, res) => {
  const { type, location, minPrice, maxPrice, minArea, status = 'Available', q } = req.query;
  const where = [];
  const params = [];
  if (status) {
    if (!VALID_STATUSES.includes(status)) throw httpError(400, 'Invalid status.');
    where.push('status = ?'); params.push(status);
  }
  if (type) {
    if (!VALID_TYPES.includes(type)) throw httpError(400, 'Invalid type.');
    where.push('type = ?'); params.push(type);
  }
  if (location?.trim()) { where.push('location LIKE ?'); params.push(`%${location.trim()}%`); }
  if (minPrice !== undefined && minPrice !== '') { where.push('price >= ?'); params.push(Number(minPrice)); }
  if (maxPrice !== undefined && maxPrice !== '') { where.push('price <= ?'); params.push(Number(maxPrice)); }
  if (minArea !== undefined && minArea !== '') { where.push('area_value >= ?'); params.push(Number(minArea)); }
  if (q?.trim()) {
    const like = `%${q.trim()}%`;
    where.push('(code LIKE ? OR title LIKE ? OR location LIKE ? OR description LIKE ?)');
    params.push(like, like, like, like);
  }
  const sql = `SELECT * FROM properties ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY price`;
  res.json((await db.prepare(sql).all(...params)).map(camel));
}));

// POST /api/properties — a property listed "For Sale" goes straight into
// inventory as Available.
router.post('/', ah(async (req, res) => {
  const { code, type, title, location = '', areaValue = 0, areaUnit = 'marla', price = 0,
    status = 'Available', description = '', ownerId, listingType = 'sale', sellerContactId = null } = req.body || {};
  if (!code?.trim()) throw httpError(400, 'Property code is required (e.g. PLT-001).');
  if (!title?.trim()) throw httpError(400, 'Title is required.');
  if (!VALID_TYPES.includes(type)) throw httpError(400, `Type must be one of: ${VALID_TYPES.join(', ')}.`);
  if (!VALID_UNITS.includes(areaUnit)) throw httpError(400, `Area unit must be one of: ${VALID_UNITS.join(', ')}.`);
  if (!VALID_LISTING_TYPES.includes(listingType)) throw httpError(400, `Listing type must be one of: ${VALID_LISTING_TYPES.join(', ')}.`);
  if (status !== 'Available') throw httpError(400, 'New properties must start as Available.');
  if (sellerContactId) {
    const c = await db.prepare('SELECT id FROM contacts WHERE id = ?').get(sellerContactId);
    if (!c) throw httpError(400, 'Seller contact not found.');
  }
  const exists = await db.prepare('SELECT id FROM properties WHERE code = ?').get(code.trim());
  if (exists) throw httpError(409, `Property code ${code.trim()} already exists.`);
  const id = uid();
  await db.prepare(`INSERT INTO properties (id, code, type, title, location, area_value, area_unit, price, status, description, owner_id, listing_type, seller_contact_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Available', ?, ?, ?, ?)`)
    .run(id, code.trim(), type, title.trim(), String(location).trim(), Number(areaValue) || 0,
      areaUnit, Number(price) || 0, String(description), ownerId || req.user.sub, listingType, sellerContactId);
  auditReq(req, 'PROPERTY_CREATE', { entityType: 'property', entityId: id, details: `Created property ${code.trim()} — ${title.trim()} (for sale, Available).` });
  res.status(201).json(await withSeller(await db.prepare('SELECT * FROM properties WHERE id = ?').get(id)));
}));

// GET /api/properties/:id — includes the linked owner/seller card
router.get('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Property not found.');
  res.json(await withSeller(row));
}));

// PUT /api/properties/:id (details only — status changes go through /status)
router.put('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Property not found.');
  const { code, type, title, location, areaValue, areaUnit, price, description, ownerId, listingType, sellerContactId } = req.body || {};
  if (code !== undefined && String(code).trim() !== row.code) {
    const dup = await db.prepare('SELECT id FROM properties WHERE code = ? AND id != ?').get(String(code).trim(), req.params.id);
    if (dup) throw httpError(409, `Property code ${String(code).trim()} already exists.`);
  }
  if (type !== undefined && !VALID_TYPES.includes(type)) throw httpError(400, `Type must be one of: ${VALID_TYPES.join(', ')}.`);
  if (areaUnit !== undefined && !VALID_UNITS.includes(areaUnit)) throw httpError(400, `Area unit must be one of: ${VALID_UNITS.join(', ')}.`);
  if (listingType !== undefined && !VALID_LISTING_TYPES.includes(listingType)) throw httpError(400, `Listing type must be one of: ${VALID_LISTING_TYPES.join(', ')}.`);
  if (sellerContactId !== undefined && sellerContactId !== null) {
    const c = await db.prepare('SELECT id FROM contacts WHERE id = ?').get(sellerContactId);
    if (!c) throw httpError(400, 'Seller contact not found.');
  }
  await db.prepare(`UPDATE properties SET code = COALESCE(?, code), type = COALESCE(?, type),
    title = COALESCE(?, title), location = COALESCE(?, location),
    area_value = COALESCE(?, area_value), area_unit = COALESCE(?, area_unit),
    price = COALESCE(?, price), description = COALESCE(?, description),
    owner_id = COALESCE(?, owner_id), listing_type = COALESCE(?, listing_type),
    seller_contact_id = CASE WHEN ? THEN ? ELSE seller_contact_id END,
    updated_at = datetime('now') WHERE id = ?`)
    .run(
      code !== undefined ? String(code).trim() : null, type ?? null,
      title !== undefined ? String(title).trim() : null,
      location !== undefined ? String(location).trim() : null,
      areaValue !== undefined ? Number(areaValue) || 0 : null, areaUnit ?? null,
      price !== undefined ? Number(price) || 0 : null,
      description !== undefined ? String(description) : null,
      ownerId ?? null, listingType ?? null,
      sellerContactId !== undefined ? 1 : 0, sellerContactId ?? null,
      req.params.id
    );
  auditReq(req, 'PROPERTY_UPDATE', { entityType: 'property', entityId: req.params.id, details: `Updated property ${row.code}.` });
  res.json(await withSeller(await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id)));
}));

// POST /api/properties/:id/seller { contactId | null } — link or unlink the
// owner/seller contact shown on the property detail page.
router.post('/:id/seller', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Property not found.');
  const { contactId = null } = req.body || {};
  if (contactId) {
    const c = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
    if (!c) throw httpError(400, 'Contact not found.');
  }
  await db.prepare("UPDATE properties SET seller_contact_id = ?, updated_at = datetime('now') WHERE id = ?").run(contactId, req.params.id);
  const name = contactId ? (await db.prepare('SELECT name FROM contacts WHERE id = ?').get(contactId))?.name : 'no owner';
  auditReq(req, 'PROPERTY_SELLER', { entityType: 'property', entityId: req.params.id, details: `Property ${row.code} owner/seller set to ${name}.` });
  res.json(await withSeller(await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id)));
}));

// POST /api/properties/:id/status { status }
// Blocked <-> Available allowed. Sold is terminal: any change away from
// Sold is rejected. Booked is managed by the deal endpoints.
router.post('/:id/status', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Property not found.');
  const { status } = req.body || {};
  if (!['Available', 'Blocked'].includes(status)) {
    throw httpError(400, 'Status here must be Available or Blocked (use deals for Booked/Sold).');
  }
  if (row.status === 'Sold') throw httpError(400, 'Property is Sold and its status cannot be changed.');
  if (row.status === 'Booked') {
    throw httpError(400, 'Property is Booked on a deal — change the deal stage to release it.');
  }
  if (status === row.status) return res.json(await withSeller(row));
  await db.prepare(`UPDATE properties SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, req.params.id);
  auditReq(req, 'PROPERTY_STATUS', { entityType: 'property', entityId: req.params.id, details: `Property ${row.code}: ${row.status} → ${status}.` });
  res.json(await withSeller(await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id)));
}));

// GET /api/properties/:id/transactions — deals + payments for the property
router.get('/:id/transactions', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Property not found.');
  const deals = (await db.prepare(`SELECT d.*, l.name AS lead_name, u.name AS agent_name FROM deals d
    LEFT JOIN leads l ON l.id = d.lead_id LEFT JOIN users u ON u.id = d.agent_id
    WHERE d.property_id = ? ORDER BY d.created_at DESC`).all(req.params.id)).map(camel);
  const payments = (await db.prepare(`SELECT p.* FROM payments p
    JOIN payment_plans pp ON pp.id = p.plan_id
    JOIN deals d ON d.id = pp.deal_id
    WHERE d.property_id = ? ORDER BY p.created_at DESC`).all(req.params.id)).map(camel);
  res.json({ property: await withSeller(row), deals, payments });
}));

// DELETE /api/properties/:id
router.delete('/:id', ah(async (req, res) => {
  const row = await db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Property not found.');
  if (row.status !== 'Available') throw httpError(409, `Cannot delete a property with status ${row.status}.`);
  const dealCount = (await db.prepare('SELECT COUNT(*) AS n FROM deals WHERE property_id = ?').get(req.params.id)).n;
  if (dealCount > 0) throw httpError(409, `Cannot delete: property has ${dealCount} deal(s).`);
  await db.prepare('DELETE FROM properties WHERE id = ?').run(req.params.id);
  auditReq(req, 'PROPERTY_DELETE', { entityType: 'property', entityId: req.params.id, details: `Deleted property ${row.code}.` });
  res.json({ ok: true });
}));

export default router;
