'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Inventory store (System A) — ported from the previous IdealOne app.
//
//  Self-contained and ADDITIVE: it keeps its own SQLite database
//  (data/inventory.db) and never touches the base app's db.json. If
//  better-sqlite3 is unavailable, the module degrades to a no-op so it can
//  never crash the host app at require-time.
//
//  Stock model (unchanged from the original):
//    available_qty = max(0, stock_qty - reserved_qty)   (computed on read)
//    inbound / return → +stock_qty ; allocate → +reserved ; ship → -both
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs   = require('fs');

let Database = null;
try { Database = require('better-sqlite3'); } catch (_) { /* degrade gracefully */ }

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'inventory.db');

let db = null;
let _seeded = false;

function available() { return !!db; }

function init() {
  if (db || !Database) return db;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS inventory (
        sku           TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT DEFAULT '',
        category      TEXT DEFAULT '',
        unit          TEXT DEFAULT 'pcs',
        location      TEXT DEFAULT '',
        stock_qty     INTEGER DEFAULT 0,
        reserved_qty  INTEGER DEFAULT 0,
        reorder_point INTEGER DEFAULT 10,
        cost_price    REAL DEFAULT 0,
        sell_price    REAL DEFAULT 0,
        updated_at    TEXT DEFAULT (datetime('now')),
        client_id     TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS stock_movements (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        sku      TEXT NOT NULL,
        type     TEXT NOT NULL,
        qty      INTEGER NOT NULL,
        reason   TEXT DEFAULT '',
        order_id TEXT DEFAULT NULL,
        at       TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mov_sku ON stock_movements(sku);
    `);
  } catch (e) {
    console.warn('[inventory] init failed — inventory disabled:', e.message);
    db = null;
  }
  return db;
}

// ── read helpers ────────────────────────────────────────────────────────────
function _avail(r) { return { ...r, available_qty: Math.max(0, r.stock_qty - r.reserved_qty) }; }

function getAll({ category, search, lowStock, clientId } = {}) {
  if (!db) return [];
  let rows = db.prepare('SELECT * FROM inventory ORDER BY name ASC').all().map(_avail);
  if (category) rows = rows.filter(r => r.category === category);
  if (search)   { const q = String(search).toLowerCase(); rows = rows.filter(r => r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)); }
  if (lowStock) rows = rows.filter(r => r.available_qty <= r.reorder_point);
  if (clientId) rows = rows.filter(r => r.client_id === clientId);
  return rows;
}

function get(sku) {
  if (!db) return null;
  const r = db.prepare('SELECT * FROM inventory WHERE sku = ?').get(sku);
  return r ? _avail(r) : null;
}

function upsert(data) {
  if (!db) throw new Error('inventory unavailable');
  const { sku, name, description = '', category = '', unit = 'pcs', location = '',
          stock_qty = 0, reserved_qty = 0, reorder_point = 10, cost_price = 0,
          sell_price = 0, client_id = '' } = data;
  if (!sku || !name) throw new Error('sku and name are required');
  db.prepare(`INSERT INTO inventory (sku,name,description,category,unit,location,stock_qty,reserved_qty,reorder_point,cost_price,sell_price,client_id,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET name=excluded.name,description=excluded.description,category=excluded.category,
      unit=excluded.unit,location=excluded.location,stock_qty=excluded.stock_qty,reserved_qty=excluded.reserved_qty,
      reorder_point=excluded.reorder_point,cost_price=excluded.cost_price,sell_price=excluded.sell_price,client_id=excluded.client_id,updated_at=datetime('now')`)
    .run(sku, name, description, category, unit, location, Number(stock_qty), Number(reserved_qty), Number(reorder_point), Number(cost_price), Number(sell_price), client_id);
  return get(sku);
}

function remove(sku) { if (db) db.prepare('DELETE FROM inventory WHERE sku = ?').run(sku); }

function adjust(sku, qty, type = 'adjustment', reason = '', orderId = null) {
  if (!db) throw new Error('inventory unavailable');
  const item = get(sku);
  if (!item) throw new Error('SKU ' + sku + ' not found');
  const newQty = Math.max(0, item.stock_qty + Number(qty));
  db.prepare("UPDATE inventory SET stock_qty=?, updated_at=datetime('now') WHERE sku=?").run(newQty, sku);
  db.prepare('INSERT INTO stock_movements (sku,type,qty,reason,order_id) VALUES (?,?,?,?,?)').run(sku, type, Number(qty), reason, orderId);
  return get(sku);
}

// Order lifecycle hooks (available for wiring the ship flow later — additive,
// not yet called by the base). order = { id, items:[{sku, qty}] }
function reserveOrder(order) {
  if (!db) return [];
  return db.transaction(() => {
    const out = [];
    for (const item of (order.items || [])) {
      if (!item.sku) continue;
      const inv = get(item.sku);
      if (!inv) { out.push({ sku: item.sku, ok: false, error: 'SKU not found' }); continue; }
      const newReserved = inv.reserved_qty + Number(item.qty);
      db.prepare("UPDATE inventory SET reserved_qty=?, updated_at=datetime('now') WHERE sku=?").run(newReserved, item.sku);
      db.prepare('INSERT INTO stock_movements (sku,type,qty,reason,order_id) VALUES (?,?,?,?,?)').run(item.sku, 'reserve', Number(item.qty), 'Reserved for ' + order.id, order.id);
      out.push({ sku: item.sku, ok: true, reservedQty: newReserved });
    }
    return out;
  })();
}

function deductOrder(order) {
  if (!db) return [];
  return db.transaction(() => {
    const out = [];
    for (const item of (order.items || [])) {
      if (!item.sku) continue;
      const inv = get(item.sku);
      if (!inv) { out.push({ sku: item.sku, ok: false, error: 'SKU not found' }); continue; }
      const qty = Number(item.qty);
      db.prepare("UPDATE inventory SET stock_qty=?, reserved_qty=?, updated_at=datetime('now') WHERE sku=?")
        .run(Math.max(0, inv.stock_qty - qty), Math.max(0, inv.reserved_qty - qty), item.sku);
      db.prepare('INSERT INTO stock_movements (sku,type,qty,reason,order_id) VALUES (?,?,?,?,?)').run(item.sku, 'outbound', -qty, 'Shipped ' + order.id, order.id);
      out.push({ sku: item.sku, ok: true });
    }
    return out;
  })();
}

function movements(sku, limit = 50) {
  if (!db) return [];
  return db.prepare('SELECT * FROM stock_movements WHERE sku = ? ORDER BY at DESC LIMIT ?').all(sku, Number(limit) || 50);
}

function getStats({ clientId } = {}) {
  if (!db) return { totalSKUs: 0, lowStock: 0, outOfStock: 0, totalValue: 0, totalReserved: 0, categories: [] };
  let rows = db.prepare('SELECT * FROM inventory').all().map(_avail);
  if (clientId) rows = rows.filter(r => r.client_id === clientId);
  const lowStock   = rows.filter(r => r.available_qty <= r.reorder_point && r.available_qty > 0);
  const outOfStock = rows.filter(r => r.available_qty === 0);
  return {
    totalSKUs:     rows.length,
    lowStock:      lowStock.length,
    outOfStock:    outOfStock.length,
    totalValue:    rows.reduce((s, r) => s + r.available_qty * r.cost_price, 0),
    totalReserved: rows.reduce((s, r) => s + r.reserved_qty, 0),
    categories:    [...new Set(rows.map(r => r.category).filter(Boolean))],
    clientId,
  };
}

// velocity — parameterised (original interpolated clientId/limit into SQL)
function velocity(limit = 20, clientId = null) {
  if (!db) return [];
  let sql = `SELECT sm.sku, SUM(ABS(sm.qty)) as total_out, i.name, i.category, i.client_id
    FROM stock_movements sm LEFT JOIN inventory i ON i.sku = sm.sku
    WHERE sm.type = 'outbound'`;
  const params = [];
  if (clientId) { sql += ' AND i.client_id = ?'; params.push(clientId); }
  sql += ' GROUP BY sm.sku ORDER BY total_out DESC LIMIT ?';
  params.push(Number(limit) || 20);
  return db.prepare(sql).all(...params);
}

// One-time seed of the item catalog from the base's SKU→description map, so the
// page comes up populated with real SKUs at zero stock (ready to receive/adjust).
function seedFromSkuMap(skuDescMap) {
  if (!db || _seeded) return 0;
  const existing = db.prepare('SELECT COUNT(*) c FROM inventory').get().c;
  if (existing > 0) { _seeded = true; return 0; }
  const entries = Object.entries(skuDescMap || {});
  if (!entries.length) return 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO inventory (sku,name,description) VALUES (?,?,?)`);
  const tx = db.transaction(rows => { for (const [sku, desc] of rows) stmt.run(sku, desc || sku, desc || ''); });
  tx(entries);
  _seeded = true;
  return entries.length;
}

module.exports = {
  init, available, DB_PATH,
  getAll, get, upsert, remove, adjust, reserveOrder, deductOrder, movements, getStats, velocity,
  seedFromSkuMap,
};
