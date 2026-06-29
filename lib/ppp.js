'use strict';

// Scan-based Pick-and-Pack workflow
// Operator opens a package by scanning its HU (Handling Unit) barcode,
// scans products into it, then closes the package by scanning the same HU again.
// Repeats for as many cartons as needed. At the end, generates:
//   - Per-box packing list
//   - Master packing list (carton manifest) showing CTN x of y

const { randomUUID } = require('crypto');
const db = require('./db');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS scan_sessions (
    id           TEXT PRIMARY KEY,
    order_id     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    operator_id  TEXT DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at    TEXT DEFAULT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS scan_cartons (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    order_id     TEXT NOT NULL,
    hu_code      TEXT NOT NULL,
    carton_seq   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    weight_kg    REAL DEFAULT 0,
    length_cm    REAL DEFAULT 0,
    width_cm     REAL DEFAULT 0,
    height_cm    REAL DEFAULT 0,
    opened_at    TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at    TEXT DEFAULT NULL,
    notes        TEXT DEFAULT '',
    FOREIGN KEY (session_id) REFERENCES scan_sessions(id)
  );

  CREATE TABLE IF NOT EXISTS scan_carton_items (
    id           TEXT PRIMARY KEY,
    carton_id    TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    order_id     TEXT NOT NULL,
    sku          TEXT NOT NULL,
    item_name    TEXT DEFAULT '',
    qty          REAL NOT NULL DEFAULT 1,
    lot_number   TEXT DEFAULT '',
    expiry_date  TEXT DEFAULT '',
    scanned_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (carton_id) REFERENCES scan_cartons(id)
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSession(sessionId) {
  const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
  if (!s) return null;
  const cartons = db.prepare(
    'SELECT * FROM scan_cartons WHERE session_id = ? ORDER BY carton_seq'
  ).all(sessionId);
  for (const c of cartons) {
    c.items = db.prepare(
      'SELECT * FROM scan_carton_items WHERE carton_id = ? ORDER BY scanned_at'
    ).all(c.id);
    c.item_count = c.items.reduce((s, i) => s + i.qty, 0);
  }
  const order = db.prepare('SELECT id, order_number, client_name, status, shipping FROM orders WHERE id = ?').get(s.order_id);
  return { ...s, cartons, order: order ? { ...order, shipping: JSON.parse(order.shipping || '{}') } : null };
}

function getOpenCarton(sessionId) {
  return db.prepare(
    "SELECT * FROM scan_cartons WHERE session_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1"
  ).get(sessionId);
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

function openSession(orderId, operatorId = '') {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');

  const existing = db.prepare(
    "SELECT id FROM scan_sessions WHERE order_id = ? AND status = 'open'"
  ).get(orderId);
  if (existing) return getSession(existing.id);

  const id = randomUUID();
  db.prepare(
    "INSERT INTO scan_sessions (id, order_id, operator_id) VALUES (?, ?, ?)"
  ).run(id, orderId, operatorId);
  return getSession(id);
}

function closeSession(sessionId) {
  const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
  if (!s) throw new Error('Session not found');
  const openCarton = getOpenCarton(sessionId);
  if (openCarton) throw new Error('Close the current carton before closing the session');

  db.prepare(
    "UPDATE scan_sessions SET status='closed', closed_at=datetime('now') WHERE id=?"
  ).run(sessionId);
  return getSession(sessionId);
}

function listSessions({ status, orderId } = {}) {
  let sql = `
    SELECT s.*, o.order_number, o.client_name,
      (SELECT COUNT(*) FROM scan_cartons WHERE session_id = s.id) AS carton_count,
      (SELECT COUNT(*) FROM scan_carton_items WHERE session_id = s.id) AS item_count
    FROM scan_sessions s
    JOIN orders o ON o.id = s.order_id
    WHERE 1=1
  `;
  const params = [];
  if (status)  { sql += ' AND s.status = ?';   params.push(status); }
  if (orderId) { sql += ' AND s.order_id = ?'; params.push(orderId); }
  sql += ' ORDER BY s.created_at DESC';
  return db.prepare(sql).all(...params);
}

// ── HU scan — open or close a carton ─────────────────────────────────────────

function scanHU(sessionId, huCode) {
  const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
  if (!s) throw new Error('Session not found');
  if (s.status === 'closed') throw new Error('Session is already closed');

  const openCarton = getOpenCarton(sessionId);

  if (openCarton) {
    if (openCarton.hu_code !== huCode) {
      throw new Error(`Wrong HU code. Expected "${openCarton.hu_code}" to close current carton, or close it first`);
    }
    // Close the current carton
    db.prepare(
      "UPDATE scan_cartons SET status='closed', closed_at=datetime('now') WHERE id=?"
    ).run(openCarton.id);
    const closed = db.prepare('SELECT * FROM scan_cartons WHERE id=?').get(openCarton.id);
    closed.items = db.prepare('SELECT * FROM scan_carton_items WHERE carton_id=?').all(openCarton.id);
    closed.item_count = closed.items.reduce((s, i) => s + i.qty, 0);
    return { action: 'closed', carton: closed };
  } else {
    // Open a new carton with this HU code
    const { n: seq } = db.prepare(
      'SELECT COUNT(*) AS n FROM scan_cartons WHERE session_id = ?'
    ).get(sessionId);
    const cartonId = randomUUID();
    db.prepare(`
      INSERT INTO scan_cartons (id, session_id, order_id, hu_code, carton_seq)
      VALUES (?, ?, ?, ?, ?)
    `).run(cartonId, sessionId, s.order_id, huCode, seq + 1);
    const carton = db.prepare('SELECT * FROM scan_cartons WHERE id=?').get(cartonId);
    carton.items = [];
    carton.item_count = 0;
    return { action: 'opened', carton };
  }
}

// ── Product scan — add item to open carton ────────────────────────────────────

function scanItem(sessionId, { sku, qty = 1, item_name = '', lot_number = '', expiry_date = '' }) {
  const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
  if (!s) throw new Error('Session not found');

  const openCarton = getOpenCarton(sessionId);
  if (!openCarton) throw new Error('No open carton. Scan a HU label first to open a carton');

  if (!sku) throw new Error('SKU is required');

  // Look up item_name from inventory if not provided
  if (!item_name) {
    const inv = db.prepare('SELECT item_name FROM inventory WHERE sku = ?').get(sku);
    item_name = inv ? inv.item_name : sku;
  }

  // Check if this SKU already exists in this carton — merge qty
  const existing = db.prepare(
    'SELECT * FROM scan_carton_items WHERE carton_id = ? AND sku = ? AND lot_number = ?'
  ).get(openCarton.id, sku, lot_number);

  let item;
  if (existing) {
    db.prepare('UPDATE scan_carton_items SET qty = qty + ? WHERE id = ?').run(qty, existing.id);
    item = db.prepare('SELECT * FROM scan_carton_items WHERE id = ?').get(existing.id);
  } else {
    const itemId = randomUUID();
    db.prepare(`
      INSERT INTO scan_carton_items (id, carton_id, session_id, order_id, sku, item_name, qty, lot_number, expiry_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, openCarton.id, sessionId, s.order_id, sku, item_name, qty, lot_number, expiry_date);
    item = db.prepare('SELECT * FROM scan_carton_items WHERE id = ?').get(itemId);
  }

  const cartonItems = db.prepare('SELECT * FROM scan_carton_items WHERE carton_id = ?').all(openCarton.id);
  return { item, carton: { ...openCarton, items: cartonItems, item_count: cartonItems.reduce((s, i) => s + i.qty, 0) } };
}

function removeItem(itemId) {
  const item = db.prepare('SELECT * FROM scan_carton_items WHERE id = ?').get(itemId);
  if (!item) throw new Error('Item not found');
  const carton = db.prepare('SELECT * FROM scan_cartons WHERE id = ?').get(item.carton_id);
  if (carton && carton.status !== 'open') throw new Error('Cannot remove items from a closed carton');
  db.prepare('DELETE FROM scan_carton_items WHERE id = ?').run(itemId);
  return { removed: true, itemId };
}

function updateCartonDimensions(cartonId, { weight_kg, length_cm, width_cm, height_cm, notes }) {
  db.prepare(`
    UPDATE scan_cartons SET
      weight_kg  = COALESCE(?, weight_kg),
      length_cm  = COALESCE(?, length_cm),
      width_cm   = COALESCE(?, width_cm),
      height_cm  = COALESCE(?, height_cm),
      notes      = COALESCE(?, notes)
    WHERE id = ?
  `).run(weight_kg ?? null, length_cm ?? null, width_cm ?? null, height_cm ?? null, notes ?? null, cartonId);
  return db.prepare('SELECT * FROM scan_cartons WHERE id = ?').get(cartonId);
}

// ── Print data ─────────────────────────────────────────────────────────────────

function getCartonPackingListData(cartonId) {
  const c = db.prepare('SELECT * FROM scan_cartons WHERE id = ?').get(cartonId);
  if (!c) throw new Error('Carton not found');
  c.items = db.prepare('SELECT * FROM scan_carton_items WHERE carton_id = ? ORDER BY sku').all(cartonId);
  const session = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(c.session_id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(c.order_id);
  const totalCartons = db.prepare('SELECT COUNT(*) AS n FROM scan_cartons WHERE session_id = ?').get(c.session_id).n;
  return { carton: c, session, order: order ? { ...order, shipping: JSON.parse(order.shipping || '{}') } : {}, totalCartons };
}

function getMasterPackingListData(sessionId) {
  const s = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
  if (!s) throw new Error('Session not found');
  const cartons = db.prepare(
    'SELECT * FROM scan_cartons WHERE session_id = ? ORDER BY carton_seq'
  ).all(sessionId);
  for (const c of cartons) {
    c.items = db.prepare('SELECT * FROM scan_carton_items WHERE carton_id = ? ORDER BY sku').all(c.id);
    c.item_count = c.items.reduce((sum, i) => sum + i.qty, 0);
  }
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(s.order_id);
  return {
    session: s,
    cartons,
    totalCartons: cartons.length,
    order: order ? { ...order, shipping: JSON.parse(order.shipping || '{}') } : {},
  };
}

module.exports = {
  openSession, closeSession, listSessions, getSession,
  scanHU, scanItem, removeItem, updateCartonDimensions,
  getCartonPackingListData, getMasterPackingListData,
};
