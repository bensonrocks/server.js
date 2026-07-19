'use strict';

const crypto = require('crypto');
const db     = require('./db');

const STATUSES = ['dropped', 'processing', 'completed', 'issue'];

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// ---------- Dashboard ----------

function getDashboardCounts(clientId) {
  const rows = db.prepare(
    'SELECT status, COUNT(*) AS n FROM nt_orders WHERE client_id = ? GROUP BY status'
  ).all(clientId);

  const counts = { dropped: 0, processing: 0, completed: 0, issue: 0 };
  for (const r of rows) counts[r.status] = r.n;
  counts.total = counts.dropped + counts.processing + counts.completed + counts.issue;
  return counts;
}

// ---------- World map ----------

function getCountryBreakdown(clientId) {
  const locations = db.prepare(
    'SELECT id, country, country_name, city, lat, lng FROM nt_locations WHERE client_id = ? ORDER BY country_name'
  ).all(clientId);

  const orderRows = db.prepare(
    'SELECT country, status, COUNT(*) AS n FROM nt_orders WHERE client_id = ? GROUP BY country, status'
  ).all(clientId);

  const byCountry = new Map();
  for (const loc of locations) {
    byCountry.set(loc.country, {
      country: loc.country,
      countryName: loc.country_name,
      city: loc.city,
      lat: loc.lat,
      lng: loc.lng,
      dropped: 0, processing: 0, completed: 0, issue: 0, total: 0,
    });
  }
  for (const r of orderRows) {
    const entry = byCountry.get(r.country);
    if (!entry) continue;
    entry[r.status] = r.n;
    entry.total += r.n;
  }
  return [...byCountry.values()];
}

// ---------- Orders ----------

function listOrders(clientId, { country, status, search, page = 1, pageSize = 25 } = {}) {
  const clauses = ['client_id = ?'];
  const params = [clientId];

  if (country) { clauses.push('country = ?'); params.push(country); }
  if (status)  { clauses.push('status = ?'); params.push(status); }
  if (search) {
    clauses.push('(order_ref LIKE ? OR customer_name LIKE ? OR sku LIKE ? OR product_name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM nt_orders WHERE ${where}`).get(...params).n;

  const offset = Math.max(0, (page - 1) * pageSize);
  const rows = db.prepare(
    `SELECT id, order_ref, country, country_name, customer_name, sku, product_name, qty, status, issue_note, order_date
     FROM nt_orders WHERE ${where} ORDER BY order_date DESC, created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  return { rows, total, page, pageSize };
}

function createOrder(clientId, { customerName, country, countryName, sku, productName, qty, orderDate }) {
  if (!STATUSES) { /* noop */ }
  const id = uid('ord');
  const orderRef = `BWL-${new Date(orderDate || Date.now()).toISOString().slice(0, 7).replace('-', '')}-${db.prepare(
    'SELECT COUNT(*) AS n FROM nt_orders WHERE client_id = ?'
  ).get(clientId).n + 1}`;

  db.prepare(`
    INSERT INTO nt_orders (id, client_id, order_ref, country, country_name, customer_name, sku, product_name, qty, status, order_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dropped', ?)
  `).run(id, clientId, orderRef, country, countryName, customerName, sku, productName, qty || 1, orderDate || new Date().toISOString().slice(0, 10));

  return db.prepare('SELECT * FROM nt_orders WHERE id = ?').get(id);
}

function updateOrderStatus(clientId, orderId, status, issueNote) {
  if (!STATUSES.includes(status)) throw new Error('Invalid status');
  const result = db.prepare(
    `UPDATE nt_orders SET status = ?, issue_note = ?, updated_at = datetime('now') WHERE id = ? AND client_id = ?`
  ).run(status, issueNote || '', orderId, clientId);
  if (result.changes === 0) throw new Error('Order not found');
  return db.prepare('SELECT * FROM nt_orders WHERE id = ?').get(orderId);
}

// ---------- Inventory ----------

function listLocationsWithInventory(clientId) {
  const locations = db.prepare(
    'SELECT id, country, country_name, city, lat, lng FROM nt_locations WHERE client_id = ? ORDER BY country_name'
  ).all(clientId);

  const items = db.prepare(`
    SELECT i.id, i.location_id, i.sku, i.product_name, i.qty_on_hand, i.replenish_threshold, i.updated_at
    FROM nt_inventory i
    JOIN nt_locations l ON l.id = i.location_id
    WHERE l.client_id = ?
    ORDER BY i.product_name
  `).all(clientId);

  return locations.map((loc) => ({
    ...loc,
    items: items.filter((i) => i.location_id === loc.id).map((i) => ({
      ...i,
      lowStock: i.qty_on_hand <= i.replenish_threshold,
    })),
  }));
}

function updateReplenishThreshold(clientId, inventoryId, threshold) {
  const result = db.prepare(`
    UPDATE nt_inventory SET replenish_threshold = ?, updated_at = datetime('now')
    WHERE id = ? AND location_id IN (SELECT id FROM nt_locations WHERE client_id = ?)
  `).run(threshold, inventoryId, clientId);
  if (result.changes === 0) throw new Error('Inventory item not found');
  return db.prepare('SELECT * FROM nt_inventory WHERE id = ?').get(inventoryId);
}

function updateInventoryQty(clientId, inventoryId, qty) {
  const result = db.prepare(`
    UPDATE nt_inventory SET qty_on_hand = ?, updated_at = datetime('now')
    WHERE id = ? AND location_id IN (SELECT id FROM nt_locations WHERE client_id = ?)
  `).run(qty, inventoryId, clientId);
  if (result.changes === 0) throw new Error('Inventory item not found');
  return db.prepare('SELECT * FROM nt_inventory WHERE id = ?').get(inventoryId);
}

module.exports = {
  STATUSES,
  uid,
  getDashboardCounts,
  getCountryBreakdown,
  listOrders,
  createOrder,
  updateOrderStatus,
  listLocationsWithInventory,
  updateReplenishThreshold,
  updateInventoryQty,
};
