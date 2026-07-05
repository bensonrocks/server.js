'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { pool, hasDb } = require('./db');
const { routeOrder }  = require('./providers');
const { computePrice } = require('./pricing');

const STATUSES = ['received', 'transmitted', 'processing', 'shipped', 'delivered', 'exception'];

function buildOrder(clientId, data) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const provider = routeOrder(data.country);
  const price = computePrice({
    destinationCountry: data.country,
    items: data.items,
    serviceLevel: data.serviceLevel,
  });
  const externalRef = 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  return {
    id,
    clientId,
    recipientName: data.recipientName,
    addressLine1: data.addressLine1,
    city: data.city,
    region: data.region || '',
    postalCode: data.postalCode || '',
    country: String(data.country || '').toUpperCase(),
    items: data.items,
    serviceLevel: data.serviceLevel === 'express' ? 'express' : 'standard',
    providerId: provider?.id || null,
    providerName: provider?.name || null,
    dcLocation: provider?.dc || null,
    status: 'transmitted',
    statusHistory: [
      { status: 'received', at: now, note: 'Order dropped by client' },
      { status: 'transmitted', at: now, note: `Transmitted to ${provider?.name || 'network'} — ${provider?.dc || ''} (${externalRef})` },
    ],
    trackingNumber: null,
    carrier: null,
    priceBreakdown: price.breakdown,
    priceTotal: price.total,
    currency: price.currency,
    notes: data.notes || '',
    externalRef,
    createdAt: now,
    updatedAt: now,
  };
}

// ── JSON fallback (no DATABASE_URL) ────────────────────────────────────
const FILE = path.join(__dirname, '../data/orders.json');

function jsonRead() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function jsonWrite(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

const json = {
  create(clientId, data) {
    const list = jsonRead();
    const order = buildOrder(clientId, data);
    list.push(order);
    jsonWrite(list);
    return order;
  },
  findById(id) {
    return jsonRead().find(o => o.id === id) || null;
  },
  listByClient(clientId) {
    return jsonRead().filter(o => o.clientId === clientId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  listAll() {
    return jsonRead().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  updateStatus(id, patch) {
    const list = jsonRead();
    const i = list.findIndex(o => o.id === id);
    if (i === -1) return null;
    const now = new Date().toISOString();
    const order = list[i];
    if (patch.status && patch.status !== order.status) {
      order.statusHistory.push({ status: patch.status, at: now, note: patch.note || '' });
      order.status = patch.status;
    }
    if (patch.trackingNumber !== undefined) order.trackingNumber = patch.trackingNumber;
    if (patch.carrier !== undefined) order.carrier = patch.carrier;
    order.updatedAt = now;
    list[i] = order;
    jsonWrite(list);
    return order;
  },
};

// ── PostgreSQL backend ──────────────────────────────────────────────────
function rowToOrder(r) {
  if (!r) return null;
  return {
    id: r.id,
    clientId: r.client_id,
    recipientName: r.recipient_name,
    addressLine1: r.address_line1,
    city: r.city,
    region: r.region,
    postalCode: r.postal_code,
    country: r.country,
    items: r.items,
    serviceLevel: r.service_level,
    providerId: r.provider_id,
    providerName: r.provider_name,
    dcLocation: r.dc_location,
    status: r.status,
    statusHistory: r.status_history,
    trackingNumber: r.tracking_number,
    carrier: r.carrier,
    priceBreakdown: r.price_breakdown,
    priceTotal: Number(r.price_total),
    currency: r.currency,
    notes: r.notes,
    externalRef: r.external_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const pg = {
  async create(clientId, data) {
    const o = buildOrder(clientId, data);
    const { rows } = await pool.query(
      `INSERT INTO orders (
         id, client_id, recipient_name, address_line1, city, region, postal_code, country,
         items, service_level, provider_id, provider_name, dc_location, status, status_history,
         tracking_number, carrier, price_breakdown, price_total, currency, notes, external_ref,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [
        o.id, o.clientId, o.recipientName, o.addressLine1, o.city, o.region, o.postalCode, o.country,
        JSON.stringify(o.items), o.serviceLevel, o.providerId, o.providerName, o.dcLocation, o.status,
        JSON.stringify(o.statusHistory), o.trackingNumber, o.carrier, JSON.stringify(o.priceBreakdown),
        o.priceTotal, o.currency, o.notes, o.externalRef, o.createdAt, o.updatedAt,
      ]
    );
    return rowToOrder(rows[0]);
  },
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    return rowToOrder(rows[0]) || null;
  },
  async listByClient(clientId) {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE client_id = $1 ORDER BY created_at DESC', [clientId]
    );
    return rows.map(rowToOrder);
  },
  async listAll() {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    return rows.map(rowToOrder);
  },
  async updateStatus(id, patch) {
    const existing = await pg.findById(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    let history = existing.statusHistory;
    let status = existing.status;
    if (patch.status && patch.status !== existing.status) {
      history = [...history, { status: patch.status, at: now, note: patch.note || '' }];
      status = patch.status;
    }
    const trackingNumber = patch.trackingNumber !== undefined ? patch.trackingNumber : existing.trackingNumber;
    const carrier = patch.carrier !== undefined ? patch.carrier : existing.carrier;
    const { rows } = await pool.query(
      `UPDATE orders SET status = $1, status_history = $2, tracking_number = $3, carrier = $4, updated_at = $5
       WHERE id = $6 RETURNING *`,
      [status, JSON.stringify(history), trackingNumber, carrier, now, id]
    );
    return rowToOrder(rows[0]) || null;
  },
};

module.exports = { ...(hasDb ? pg : json), STATUSES };
