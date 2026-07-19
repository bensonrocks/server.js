'use strict';

const crypto = require('crypto');
const db     = require('./db');
const { sha256 } = require('./auth');

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

// Picks the vendor NimbusTrade routes an order to for fulfillment in a given
// country. Entirely invisible to the client — never surfaced on their API.
function assignVendorForOrder(country) {
  const vendor = db.prepare(
    'SELECT id FROM nt_vendors WHERE country = ? AND active = 1 ORDER BY created_at LIMIT 1'
  ).get(country);
  return vendor ? vendor.id : '';
}

function createOrder(clientId, { customerName, country, countryName, sku, productName, qty, orderDate }) {
  const id = uid('ord');
  const orderRef = `BWL-${new Date(orderDate || Date.now()).toISOString().slice(0, 7).replace('-', '')}-${db.prepare(
    'SELECT COUNT(*) AS n FROM nt_orders WHERE client_id = ?'
  ).get(clientId).n + 1}`;
  const vendorId = assignVendorForOrder(country);

  db.prepare(`
    INSERT INTO nt_orders (id, client_id, order_ref, country, country_name, customer_name, sku, product_name, qty, status, vendor_id, order_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dropped', ?, ?)
  `).run(id, clientId, orderRef, country, countryName, customerName, sku, productName, qty || 1, vendorId, orderDate || new Date().toISOString().slice(0, 10));

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

// ---------- Vendor-side (fulfillment) ----------
// A vendor only ever sees orders routed to them (by vendor_id), never the
// client's inventory or dashboard — the reverse of the client's isolation.

function listVendorOrders(vendorId, { status, search, page = 1, pageSize = 25 } = {}) {
  const clauses = ['o.vendor_id = ?'];
  const params = [vendorId];

  if (status) { clauses.push('o.status = ?'); params.push(status); }
  if (search) {
    clauses.push('(o.order_ref LIKE ? OR o.customer_name LIKE ? OR o.sku LIKE ? OR o.product_name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM nt_orders o WHERE ${where}`).get(...params).n;

  const offset = Math.max(0, (page - 1) * pageSize);
  const rows = db.prepare(`
    SELECT o.id, o.order_ref, o.country, o.country_name, o.customer_name, o.sku, o.product_name,
           o.qty, o.status, o.issue_note, o.order_date,
           (SELECT name FROM nt_clients WHERE id = o.client_id) AS client_name
    FROM nt_orders o WHERE ${where}
    ORDER BY o.order_date DESC, o.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  return { rows, total, page, pageSize };
}

function getVendorDashboard(vendorId) {
  const rows = db.prepare(
    'SELECT status, COUNT(*) AS n FROM nt_orders WHERE vendor_id = ? GROUP BY status'
  ).all(vendorId);
  const counts = { dropped: 0, processing: 0, completed: 0, issue: 0 };
  for (const r of rows) counts[r.status] = r.n;
  counts.total = counts.dropped + counts.processing + counts.completed + counts.issue;
  return counts;
}

function updateOrderStatusByVendor(vendorId, orderId, status, issueNote) {
  if (!STATUSES.includes(status)) throw new Error('Invalid status');
  const result = db.prepare(
    `UPDATE nt_orders SET status = ?, issue_note = ?, updated_at = datetime('now') WHERE id = ? AND vendor_id = ?`
  ).run(status, issueNote || '', orderId, vendorId);
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

// ---------- Staff (master panel) — unrestricted across every client/vendor ----------
// Everything here is the same underlying data the client and vendor portals
// touch; staff just isn't scoped down to a single client_id or vendor_id.

function getGlobalDashboard() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM nt_orders GROUP BY status').all();
  const counts = { dropped: 0, processing: 0, completed: 0, issue: 0 };
  for (const r of rows) counts[r.status] = r.n;
  counts.total = counts.dropped + counts.processing + counts.completed + counts.issue;

  const byClient = db.prepare(`
    SELECT c.id AS client_id, c.name AS client_name, o.status, COUNT(*) AS n
    FROM nt_orders o JOIN nt_clients c ON c.id = o.client_id
    GROUP BY c.id, o.status
  `).all();
  const clientMap = new Map();
  for (const r of byClient) {
    if (!clientMap.has(r.client_id)) {
      clientMap.set(r.client_id, { clientId: r.client_id, clientName: r.client_name, dropped: 0, processing: 0, completed: 0, issue: 0, total: 0 });
    }
    const entry = clientMap.get(r.client_id);
    entry[r.status] = r.n;
    entry.total += r.n;
  }

  return { counts, byClient: [...clientMap.values()] };
}

function listAllClients() {
  return db.prepare(`
    SELECT c.id, c.name, c.created_at,
           (SELECT COUNT(*) FROM nt_orders o WHERE o.client_id = c.id) AS order_count,
           (SELECT COUNT(*) FROM nt_users u WHERE u.client_id = c.id AND u.active = 1) AS active_users
    FROM nt_clients c ORDER BY c.name
  `).all();
}

function createClient(name) {
  const id = uid('client');
  db.prepare('INSERT INTO nt_clients (id, name) VALUES (?, ?)').run(id, name);
  return db.prepare('SELECT * FROM nt_clients WHERE id = ?').get(id);
}

function createClientUser(clientId, name, username, password) {
  const id = uid('user');
  db.prepare('INSERT INTO nt_users (id, client_id, name, username, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(id, clientId, name, username, sha256(password));
  return db.prepare('SELECT id, client_id, name, username, active FROM nt_users WHERE id = ?').get(id);
}

function listClientUsers(clientId) {
  return db.prepare('SELECT id, name, username, active, created_at FROM nt_users WHERE client_id = ? ORDER BY name').all(clientId);
}

function setClientUserActive(userId, active) {
  db.prepare('UPDATE nt_users SET active = ? WHERE id = ?').run(active ? 1 : 0, userId);
}

function listAllVendors() {
  return db.prepare(`
    SELECT v.id, v.country, v.name, v.username, v.active, v.created_at,
           (SELECT COUNT(*) FROM nt_orders o WHERE o.vendor_id = v.id) AS order_count
    FROM nt_vendors v ORDER BY v.country
  `).all();
}

function createVendor(country, name, username, password) {
  const id = uid('vendor');
  db.prepare('INSERT INTO nt_vendors (id, country, name, username, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(id, country, name, username, sha256(password));
  return db.prepare('SELECT id, country, name, username, active FROM nt_vendors WHERE id = ?').get(id);
}

function setVendorActive(vendorId, active) {
  db.prepare('UPDATE nt_vendors SET active = ? WHERE id = ?').run(active ? 1 : 0, vendorId);
}

function listAllLocations() {
  return db.prepare(`
    SELECT l.id, l.client_id, (SELECT name FROM nt_clients WHERE id = l.client_id) AS client_name,
           l.country, l.country_name, l.city, l.lat, l.lng
    FROM nt_locations l ORDER BY client_name, l.country_name
  `).all();
}

function createLocation(clientId, { country, countryName, city, lat, lng }) {
  const id = uid('loc');
  db.prepare('INSERT INTO nt_locations (id, client_id, country, country_name, city, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, clientId, country, countryName, city, lat, lng);
  return db.prepare('SELECT * FROM nt_locations WHERE id = ?').get(id);
}

function createInventoryItem(locationId, { sku, productName, qty, threshold }) {
  const id = uid('inv');
  db.prepare(`
    INSERT INTO nt_inventory (id, location_id, sku, product_name, qty_on_hand, replenish_threshold)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, locationId, sku, productName, qty || 0, threshold || 0);
  return db.prepare('SELECT * FROM nt_inventory WHERE id = ?').get(id);
}

function listAllInventory() {
  return db.prepare(`
    SELECT i.id, i.location_id, i.sku, i.product_name, i.qty_on_hand, i.replenish_threshold, i.updated_at,
           l.country_name, l.city, l.client_id,
           (SELECT name FROM nt_clients WHERE id = l.client_id) AS client_name
    FROM nt_inventory i JOIN nt_locations l ON l.id = i.location_id
    ORDER BY client_name, l.country_name, i.product_name
  `).all().map((i) => ({ ...i, lowStock: i.qty_on_hand <= i.replenish_threshold }));
}

function updateInventoryByStaff(inventoryId, { qty, threshold }) {
  if (typeof qty === 'number') {
    db.prepare(`UPDATE nt_inventory SET qty_on_hand = ?, updated_at = datetime('now') WHERE id = ?`).run(qty, inventoryId);
  }
  if (typeof threshold === 'number') {
    db.prepare(`UPDATE nt_inventory SET replenish_threshold = ?, updated_at = datetime('now') WHERE id = ?`).run(threshold, inventoryId);
  }
  const row = db.prepare('SELECT * FROM nt_inventory WHERE id = ?').get(inventoryId);
  if (!row) throw new Error('Inventory item not found');
  return row;
}

function listAllOrders({ clientId, country, status, vendorId, search, page = 1, pageSize = 25 } = {}) {
  const clauses = ['1=1'];
  const params = [];

  if (clientId) { clauses.push('o.client_id = ?'); params.push(clientId); }
  if (country)  { clauses.push('o.country = ?'); params.push(country); }
  if (status)   { clauses.push('o.status = ?'); params.push(status); }
  if (vendorId) { clauses.push('o.vendor_id = ?'); params.push(vendorId); }
  if (search) {
    clauses.push('(o.order_ref LIKE ? OR o.customer_name LIKE ? OR o.sku LIKE ? OR o.product_name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM nt_orders o WHERE ${where}`).get(...params).n;

  const offset = Math.max(0, (page - 1) * pageSize);
  const rows = db.prepare(`
    SELECT o.id, o.order_ref, o.country, o.country_name, o.customer_name, o.sku, o.product_name,
           o.qty, o.status, o.issue_note, o.vendor_id, o.order_date,
           (SELECT name FROM nt_clients WHERE id = o.client_id) AS client_name,
           (SELECT name FROM nt_vendors WHERE id = o.vendor_id) AS vendor_name
    FROM nt_orders o WHERE ${where}
    ORDER BY o.order_date DESC, o.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  return { rows, total, page, pageSize };
}

function updateOrderByStaff(orderId, { status, issueNote, vendorId }) {
  const sets = [];
  const params = [];
  if (status) {
    if (!STATUSES.includes(status)) throw new Error('Invalid status');
    sets.push('status = ?'); params.push(status);
  }
  if (typeof issueNote === 'string') { sets.push('issue_note = ?'); params.push(issueNote); }
  if (typeof vendorId === 'string') { sets.push('vendor_id = ?'); params.push(vendorId); }
  if (!sets.length) throw new Error('Nothing to update');
  sets.push("updated_at = datetime('now')");
  params.push(orderId);

  const result = db.prepare(`UPDATE nt_orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (result.changes === 0) throw new Error('Order not found');
  return db.prepare('SELECT * FROM nt_orders WHERE id = ?').get(orderId);
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
  assignVendorForOrder,
  listVendorOrders,
  getVendorDashboard,
  updateOrderStatusByVendor,
  getGlobalDashboard,
  listAllClients,
  createClient,
  createClientUser,
  listClientUsers,
  setClientUserActive,
  listAllVendors,
  createVendor,
  setVendorActive,
  listAllLocations,
  createLocation,
  listAllInventory,
  createInventoryItem,
  updateInventoryByStaff,
  listAllOrders,
  updateOrderByStaff,
};
