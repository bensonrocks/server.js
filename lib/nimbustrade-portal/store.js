'use strict';

const crypto = require('crypto');
const db     = require('./db');
const { sha256 } = require('./auth');

// Client-facing order flow, forward only. Older rows (dropped / issue /
// completed) fold into these three for display and counts; new writes use
// the canonical values.
const ORDER_FLOW = ['processing', 'ready_to_ship', 'shipped'];
const STATUSES = ORDER_FLOW;
const STATUS_LABEL = {
  processing: 'Processing',
  ready_to_ship: 'Ready to ship',
  shipped: 'Shipped',
};
const LEGACY_FLOW = {
  dropped: 'processing',
  processing: 'processing',
  issue: 'processing',
  completed: 'shipped',
  ready_to_ship: 'ready_to_ship',
  shipped: 'shipped',
};
const FLOW_STORED = {
  processing: ['processing', 'dropped', 'issue'],
  ready_to_ship: ['ready_to_ship'],
  shipped: ['shipped', 'completed'],
};
const CREATE_NOTES = {
  processing: 'Order received',
  ready_to_ship: 'Ready to ship',
  shipped: 'Shipped',
};
const ADVANCE_NOTES = {
  ready_to_ship: 'Marked ready to ship',
  shipped: 'Marked shipped',
};

function flowStatus(stored) {
  return LEGACY_FLOW[stored] || 'processing';
}

function nextFlowStatus(stored) {
  const current = flowStatus(stored);
  const i = ORDER_FLOW.indexOf(current);
  if (i < 0 || i >= ORDER_FLOW.length - 1) return null;
  return ORDER_FLOW[i + 1];
}

function presentOrder(row) {
  if (!row) return row;
  const flow = flowStatus(row.status);
  const next = nextFlowStatus(row.status);
  return {
    ...row,
    flow_status: flow,
    status_label: STATUS_LABEL[flow],
    next_status: next,
    next_label: next ? STATUS_LABEL[next] : null,
  };
}

function presentEvent(ev) {
  if (!ev) return ev;
  const flow = flowStatus(ev.status);
  return { ...ev, flow_status: flow, status_label: STATUS_LABEL[flow] || ev.status };
}

function emptyFlowCounts() {
  return { processing: 0, ready_to_ship: 0, shipped: 0, total: 0 };
}

function foldStatusCounts(rows) {
  const counts = emptyFlowCounts();
  for (const r of rows) {
    const flow = LEGACY_FLOW[r.status];
    if (!flow) continue;
    counts[flow] += r.n;
    counts.total += r.n;
  }
  return counts;
}

function addFlowCount(entry, status, n) {
  const flow = LEGACY_FLOW[status];
  if (!flow) return;
  const add = Number(n) || 0;
  entry[flow] = (entry[flow] || 0) + add;
  entry.total += add;
}

function statusFilterSql(column, status) {
  const stored = FLOW_STORED[status];
  if (!stored) return null;
  return { sql: `${column} IN (${stored.map(() => '?').join(', ')})`, params: stored };
}

function resolveCreateStatus(status) {
  if (status == null || String(status).trim() === '') return 'processing';
  const raw = String(status).trim();
  if (ORDER_FLOW.includes(raw)) return raw;
  const slug = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (slug === 'processing') return 'processing';
  if (slug === 'readytoship') return 'ready_to_ship';
  if (slug === 'shipped') return 'shipped';
  throw new Error('Status must be Processing, Ready to ship, or Shipped');
}

function assertForward(currentStatus, requested) {
  const next = nextFlowStatus(currentStatus);
  if (!next) throw new Error('This order is already Shipped');
  if (requested !== next) throw new Error(`This order can only move to ${STATUS_LABEL[next]}`);
  return next;
}

function safeOrderIds(ids) {
  if (!ids) return [];
  const list = Array.isArray(ids) ? ids : String(ids).split(',');
  return list.map((id) => String(id).trim()).filter((id) => /^[A-Za-z0-9_]+$/.test(id)).slice(0, 100);
}

// Known catalog/market codes, so a bare CSV row (just a country/SKU code) still
// renders with friendly names — matches what the single-order drop form already
// resolves client-side via its <option data-name> attributes.
const COUNTRY_NAMES = {
  AE: 'United Arab Emirates', CA: 'Canada', GB: 'United Kingdom', MX: 'Mexico',
  SG: 'Singapore', US: 'United States',
};
const PRODUCT_NAMES = {
  'RAD-SER-30': 'Radiance Serum 30ml',
  'NGT-CRM-50': 'Renewal Night Cream 50ml',
  'BRT-TNR-150': 'Brightening Toner 150ml',
  'COL-ESS-30': 'Collagen Essence 30ml',
  'VTC-CLN-100': 'Vitamin C Cleanser 100ml',
};

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// ---------- Dashboard ----------

function getDashboardCounts(clientId) {
  const rows = db.prepare(
    'SELECT status, COUNT(*) AS n FROM nt_orders WHERE client_id = ? GROUP BY status'
  ).all(clientId);
  return foldStatusCounts(rows);
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
      processing: 0, ready_to_ship: 0, shipped: 0, total: 0,
    });
  }
  for (const r of orderRows) {
    const entry = byCountry.get(r.country);
    if (!entry) continue;
    addFlowCount(entry, r.status, r.n);
  }
  return [...byCountry.values()];
}

// Same shape as getCountryBreakdown, across every client — keyed by
// (client, country) rather than country alone, since two clients can each
// have their own DC in the same market.
function getGlobalLocationBreakdown() {
  const locations = db.prepare(`
    SELECT l.id, l.client_id, l.country, l.country_name, l.city, l.lat, l.lng, c.name AS client_name
    FROM nt_locations l JOIN nt_clients c ON c.id = l.client_id
    ORDER BY c.name, l.country_name
  `).all();

  const orderRows = db.prepare(
    'SELECT client_id, country, status, COUNT(*) AS n FROM nt_orders GROUP BY client_id, country, status'
  ).all();

  const key = (clientId, country) => `${clientId}::${country}`;
  const byKey = new Map();
  for (const loc of locations) {
    byKey.set(key(loc.client_id, loc.country), {
      locationId: loc.id,
      clientId: loc.client_id,
      clientName: loc.client_name,
      country: loc.country,
      countryName: loc.country_name,
      city: loc.city,
      lat: loc.lat,
      lng: loc.lng,
      processing: 0, ready_to_ship: 0, shipped: 0, total: 0,
    });
  }
  for (const r of orderRows) {
    const entry = byKey.get(key(r.client_id, r.country));
    if (!entry) continue;
    addFlowCount(entry, r.status, r.n);
  }
  return [...byKey.values()];
}

// ---------- Monthly trend ----------

// One row per month of order history. The most recent month is flagged
// `live` — the dashboard reads that as "current running month" and shows it
// with a blinking indicator, so this always tracks whatever month is latest
// rather than a hardcoded date.
function getMonthlyBreakdown(clientId) {
  const rows = db.prepare(`
    SELECT substr(order_date, 1, 7) AS month, status, COUNT(*) AS n
    FROM nt_orders WHERE client_id = ? GROUP BY month, status
  `).all(clientId);

  const byMonth = new Map();
  for (const r of rows) {
    if (!byMonth.has(r.month)) {
      byMonth.set(r.month, { month: r.month, processing: 0, ready_to_ship: 0, shipped: 0, total: 0 });
    }
    const m = byMonth.get(r.month);
    addFlowCount(m, r.status, r.n);
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  months.forEach((m, i) => { m.live = i === months.length - 1; });
  return months;
}

// ---------- Inbound shipments (restocking into a DC — not customer orders) ----------

const INBOUND_STATUSES = ['in_transit', 'arrived', 'delayed', 'partial'];
const INBOUND_MODES = ['air', 'sea', 'road'];

function listInboundForClient(clientId) {
  return db.prepare(`
    SELECT s.id, s.reference, s.origin, s.mode, s.carrier, s.waybill_number, s.contents, s.expected_qty, s.received_qty,
           s.status, s.expected_date, s.arrived_date,
           l.country, l.country_name, l.city, l.lat, l.lng
    FROM nt_inbound_shipments s JOIN nt_locations l ON l.id = s.location_id
    WHERE s.client_id = ?
    ORDER BY s.expected_date DESC
  `).all(clientId);
}

function listAllInboundForStaff() {
  return db.prepare(`
    SELECT s.id, s.reference, s.origin, s.mode, s.carrier, s.waybill_number, s.contents, s.expected_qty, s.received_qty,
           s.status, s.expected_date, s.arrived_date, s.location_id,
           l.country, l.country_name, l.city, l.lat, l.lng, l.client_id,
           (SELECT name FROM nt_clients WHERE id = l.client_id) AS client_name
    FROM nt_inbound_shipments s JOIN nt_locations l ON l.id = s.location_id
    ORDER BY client_name, s.expected_date DESC
  `).all();
}

function createInbound(clientId, { locationId, reference, origin, mode, carrier, waybillNumber, contents, expectedQty, expectedDate }) {
  const loc = db.prepare('SELECT id FROM nt_locations WHERE id = ? AND client_id = ?').get(locationId, clientId);
  if (!loc) throw new Error('Location not found for this client');
  if (mode && !INBOUND_MODES.includes(mode)) throw new Error('Invalid mode');
  const id = uid('inb');
  db.prepare(`
    INSERT INTO nt_inbound_shipments (id, client_id, location_id, reference, origin, mode, carrier, waybill_number, contents, expected_qty, expected_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, clientId, locationId, reference, origin || 'Singapore', mode || 'air', carrier || '', waybillNumber || '', contents || '', expectedQty || 0, expectedDate);
  return db.prepare('SELECT * FROM nt_inbound_shipments WHERE id = ?').get(id);
}

// Real (never fabricated) status snapshot — built only from the shipment's
// own recorded fields, same principle as logOrderEvent for customer orders.
function getInboundTimelineForClient(clientId, id) {
  const s = db.prepare(`
    SELECT s.*, l.country_name, l.city
    FROM nt_inbound_shipments s JOIN nt_locations l ON l.id = s.location_id
    WHERE s.id = ? AND s.client_id = ?
  `).get(id, clientId);
  if (!s) throw new Error('Shipment not found');

  const timeline = [{ status: 'booked', note: `Expected ${s.expected_date}`, created_at: s.created_at }];
  if (s.status !== 'in_transit') {
    const note = s.status === 'arrived' || s.status === 'partial'
      ? `Received ${s.received_qty}/${s.expected_qty}${s.arrived_date ? ` on ${s.arrived_date}` : ''}`
      : '';
    timeline.push({ status: s.status, note, created_at: s.updated_at });
  }
  return { shipment: s, timeline };
}

function updateInboundByStaff(id, { status, receivedQty, arrivedDate, carrier, waybillNumber }) {
  const sets = [];
  const params = [];
  if (status) {
    if (!INBOUND_STATUSES.includes(status)) throw new Error('Invalid status');
    sets.push('status = ?'); params.push(status);
  }
  if (typeof receivedQty === 'number') { sets.push('received_qty = ?'); params.push(receivedQty); }
  if (typeof arrivedDate === 'string') { sets.push('arrived_date = ?'); params.push(arrivedDate); }
  if (typeof carrier === 'string') { sets.push('carrier = ?'); params.push(carrier); }
  if (typeof waybillNumber === 'string') { sets.push('waybill_number = ?'); params.push(waybillNumber); }
  if (!sets.length) throw new Error('Nothing to update');
  sets.push("updated_at = datetime('now')");
  params.push(id);
  const result = db.prepare(`UPDATE nt_inbound_shipments SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (result.changes === 0) throw new Error('Inbound shipment not found');
  return db.prepare('SELECT * FROM nt_inbound_shipments WHERE id = ?').get(id);
}

// ---------- Orders ----------

// Real (never fabricated) status history — one row per genuine transition,
// so the client's tracking view always reflects our own actual order data.
function logOrderEvent(orderId, status, note) {
  db.prepare('INSERT INTO nt_order_events (id, order_id, status, note) VALUES (?, ?, ?, ?)')
    .run(uid('evt'), orderId, status, note || '');
}

function listOrders(clientId, { country, status, search, page = 1, pageSize = 25, all = false, ids } = {}) {
  const clauses = ['client_id = ?'];
  const params = [clientId];

  if (country) { clauses.push('country = ?'); params.push(country); }
  const filt = statusFilterSql('status', status);
  if (filt) { clauses.push(filt.sql); params.push(...filt.params); }
  const idList = safeOrderIds(ids);
  if (idList.length) {
    clauses.push(`id IN (${idList.map(() => '?').join(', ')})`);
    params.push(...idList);
  }
  if (search) {
    clauses.push('(order_ref LIKE ? OR customer_name LIKE ? OR sku LIKE ? OR product_name LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM nt_orders WHERE ${where}`).get(...params).n;

  const cols = 'id, order_ref, country, country_name, customer_name, sku, product_name, qty, status, issue_note, carrier, waybill_number, due_date, order_date';
  const rows = all
    ? db.prepare(
        `SELECT ${cols} FROM nt_orders WHERE ${where} ORDER BY order_date DESC, created_at DESC`
      ).all(...params)
    : db.prepare(
        `SELECT ${cols} FROM nt_orders WHERE ${where} ORDER BY order_date DESC, created_at DESC LIMIT ? OFFSET ?`
      ).all(...params, pageSize, Math.max(0, (page - 1) * pageSize));

  return { rows: rows.map(presentOrder), total, page, pageSize };
}

// Picks the vendor NimbusTrade routes an order to for fulfillment in a given
// country. Entirely invisible to the client — never surfaced on their API.
function assignVendorForOrder(country) {
  const vendor = db.prepare(
    'SELECT id FROM nt_vendors WHERE country = ? AND active = 1 ORDER BY created_at LIMIT 1'
  ).get(country);
  return vendor ? vendor.id : '';
}

function createOrder(clientId, { customerName, country, countryName, sku, productName, qty, orderDate, dueDate, status }) {
  const flow = resolveCreateStatus(status);
  const id = uid('ord');
  const dated = orderDate || sgToday();
  const orderRef = `BWL-${String(dated).slice(0, 7).replace('-', '')}-${db.prepare(
    'SELECT COUNT(*) AS n FROM nt_orders WHERE client_id = ?'
  ).get(clientId).n + 1}`;
  const vendorId = assignVendorForOrder(country);

  db.prepare(`
    INSERT INTO nt_orders (id, client_id, order_ref, country, country_name, customer_name, sku, product_name, qty, status, vendor_id, due_date, order_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, clientId, orderRef, country, countryName, customerName, sku, productName, qty || 1, flow, vendorId,
    dueDate || '', dated
  );
  logOrderEvent(id, flow, CREATE_NOTES[flow] || 'Order received');

  return presentOrder(db.prepare('SELECT * FROM nt_orders WHERE id = ?').get(id));
}

// Bulk CSV import — same validation/order-ref/vendor-routing path as a single
// drop, just looped in one transaction so a partial failure doesn't half-import.
function bulkCreateOrders(clientId, rows) {
  const created = [];
  const errors = [];
  const run = db.transaction(() => {
    rows.forEach((row, i) => {
      const rowNo = row.rowNumber || i + 1;
      const { customerName, country, countryName, sku, productName, qty, orderDate, dueDate, status } = row;
      if (!customerName || !country || !sku) {
        errors.push({ row: rowNo, error: 'Missing customerName, country, or sku' });
        return;
      }
      try {
        created.push(createOrder(clientId, {
          customerName, country, countryName: countryName || COUNTRY_NAMES[country] || country, sku,
          productName: productName || PRODUCT_NAMES[sku] || sku, qty: qty ? parseInt(qty, 10) : 1, orderDate,
          dueDate: dueDate || '', status,
        }));
      } catch (e) {
        errors.push({ row: rowNo, error: e.message });
      }
    });
  });
  run();
  return { created: created.length, orders: created, errors };
}

function updateOrderStatus() {
  throw new Error('Order status is updated by staff');
}

// Real status-change history for one order, scoped to the requesting client
// so a client can never read another client's order timeline.
function getOrderTimeline(clientId, orderId) {
  const order = db.prepare('SELECT * FROM nt_orders WHERE id = ? AND client_id = ?').get(orderId, clientId);
  if (!order) throw new Error('Order not found');
  const events = db.prepare(
    'SELECT status, note, created_at FROM nt_order_events WHERE order_id = ? ORDER BY created_at ASC'
  ).all(orderId);
  return { order: presentOrder(order), events: events.map(presentEvent) };
}

// ---------- Vendor-side (fulfillment) ----------
// A vendor only ever sees orders routed to them (by vendor_id), never the
// client's inventory or dashboard — the reverse of the client's isolation.

function listVendorOrders(vendorId, { status, search, page = 1, pageSize = 25 } = {}) {
  const clauses = ['o.vendor_id = ?'];
  const params = [vendorId];

  const vFilt = statusFilterSql('o.status', status);
  if (vFilt) { clauses.push(vFilt.sql); params.push(...vFilt.params); }
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

  return { rows: rows.map(presentOrder), total, page, pageSize };
}

function getVendorDashboard(vendorId) {
  const rows = db.prepare(
    'SELECT status, COUNT(*) AS n FROM nt_orders WHERE vendor_id = ? GROUP BY status'
  ).all(vendorId);
  return foldStatusCounts(rows);
}

function updateOrderStatusByVendor(vendorId, orderId, status, issueNote) {
  const current = db.prepare('SELECT * FROM nt_orders WHERE id = ? AND vendor_id = ?').get(orderId, vendorId);
  if (!current) throw new Error('Order not found');
  const next = assertForward(current.status, status);
  const note = (typeof issueNote === 'string' && issueNote) ? issueNote : (ADVANCE_NOTES[next] || '');
  db.prepare(
    `UPDATE nt_orders SET status = ?, issue_note = CASE WHEN ? = '' THEN issue_note ELSE ? END, updated_at = datetime('now') WHERE id = ? AND vendor_id = ?`
  ).run(next, typeof issueNote === 'string' ? issueNote : '', typeof issueNote === 'string' ? issueNote : '', orderId, vendorId);
  logOrderEvent(orderId, next, note);
  return presentOrder(db.prepare('SELECT * FROM nt_orders WHERE id = ?').get(orderId));
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
  const counts = foldStatusCounts(rows);

  const byClient = db.prepare(`
    SELECT c.id AS client_id, c.name AS client_name, o.status, COUNT(*) AS n
    FROM nt_orders o JOIN nt_clients c ON c.id = o.client_id
    GROUP BY c.id, o.status
  `).all();
  const clientMap = new Map();
  for (const r of byClient) {
    if (!clientMap.has(r.client_id)) {
      clientMap.set(r.client_id, {
        clientId: r.client_id, clientName: r.client_name,
        processing: 0, ready_to_ship: 0, shipped: 0, total: 0,
      });
    }
    addFlowCount(clientMap.get(r.client_id), r.status, r.n);
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
  const sFilt = statusFilterSql('o.status', status);
  if (sFilt) { clauses.push(sFilt.sql); params.push(...sFilt.params); }
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
           o.qty, o.status, o.issue_note, o.vendor_id, o.carrier, o.waybill_number, o.order_date,
           (SELECT name FROM nt_clients WHERE id = o.client_id) AS client_name,
           (SELECT name FROM nt_vendors WHERE id = o.vendor_id) AS vendor_name
    FROM nt_orders o WHERE ${where}
    ORDER BY o.order_date DESC, o.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  return { rows: rows.map(presentOrder), total, page, pageSize };
}

function updateOrderByStaff(orderId, { status, issueNote, vendorId, carrier, waybillNumber }) {
  const current = db.prepare('SELECT * FROM nt_orders WHERE id = ?').get(orderId);
  if (!current) throw new Error('Order not found');
  const sets = [];
  const params = [];
  let next = null;
  if (status) {
    next = assertForward(current.status, status);
    sets.push('status = ?'); params.push(next);
  }
  if (typeof issueNote === 'string') { sets.push('issue_note = ?'); params.push(issueNote); }
  if (typeof vendorId === 'string') { sets.push('vendor_id = ?'); params.push(vendorId); }
  if (typeof carrier === 'string') { sets.push('carrier = ?'); params.push(carrier); }
  if (typeof waybillNumber === 'string') { sets.push('waybill_number = ?'); params.push(waybillNumber); }
  if (!sets.length) throw new Error('Nothing to update');
  sets.push("updated_at = datetime('now')");
  params.push(orderId);

  db.prepare(`UPDATE nt_orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (next) logOrderEvent(orderId, next, (typeof issueNote === 'string' && issueNote) ? issueNote : (ADVANCE_NOTES[next] || ''));
  return presentOrder(db.prepare('SELECT * FROM nt_orders WHERE id = ?').get(orderId));
}

// ---------- Rates (established per-DC handling rates) ----------
// Deliberately empty until staff sets them — this app never invents pricing.

function getRatesForClient(clientId) {
  return db.prepare(`
    SELECT l.id AS location_id, l.country, l.country_name, l.city,
           r.currency, r.base_fee, r.per_unit_fee, r.storage_fee, r.notes, r.updated_at
    FROM nt_locations l
    LEFT JOIN nt_rates r ON r.location_id = l.id
    WHERE l.client_id = ?
    ORDER BY l.country_name
  `).all(clientId).map((row) => ({
    ...row,
    configured: row.updated_at != null,
    currency: row.currency || 'USD',
    base_fee: row.base_fee || 0,
    per_unit_fee: row.per_unit_fee || 0,
    storage_fee: row.storage_fee || 0,
  }));
}

function getAllRatesForStaff() {
  return db.prepare(`
    SELECT l.id AS location_id, l.country, l.country_name, l.city, l.client_id,
           (SELECT name FROM nt_clients WHERE id = l.client_id) AS client_name,
           r.currency, r.base_fee, r.per_unit_fee, r.storage_fee, r.notes, r.updated_at
    FROM nt_locations l
    LEFT JOIN nt_rates r ON r.location_id = l.id
    ORDER BY client_name, l.country_name
  `).all().map((row) => ({
    ...row,
    configured: row.updated_at != null,
    currency: row.currency || 'USD',
    base_fee: row.base_fee || 0,
    per_unit_fee: row.per_unit_fee || 0,
    storage_fee: row.storage_fee || 0,
  }));
}

function upsertRate(locationId, { currency, baseFee, perUnitFee, storageFee, notes }) {
  const loc = db.prepare('SELECT id FROM nt_locations WHERE id = ?').get(locationId);
  if (!loc) throw new Error('Location not found');
  const existing = db.prepare('SELECT id FROM nt_rates WHERE location_id = ?').get(locationId);
  if (existing) {
    db.prepare(`
      UPDATE nt_rates SET currency = ?, base_fee = ?, per_unit_fee = ?, storage_fee = ?, notes = ?, updated_at = datetime('now')
      WHERE location_id = ?
    `).run(currency || 'USD', baseFee || 0, perUnitFee || 0, storageFee || 0, notes || '', locationId);
  } else {
    db.prepare(`
      INSERT INTO nt_rates (id, location_id, currency, base_fee, per_unit_fee, storage_fee, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uid('rate'), locationId, currency || 'USD', baseFee || 0, perUnitFee || 0, storageFee || 0, notes || '');
  }
  return db.prepare('SELECT * FROM nt_rates WHERE location_id = ?').get(locationId);
}

// ---------- Rate card (real negotiated fee schedule, as issued) ----------

function getRateCardForClient(clientId) {
  const row = db.prepare('SELECT * FROM nt_rate_cards WHERE client_id = ?').get(clientId);
  if (!row) return null;
  return {
    currency: row.currency,
    preparedBy: row.prepared_by,
    preparedTitle: row.prepared_title,
    issuedDate: row.issued_date,
    updatedAt: row.updated_at,
    ...JSON.parse(row.data_json),
  };
}

function upsertRateCard(clientId, { currency, preparedBy, preparedTitle, issuedDate, data }) {
  const client = db.prepare('SELECT id FROM nt_clients WHERE id = ?').get(clientId);
  if (!client) throw new Error('Client not found');
  const existing = db.prepare('SELECT id FROM nt_rate_cards WHERE client_id = ?').get(clientId);
  const dataJson = JSON.stringify(data);
  if (existing) {
    db.prepare(`
      UPDATE nt_rate_cards SET currency = ?, data_json = ?, prepared_by = ?, prepared_title = ?, issued_date = ?, updated_at = datetime('now')
      WHERE client_id = ?
    `).run(currency || 'USD', dataJson, preparedBy || '', preparedTitle || '', issuedDate || '', clientId);
  } else {
    db.prepare(`
      INSERT INTO nt_rate_cards (id, client_id, currency, data_json, prepared_by, prepared_title, issued_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uid('ratecard'), clientId, currency || 'USD', dataJson, preparedBy || '', preparedTitle || '', issuedDate || '');
  }
  return getRateCardForClient(clientId);
}

function sgToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

function shiftIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isIso(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function eachDay(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to && out.length < 400) {
    out.push(cur);
    cur = shiftIso(cur, 1);
  }
  return out;
}

function fillSeries(from, to, rows) {
  const map = new Map((rows || []).map((r) => [String(r.date), Number(r.n) || 0]));
  return eachDay(from, to).map((date) => ({ date, n: map.get(date) || 0 }));
}

function sumN(rows) {
  return rows.reduce((s, r) => s + (Number(r.n) || 0), 0);
}

// Day buckets are Singapore calendar days. Totals are COUNT(*) from nt_orders —
// a zero is a real zero, never a placeholder.
function getCharts({ clientId, from, to, day } = {}) {
  const today = sgToday();
  const dayKey = isIso(day) ? day : today;
  let toKey = isIso(to) ? to : today;
  let fromKey = isIso(from) ? from : shiftIso(toKey, -13);
  if (fromKey > toKey) fromKey = toKey;
  const windowDays = eachDay(fromKey, toKey);
  if (windowDays.length) toKey = windowDays[windowDays.length - 1];

  const scope = clientId ? 'client_id = ?' : '1=1';
  const oScope = clientId ? 'o.client_id = ?' : '1=1';
  const base = clientId ? [clientId] : [];

  const ordersInDay = Number(db.prepare(
    `SELECT COUNT(*) AS n FROM nt_orders WHERE ${scope} AND order_date = ?`
  ).get(...base, dayKey).n) || 0;

  const orderRows = db.prepare(`
    SELECT order_date AS date, COUNT(*) AS n FROM nt_orders
    WHERE ${scope} AND order_date >= ? AND order_date <= ?
    GROUP BY order_date
  `).all(...base, fromKey, toKey);

  const deliveryRows = db.prepare(`
    SELECT done_day AS date, COUNT(*) AS n FROM (
      SELECT COALESCE(
        (SELECT MIN(substr(e.created_at, 1, 10)) FROM nt_order_events e
          WHERE e.order_id = o.id AND e.status IN ('shipped', 'completed')),
        substr(o.updated_at, 1, 10)
      ) AS done_day
      FROM nt_orders o
      WHERE ${oScope} AND o.status IN ('shipped', 'completed')
    ) t
    WHERE done_day >= ? AND done_day <= ?
    GROUP BY done_day
  `).all(...base, fromKey, toKey);

  const lateRows = db.prepare(`
    SELECT due_date AS date, COUNT(*) AS n FROM (
      SELECT o.due_date, o.status,
        COALESCE(
          (SELECT MIN(substr(e.created_at, 1, 10)) FROM nt_order_events e
            WHERE e.order_id = o.id AND e.status IN ('shipped', 'completed')),
          substr(o.updated_at, 1, 10)
        ) AS done_day
      FROM nt_orders o
      WHERE ${oScope} AND o.due_date <> '' AND o.due_date >= ? AND o.due_date <= ?
    ) t
    WHERE (status NOT IN ('shipped', 'completed') AND due_date < ?)
       OR (status IN ('shipped', 'completed') AND done_day > due_date)
    GROUP BY due_date
  `).all(...base, fromKey, toKey, today);

  const ordersByDay = fillSeries(fromKey, toKey, orderRows);
  const deliveriesByDay = fillSeries(fromKey, toKey, deliveryRows);
  const lateByDay = fillSeries(fromKey, toKey, lateRows);

  return {
    day: dayKey,
    from: fromKey,
    to: toKey,
    today,
    ordersInDay,
    ordersOnDay: [{ date: dayKey, n: ordersInDay }],
    ordersByDay,
    ordersInPeriod: sumN(ordersByDay),
    deliveriesCompleted: sumN(deliveriesByDay),
    deliveriesByDay,
    lateDeliveries: sumN(lateByDay),
    lateByDay,
  };
}

module.exports = {
  STATUSES,
  ORDER_FLOW,
  STATUS_LABEL,
  COUNTRY_NAMES,
  uid,
  getDashboardCounts,
  getCountryBreakdown,
  getGlobalLocationBreakdown,
  getMonthlyBreakdown,
  getCharts,
  getRateCardForClient,
  upsertRateCard,
  listOrders,
  createOrder,
  bulkCreateOrders,
  updateOrderStatus,
  getOrderTimeline,
  logOrderEvent,
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
  getRatesForClient,
  getAllRatesForStaff,
  upsertRate,
  listInboundForClient,
  listAllInboundForStaff,
  createInbound,
  updateInboundByStaff,
  getInboundTimelineForClient,
};
