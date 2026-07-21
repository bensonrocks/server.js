'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Inventory store (System A) — ported from the previous IdealOne app.
//
//  TENANT-SCOPED: each tenant gets its own SQLite database
//  (data/tenants/<tenantId>/inventory.db), resolved per-call via the same
//  tenantContext the rest of the app uses (set once per request, right after
//  auth) — so this module's public API stays call-site-identical (getAll(),
//  get(sku), etc. — no tenantId argument needed anywhere) while never mixing
//  one tenant's stock with another's. Never touches any tenant's db.json.
//  If better-sqlite3 is unavailable, degrades to a no-op so it can never
//  crash the host app at require-time.
//
//  Stock model (unchanged from the original):
//    available_qty = max(0, stock_qty - reserved_qty)   (computed on read)
//    inbound / return → +stock_qty ; allocate → +reserved ; ship → -both
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs   = require('fs');
const tenantContext = require('./tenant-context');

let Database = null;
try { Database = require('better-sqlite3'); } catch (_) { /* degrade gracefully */ }

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const _dbByTenant = new Map();     // tenantId -> better-sqlite3 handle
const _seededByTenant = new Set(); // tenantId that has already run seedFromSkuMap

function _dbPathForTenant(tenantId) {
  return path.join(DATA_DIR, 'tenants', tenantId, 'inventory.db');
}

// ── Product Master fields (ULD_Product_Master_Template.xlsx) ────────────────
// Extends the base inventory row with the fields that template captures:
// barcode, brand/model, unit + carton dimensions/weight for storage (cbm)
// billing and courier selection, handling flags, and per-marketplace SKU
// cross-references (a channel's SKU only needs recording here when it
// differs from the master SKU code). [col, sqlType, jsDefault] — added via
// ALTER TABLE so an already-existing inventory.db (pre-dating this template)
// gains the columns without losing any data already in it.
const PRODUCT_MASTER_COLUMNS = [
  ['barcode', 'TEXT', ''], ['brand', 'TEXT', ''], ['model', 'TEXT', ''],
  ['units_per_carton', 'INTEGER', 1],
  ['unit_l', 'REAL', 0], ['unit_w', 'REAL', 0], ['unit_h', 'REAL', 0], ['unit_weight', 'REAL', 0],
  ['carton_l', 'REAL', 0], ['carton_w', 'REAL', 0], ['carton_h', 'REAL', 0], ['carton_weight', 'REAL', 0],
  ['fragile', 'INTEGER', 0], ['contains_battery', 'INTEGER', 0], ['serial_tracked', 'INTEGER', 0],
  ['platform_sku_shopee', 'TEXT', ''], ['platform_sku_lazada1', 'TEXT', ''], ['platform_sku_lazada2', 'TEXT', ''],
  ['platform_sku_tiktok', 'TEXT', ''], ['platform_sku_shopify', 'TEXT', ''], ['platform_sku_others', 'TEXT', ''],
  ['storage_remarks', 'TEXT', ''],
];
function _migrateProductMasterColumns(handle) {
  const existing = new Set(handle.prepare('PRAGMA table_info(inventory)').all().map(c => c.name));
  for (const [col, sqlType, dflt] of PRODUCT_MASTER_COLUMNS) {
    if (existing.has(col)) continue;
    const defaultSql = typeof dflt === 'string' ? `'${dflt}'` : dflt;
    handle.exec(`ALTER TABLE inventory ADD COLUMN ${col} ${sqlType} DEFAULT ${defaultSql}`);
  }
}

function available() { return !!Database && !!_open(); }

// Lazily opens (and creates the schema for) the CURRENT tenant's database.
function _open() {
  if (!Database) return null;
  const tenantId = tenantContext.currentTenantId();
  let handle = _dbByTenant.get(tenantId);
  if (handle) return handle;
  try {
    const dbPath = _dbPathForTenant(tenantId);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    handle = new Database(dbPath);
    handle.pragma('journal_mode = WAL');
    handle.exec(`
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
    _migrateProductMasterColumns(handle);
    _dbByTenant.set(tenantId, handle);
  } catch (e) {
    console.warn(`[inventory] init failed for tenant "${tenantId}" — inventory disabled:`, e.message);
    return null;
  }
  return handle;
}

// Kept for backward compatibility with the one existing call site
// (server.js calls inventory.init() once at boot, outside any request/tenant
// context — that's fine, it's a no-op warm-up; every real call still opens
// its own tenant's db lazily via _open() above).
function init() { return _open(); }

// ── read helpers ────────────────────────────────────────────────────────────
function _avail(r) { return { ...r, available_qty: Math.max(0, r.stock_qty - r.reserved_qty) }; }

function getAll({ category, search, lowStock, clientId } = {}) {
  const db = _open();
  if (!db) return [];
  let rows = db.prepare('SELECT * FROM inventory ORDER BY name ASC').all().map(_avail);
  if (category) rows = rows.filter(r => r.category === category);
  if (search)   { const q = String(search).toLowerCase(); rows = rows.filter(r => r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)); }
  if (lowStock) rows = rows.filter(r => r.available_qty <= r.reorder_point);
  if (clientId) rows = rows.filter(r => r.client_id === clientId);
  return rows;
}

function get(sku) {
  const db = _open();
  if (!db) return null;
  const r = db.prepare('SELECT * FROM inventory WHERE sku = ?').get(sku);
  return r ? _avail(r) : null;
}

// Base columns always accepted by upsert(); Product Master columns
// (PRODUCT_MASTER_COLUMNS) are appended dynamically below so adding a new
// template field only ever needs a change in ONE place (that list).
function _num(v, dflt) { return (v === undefined || v === null || v === '') ? dflt : (Number(v) || 0); }
const _BASE_COLUMNS = [
  ['name', 'TEXT', v => String(v)], ['description', 'TEXT', v => String(v ?? '')],
  ['category', 'TEXT', v => String(v ?? '')], ['unit', 'TEXT', v => String(v ?? 'pcs')],
  ['location', 'TEXT', v => String(v ?? '')],
  ['stock_qty', 'NUM', v => _num(v, 0)], ['reserved_qty', 'NUM', v => _num(v, 0)],
  ['reorder_point', 'NUM', v => _num(v, 10)], ['cost_price', 'NUM', v => _num(v, 0)],
  ['sell_price', 'NUM', v => _num(v, 0)], ['client_id', 'TEXT', v => String(v ?? '')],
];
function upsert(data) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  const { sku, name } = data;
  if (!sku || !name) throw new Error('sku and name are required');

  const cols = [..._BASE_COLUMNS];
  for (const [col, sqlType, dflt] of PRODUCT_MASTER_COLUMNS) {
    const caster = sqlType === 'TEXT' ? (v => String(v ?? dflt)) : (v => _num(v, dflt));
    cols.push([col, sqlType === 'TEXT' ? 'TEXT' : 'NUM', caster]);
  }
  // Defaults come from the row already on disk (partial updates from the
  // main Inventory tab shouldn't blank out fields a Product Master import
  // already set), falling back to each column's schema default for a
  // brand-new SKU.
  const existing = get(sku) || {};
  const values = cols.map(([col, , caster]) => caster(data[col] !== undefined ? data[col] : existing[col]));

  const colNames = ['sku', ...cols.map(c => c[0])];
  const placeholders = colNames.map(() => '?').join(',');
  const updateSet = cols.map(([col]) => `${col}=excluded.${col}`).join(',');
  db.prepare(`INSERT INTO inventory (${colNames.join(',')},updated_at)
    VALUES (${placeholders},datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET ${updateSet},updated_at=datetime('now')`)
    .run(sku, ...values);
  return get(sku);
}

function remove(sku) { const db = _open(); if (db) db.prepare('DELETE FROM inventory WHERE sku = ?').run(sku); }

function adjust(sku, qty, type = 'adjustment', reason = '', orderId = null) {
  const db = _open();
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
  const db = _open();
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
  const db = _open();
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
  const db = _open();
  if (!db) return [];
  return db.prepare('SELECT * FROM stock_movements WHERE sku = ? ORDER BY at DESC LIMIT ?').all(sku, Number(limit) || 50);
}

function getStats({ clientId } = {}) {
  const db = _open();
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
  const db = _open();
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

// One-time-per-tenant seed of the item catalog from the base's SKU→description
// map, so a tenant's inventory page comes up populated with real SKUs at zero
// stock (ready to receive/adjust) the first time it's opened.
function seedFromSkuMap(skuDescMap) {
  const db = _open();
  const tenantId = tenantContext.currentTenantId();
  if (!db || _seededByTenant.has(tenantId)) return 0;
  const existing = db.prepare('SELECT COUNT(*) c FROM inventory').get().c;
  if (existing > 0) { _seededByTenant.add(tenantId); return 0; }
  const entries = Object.entries(skuDescMap || {});
  if (!entries.length) return 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO inventory (sku,name,description) VALUES (?,?,?)`);
  const tx = db.transaction(rows => { for (const [sku, desc] of rows) stmt.run(sku, desc || sku, desc || ''); });
  tx(entries);
  _seededByTenant.add(tenantId);
  return entries.length;
}

module.exports = {
  init, available,
  getAll, get, upsert, remove, adjust, reserveOrder, deductOrder, movements, getStats, velocity,
  seedFromSkuMap,
};
