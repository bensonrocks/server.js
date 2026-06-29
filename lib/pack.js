'use strict';

// Odoo-aligned Pick → Pack → Ship workflow
// Stages mirror stock.picking → pack.operation → stock.delivery in Odoo

const { randomUUID } = require('crypto');
const db = require('./db');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS pack_orders (
    id            TEXT PRIMARY KEY,
    pack_number   TEXT NOT NULL,
    wave_id       TEXT NOT NULL,
    order_id      TEXT NOT NULL,
    client_name   TEXT NOT NULL DEFAULT '',
    channel       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending',
    packer_id     TEXT DEFAULT '',
    total_items   INTEGER DEFAULT 0,
    packed_items  INTEGER DEFAULT 0,
    box_count     INTEGER DEFAULT 0,
    notes         TEXT DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    packed_at     TEXT DEFAULT NULL,
    FOREIGN KEY (wave_id) REFERENCES pick_waves(id)
  );

  CREATE TABLE IF NOT EXISTS pack_boxes (
    id            TEXT PRIMARY KEY,
    pack_order_id TEXT NOT NULL,
    box_number    INTEGER NOT NULL,
    sscc          TEXT DEFAULT '',
    weight_kg     REAL DEFAULT 0,
    length_cm     REAL DEFAULT 0,
    width_cm      REAL DEFAULT 0,
    height_cm     REAL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (pack_order_id) REFERENCES pack_orders(id)
  );

  CREATE TABLE IF NOT EXISTS pack_box_items (
    id            TEXT PRIMARY KEY,
    box_id        TEXT NOT NULL,
    pack_order_id TEXT NOT NULL,
    sku           TEXT NOT NULL,
    item_name     TEXT NOT NULL DEFAULT '',
    qty           REAL NOT NULL DEFAULT 0,
    lot_number    TEXT DEFAULT '',
    expiry_date   TEXT DEFAULT '',
    FOREIGN KEY (box_id) REFERENCES pack_boxes(id)
  );

  CREATE TABLE IF NOT EXISTS shipments (
    id                TEXT PRIMARY KEY,
    shipment_number   TEXT NOT NULL,
    pack_order_id     TEXT NOT NULL,
    order_id          TEXT NOT NULL,
    client_name       TEXT NOT NULL DEFAULT '',
    carrier           TEXT DEFAULT '',
    service           TEXT DEFAULT '',
    tracking_no       TEXT DEFAULT '',
    weight_kg         REAL DEFAULT 0,
    box_count         INTEGER DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending',
    recipient_name    TEXT DEFAULT '',
    address_line1     TEXT DEFAULT '',
    address_line2     TEXT DEFAULT '',
    city              TEXT DEFAULT '',
    state_region      TEXT DEFAULT '',
    zip               TEXT DEFAULT '',
    country           TEXT DEFAULT '',
    shipped_at        TEXT DEFAULT NULL,
    est_delivery      TEXT DEFAULT NULL,
    notes             TEXT DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (pack_order_id) REFERENCES pack_orders(id)
  );
`);

// ── Number generators ─────────────────────────────────────────────────────────

function nextPackNumber() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM pack_orders WHERE pack_number LIKE ?`).get(`PK${today}%`);
  return `PK${today}-${String(n + 1).padStart(3, '0')}`;
}

function nextShipmentNumber() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM shipments WHERE shipment_number LIKE ?`).get(`SH${today}%`);
  return `SH${today}-${String(n + 1).padStart(3, '0')}`;
}

// GS1 SSCC (Serial Shipping Container Code) — 18-digit format
// (00) + ext(1) + company(7) + serial(9) + check(1)
function generateSSCC(serial) {
  const companyPrefix = '9990001'; // demo GS1 prefix
  const digits = '0' + companyPrefix + String(serial).padStart(9, '0');
  // Luhn-mod10 check digit
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += parseInt(digits[i]) * (i % 2 === 0 ? 3 : 1);
  }
  const check = (10 - (sum % 10)) % 10;
  return digits + check;
}

// ── Pack Orders — created per sales order when a wave completes ───────────────

function createPackOrdersFromWave(waveId) {
  const wave   = db.prepare('SELECT * FROM pick_waves WHERE id = ?').get(waveId);
  if (!wave) throw new Error('Wave not found');
  if (wave.status !== 'completed') throw new Error('Wave must be completed before packing');

  const existing = db.prepare('SELECT id FROM pack_orders WHERE wave_id = ?').all(waveId);
  if (existing.length) throw new Error('Pack orders already created for this wave');

  // Group completed pick tasks by order
  const tasks = db.prepare(`
    SELECT t.*, o.client_name, o.client_id, o.channel, o.shipping
    FROM pick_tasks t
    JOIN orders o ON o.id = t.order_id
    WHERE t.wave_id = ? AND t.status IN ('picked','short')
    ORDER BY t.order_id, t.sku
  `).all(waveId);

  if (!tasks.length) throw new Error('No picked tasks found in this wave');

  const byOrder = {};
  for (const t of tasks) {
    if (!byOrder[t.order_id]) byOrder[t.order_id] = { tasks: [], clientName: t.client_name, channel: t.channel, shipping: t.shipping };
    byOrder[t.order_id].tasks.push(t);
  }

  const created = [];
  db.transaction(() => {
    let packSerial = db.prepare('SELECT COUNT(*) AS n FROM pack_orders').get().n;
    for (const [orderId, group] of Object.entries(byOrder)) {
      const packId     = randomUUID();
      const packNumber = nextPackNumber();
      const totalItems = group.tasks.reduce((s, t) => s + t.qty_picked, 0);

      db.prepare(`
        INSERT INTO pack_orders (id, pack_number, wave_id, order_id, client_name, channel, status, total_items)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(packId, packNumber, waveId, orderId, group.clientName, group.channel, totalItems);

      created.push({ packId, packNumber, orderId, clientName: group.clientName });
    }
  })();

  return created;
}

function listPackOrders({ status, waveId } = {}) {
  let sql = 'SELECT * FROM pack_orders WHERE 1=1';
  const params = [];
  if (status)  { sql += ' AND status = ?';   params.push(status); }
  if (waveId)  { sql += ' AND wave_id = ?';  params.push(waveId); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

function getPackOrder(id) {
  const po = db.prepare('SELECT * FROM pack_orders WHERE id = ?').get(id);
  if (!po) return null;

  const boxes = db.prepare('SELECT * FROM pack_boxes WHERE pack_order_id = ? ORDER BY box_number').all(id);
  for (const box of boxes) {
    box.items = db.prepare('SELECT * FROM pack_box_items WHERE box_id = ?').all(box.id);
  }

  const pickedTasks = db.prepare(`
    SELECT sku, item_name, SUM(qty_picked) AS qty_picked, SUM(qty_required) AS qty_required
    FROM pick_tasks WHERE wave_id = (SELECT wave_id FROM pack_orders WHERE id = ?)
      AND order_id = (SELECT order_id FROM pack_orders WHERE id = ?)
      AND status IN ('picked','short')
    GROUP BY sku, item_name
  `).all(id, id);

  const shipment = db.prepare('SELECT * FROM shipments WHERE pack_order_id = ?').get(id);
  const order    = db.prepare('SELECT shipping, notes FROM orders WHERE id = ?').get(po.order_id);

  return { ...po, boxes, pickedItems: pickedTasks, shipment: shipment || null, shipping: order ? JSON.parse(order.shipping || '{}') : {}, orderNotes: order?.notes || '' };
}

// ── Box management ────────────────────────────────────────────────────────────

function addBox(packOrderId, { weight_kg = 0, length_cm = 0, width_cm = 0, height_cm = 0 } = {}) {
  const po = db.prepare('SELECT * FROM pack_orders WHERE id = ?').get(packOrderId);
  if (!po) throw new Error('Pack order not found');
  if (po.status === 'packed' || po.status === 'shipped') throw new Error('Pack order is already closed');

  const { n: boxCount } = db.prepare('SELECT COUNT(*) AS n FROM pack_boxes WHERE pack_order_id = ?').get(packOrderId);
  const boxNumber = boxCount + 1;
  const sscc      = generateSSCC(Date.now() % 1e9);
  const boxId     = randomUUID();

  db.prepare(`
    INSERT INTO pack_boxes (id, pack_order_id, box_number, sscc, weight_kg, length_cm, width_cm, height_cm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(boxId, packOrderId, boxNumber, sscc, weight_kg, length_cm, width_cm, height_cm);

  db.prepare(`UPDATE pack_orders SET box_count = box_count + 1, status = 'packing' WHERE id = ?`).run(packOrderId);

  return db.prepare('SELECT * FROM pack_boxes WHERE id = ?').get(boxId);
}

function updateBox(boxId, { weight_kg, length_cm, width_cm, height_cm }) {
  db.prepare(`
    UPDATE pack_boxes SET
      weight_kg  = COALESCE(?, weight_kg),
      length_cm  = COALESCE(?, length_cm),
      width_cm   = COALESCE(?, width_cm),
      height_cm  = COALESCE(?, height_cm)
    WHERE id = ?
  `).run(weight_kg ?? null, length_cm ?? null, width_cm ?? null, height_cm ?? null, boxId);
  return db.prepare('SELECT * FROM pack_boxes WHERE id = ?').get(boxId);
}

function addItemToBox(boxId, { sku, item_name, qty, lot_number = '', expiry_date = '' }) {
  const box = db.prepare('SELECT * FROM pack_boxes WHERE id = ?').get(boxId);
  if (!box) throw new Error('Box not found');
  if (!sku || !qty) throw new Error('sku and qty required');

  const itemId = randomUUID();
  db.prepare(`
    INSERT INTO pack_box_items (id, box_id, pack_order_id, sku, item_name, qty, lot_number, expiry_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(itemId, boxId, box.pack_order_id, sku, item_name || sku, qty, lot_number, expiry_date);

  db.prepare(`UPDATE pack_orders SET packed_items = packed_items + ?, status='packing' WHERE id = ?`).run(qty, box.pack_order_id);

  return db.prepare('SELECT * FROM pack_box_items WHERE id = ?').get(itemId);
}

function completePackOrder(packOrderId) {
  const po = db.prepare('SELECT * FROM pack_orders WHERE id = ?').get(packOrderId);
  if (!po) throw new Error('Pack order not found');
  if (po.status === 'packed' || po.status === 'shipped') throw new Error('Already completed');

  db.prepare(`UPDATE pack_orders SET status='packed', packed_at=datetime('now') WHERE id=?`).run(packOrderId);
  return getPackOrder(packOrderId);
}

// ── Shipments ─────────────────────────────────────────────────────────────────

function createShipment(packOrderId, { carrier = '', service = '', tracking_no = '', est_delivery = '', notes = '' } = {}) {
  const po = db.prepare('SELECT * FROM pack_orders WHERE id = ?').get(packOrderId);
  if (!po) throw new Error('Pack order not found');
  if (po.status !== 'packed') throw new Error('Pack order must be in "packed" status first');

  const existing = db.prepare('SELECT id FROM shipments WHERE pack_order_id = ?').get(packOrderId);
  if (existing) throw new Error('Shipment already exists for this pack order');

  const order   = db.prepare('SELECT shipping FROM orders WHERE id = ?').get(po.order_id);
  const ship    = order ? JSON.parse(order.shipping || '{}') : {};
  const boxes   = db.prepare('SELECT * FROM pack_boxes WHERE pack_order_id = ?').all(packOrderId);
  const totalKg = boxes.reduce((s, b) => s + (b.weight_kg || 0), 0);

  const shipId = randomUUID();
  const shipNo = nextShipmentNumber();

  db.prepare(`
    INSERT INTO shipments
      (id, shipment_number, pack_order_id, order_id, client_name, carrier, service,
       tracking_no, weight_kg, box_count, status,
       recipient_name, address_line1, address_line2, city, state_region, zip, country,
       est_delivery, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    shipId, shipNo, packOrderId, po.order_id, po.client_name,
    carrier, service, tracking_no, totalKg, boxes.length, 'pending',
    ship.recipient || '', ship.addressLine1 || '', ship.addressLine2 || '',
    ship.city || '', ship.state || '', ship.zip || '', ship.country || '',
    est_delivery, notes
  );

  db.prepare(`UPDATE pack_orders SET status='shipped' WHERE id=?`).run(packOrderId);

  return db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipId);
}

function updateShipment(shipmentId, { carrier, service, tracking_no, status, shipped_at, est_delivery, notes }) {
  const s = db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipmentId);
  if (!s) throw new Error('Shipment not found');

  const newStatus = status || s.status;
  const newShippedAt = newStatus === 'in_transit' && !s.shipped_at
    ? new Date().toISOString()
    : (shipped_at || s.shipped_at);

  db.prepare(`
    UPDATE shipments SET
      carrier    = COALESCE(?, carrier),
      service    = COALESCE(?, service),
      tracking_no= COALESCE(?, tracking_no),
      status     = ?,
      shipped_at = ?,
      est_delivery = COALESCE(?, est_delivery),
      notes      = COALESCE(?, notes)
    WHERE id = ?
  `).run(carrier ?? null, service ?? null, tracking_no ?? null, newStatus, newShippedAt, est_delivery ?? null, notes ?? null, shipmentId);

  return db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipmentId);
}

function listShipments({ status } = {}) {
  let sql = 'SELECT * FROM shipments WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

function getShipment(id) {
  const s = db.prepare('SELECT * FROM shipments WHERE id = ?').get(id);
  if (!s) return null;
  const po   = getPackOrder(s.pack_order_id);
  return { ...s, packOrder: po };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function getPackStats() {
  const po  = db.prepare('SELECT status, COUNT(*) AS n FROM pack_orders GROUP BY status').all();
  const sh  = db.prepare('SELECT status, COUNT(*) AS n FROM shipments   GROUP BY status').all();
  const poMap = {}, shMap = {};
  for (const r of po) poMap[r.status] = r.n;
  for (const r of sh) shMap[r.status] = r.n;
  return {
    packOrders: { pending: poMap.pending||0, packing: poMap.packing||0, packed: poMap.packed||0, shipped: poMap.shipped||0 },
    shipments:  { pending: shMap.pending||0, in_transit: shMap.in_transit||0, delivered: shMap.delivered||0 },
  };
}

// ── Print helpers — GS1-aligned document data ─────────────────────────────────

function getPickListData(waveId) {
  const wave  = db.prepare('SELECT * FROM pick_waves WHERE id = ?').get(waveId);
  if (!wave) throw new Error('Wave not found');
  const tasks = db.prepare(`
    SELECT t.*, o.client_name, o.shipping
    FROM pick_tasks t JOIN orders o ON o.id = t.order_id
    WHERE t.wave_id = ? ORDER BY t.location, t.sku
  `).all(waveId);
  return { wave, tasks };
}

function getPackingSlipData(packOrderId) {
  return getPackOrder(packOrderId);
}

function getDeliveryNoteData(shipmentId) {
  return getShipment(shipmentId);
}

module.exports = {
  createPackOrdersFromWave,
  listPackOrders, getPackOrder,
  addBox, updateBox, addItemToBox, completePackOrder,
  createShipment, updateShipment, listShipments, getShipment,
  getPackStats,
  getPickListData, getPackingSlipData, getDeliveryNoteData,
};
