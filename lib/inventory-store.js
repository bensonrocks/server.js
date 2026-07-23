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

// Bring a pre-3PL-refactor database up to the client-scoped schema: add a
// client_id column (defaulting to 'GENERAL' so existing rows stay valid) to
// every table that now needs one, and create the unique (client_id, sku) index
// that upsert's ON CONFLICT relies on. Idempotent — skips columns/indexes that
// already exist, so a fresh (already-correct) db is untouched.
function _migrateClientScoping(handle) {
  const cols = t => new Set(handle.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
  const tableExists = t => !!handle.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  const addClientId = (t, notNull) => {
    if (!tableExists(t) || cols(t).has('client_id')) return;
    // SQLite ALTER ADD COLUMN can't be NOT NULL without a default — a literal
    // default satisfies both the constraint and pre-existing rows.
    handle.exec(`ALTER TABLE ${t} ADD COLUMN client_id TEXT ${notNull ? "NOT NULL DEFAULT 'GENERAL'" : "DEFAULT ''"}`);
  };
  addClientId('inventory', true);
  addClientId('stock_movements', false);
  addClientId('stock_by_location', true);
  addClientId('suppliers', true);
  addClientId('supplier_sku_mapping', true);
  addClientId('batch_tracking', true);
  addClientId('stock_alerts', false);
  // upsert uses ON CONFLICT(client_id, sku); an old db's PRIMARY KEY was just
  // (sku), so add the composite unique index explicitly.
  if (tableExists('inventory')) {
    try { handle.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_inventory_client_sku ON inventory(client_id, sku)`); } catch (_) {}
  }
}

function _migrateProductMasterColumns(handle) {
  const existing = new Set(handle.prepare('PRAGMA table_info(inventory)').all().map(c => c.name));
  for (const [col, sqlType, dflt] of PRODUCT_MASTER_COLUMNS) {
    if (existing.has(col)) continue;
    const defaultSql = typeof dflt === 'string' ? `'${dflt}'` : dflt;
    handle.exec(`ALTER TABLE inventory ADD COLUMN ${col} ${sqlType} DEFAULT ${defaultSql}`);
  }
}

function _migrateNewColumns(handle) {
  const existing = new Set(handle.prepare('PRAGMA table_info(inventory)').all().map(c => c.name));
  if (!existing.has('last_moved_at')) handle.exec(`ALTER TABLE inventory ADD COLUMN last_moved_at TEXT`);
  // NOTE: SQLite forbids ALTER ADD COLUMN with a non-constant default like
  // datetime('now'), so a migrated legacy row gets a NULL first_added_at
  // (harmless — aging analytics just skips a null age). Fresh dbs still get the
  // datetime('now') default from the CREATE TABLE definition.
  if (!existing.has('first_added_at')) handle.exec(`ALTER TABLE inventory ADD COLUMN first_added_at TEXT`);
  if (!existing.has('supplier_id')) handle.exec(`ALTER TABLE inventory ADD COLUMN supplier_id TEXT DEFAULT ''`);
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
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        sku               TEXT NOT NULL,
        name              TEXT NOT NULL,
        description       TEXT DEFAULT '',
        category          TEXT DEFAULT '',
        unit              TEXT DEFAULT 'pcs',
        stock_qty         INTEGER DEFAULT 0,
        reserved_qty      INTEGER DEFAULT 0,
        reorder_point     INTEGER DEFAULT 10,
        cost_price        REAL DEFAULT 0,
        updated_at        TEXT DEFAULT (datetime('now')),
        client_id         TEXT NOT NULL,
        last_moved_at     TEXT,
        first_added_at    TEXT DEFAULT (datetime('now')),
        UNIQUE(client_id, sku)
      );

      CREATE TABLE IF NOT EXISTS warehouse_locations (
        location_id  TEXT PRIMARY KEY,
        zone         TEXT NOT NULL,
        aisle        TEXT NOT NULL,
        shelf        TEXT NOT NULL,
        bin          TEXT NOT NULL,
        capacity     INTEGER DEFAULT 1000,
        environment  TEXT DEFAULT 'dry',
        active       INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS stock_by_location (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id    TEXT NOT NULL,
        sku          TEXT NOT NULL,
        location_id  TEXT NOT NULL,
        quantity     INTEGER DEFAULT 0,
        last_counted TEXT DEFAULT (datetime('now')),
        UNIQUE(client_id, sku, location_id),
        FOREIGN KEY(location_id) REFERENCES warehouse_locations(location_id)
      );

      CREATE TABLE IF NOT EXISTS stock_movements (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        sku          TEXT NOT NULL,
        type         TEXT NOT NULL,
        qty          INTEGER NOT NULL,
        reason       TEXT DEFAULT '',
        order_id     TEXT DEFAULT NULL,
        from_location TEXT,
        to_location  TEXT,
        client_id    TEXT DEFAULT '',
        operator     TEXT DEFAULT '',
        at           TEXT DEFAULT (datetime('now'))
      );


      CREATE TABLE IF NOT EXISTS suppliers (
        supplier_id      TEXT PRIMARY KEY,
        client_id        TEXT NOT NULL,
        name             TEXT NOT NULL,
        contact_person   TEXT DEFAULT '',
        phone            TEXT DEFAULT '',
        email            TEXT DEFAULT '',
        lead_time_days   INTEGER DEFAULT 7,
        min_order_qty    INTEGER DEFAULT 1,
        active           INTEGER DEFAULT 1,
        created_at       TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS supplier_sku_mapping (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id     TEXT NOT NULL,
        client_id       TEXT NOT NULL,
        sku             TEXT NOT NULL,
        supplier_sku    TEXT DEFAULT '',
        unit_cost       REAL DEFAULT 0,
        moq             INTEGER DEFAULT 1,
        lead_time_days  INTEGER DEFAULT 7,
        UNIQUE(supplier_id, sku),
        FOREIGN KEY(supplier_id) REFERENCES suppliers(supplier_id)
      );

      CREATE TABLE IF NOT EXISTS cycle_counts (
        count_id     TEXT PRIMARY KEY,
        location_id  TEXT,
        status       TEXT DEFAULT 'in_progress',
        counted_by   TEXT,
        verified_by  TEXT,
        started_at   TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        variance_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS cycle_count_lines (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        count_id     TEXT NOT NULL,
        sku          TEXT NOT NULL,
        expected_qty INTEGER,
        counted_qty  INTEGER,
        variance     INTEGER,
        variance_reason TEXT DEFAULT '',
        FOREIGN KEY(count_id) REFERENCES cycle_counts(count_id)
      );

      CREATE TABLE IF NOT EXISTS stock_alerts (
        alert_id     TEXT PRIMARY KEY,
        sku          TEXT NOT NULL,
        client_id    TEXT DEFAULT '',
        alert_type   TEXT NOT NULL,
        severity     TEXT DEFAULT 'info',
        message      TEXT,
        resolved     INTEGER DEFAULT 0,
        created_at   TEXT DEFAULT (datetime('now')),
        resolved_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS batch_tracking (
        batch_id      TEXT PRIMARY KEY,
        client_id     TEXT NOT NULL,
        sku           TEXT NOT NULL,
        batch_number  TEXT,
        expiry_date   TEXT,
        quarantine    INTEGER DEFAULT 0,
        quantity      INTEGER DEFAULT 0,
        created_at    TEXT DEFAULT (datetime('now'))
      );

    `);
    // Migrate BEFORE creating indexes: a db created before the 3PL client-scoped
    // refactor has these tables WITHOUT a client_id column, so an index on
    // client_id would throw and disable the whole store. Add the column (and the
    // unique index upsert relies on) to any pre-existing table first.
    _migrateClientScoping(handle);
    handle.exec(`
      CREATE INDEX IF NOT EXISTS idx_mov_sku ON stock_movements(sku);
      CREATE INDEX IF NOT EXISTS idx_mov_client ON stock_movements(client_id);
      CREATE INDEX IF NOT EXISTS idx_mov_at ON stock_movements(at);
      CREATE INDEX IF NOT EXISTS idx_stock_location ON stock_by_location(location_id);
      CREATE INDEX IF NOT EXISTS idx_supplier_sku ON supplier_sku_mapping(supplier_id);
      CREATE INDEX IF NOT EXISTS idx_alerts_sku ON stock_alerts(sku);
      CREATE INDEX IF NOT EXISTS idx_batch_sku ON batch_tracking(sku);
    `);
    _migrateProductMasterColumns(handle);
    _migrateNewColumns(handle);
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
  if (!clientId) throw new Error('clientId is required (3PL model: all stock is client-owned)');
  let rows = db.prepare('SELECT * FROM inventory WHERE client_id = ? ORDER BY name ASC').all(clientId).map(_avail);
  if (category) rows = rows.filter(r => r.category === category);
  if (search)   { const q = String(search).toLowerCase(); rows = rows.filter(r => r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)); }
  if (lowStock) rows = rows.filter(r => r.available_qty <= r.reorder_point);
  return rows;
}

function get(sku, clientId) {
  const db = _open();
  if (!db) return null;
  if (!clientId) throw new Error('clientId is required (3PL model: all stock is client-owned)');
  const r = db.prepare('SELECT * FROM inventory WHERE client_id = ? AND sku = ?').get(clientId, sku);
  return r ? _avail(r) : null;
}

// Base columns always accepted by upsert(); Product Master columns
// (PRODUCT_MASTER_COLUMNS) are appended dynamically below so adding a new
// template field only ever needs a change in ONE place (that list).
function _num(v, dflt) { return (v === undefined || v === null || v === '') ? dflt : (Number(v) || 0); }
const _BASE_COLUMNS = [
  ['name', 'TEXT', v => String(v)], ['description', 'TEXT', v => String(v ?? '')],
  ['category', 'TEXT', v => String(v ?? '')], ['unit', 'TEXT', v => String(v ?? 'pcs')],
  ['stock_qty', 'NUM', v => _num(v, 0)], ['reserved_qty', 'NUM', v => _num(v, 0)],
  ['reorder_point', 'NUM', v => _num(v, 10)], ['cost_price', 'NUM', v => _num(v, 0)],
];
function upsert(data) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  const { sku, name, clientId } = data;
  if (!sku || !name || !clientId) throw new Error('sku, name, and clientId are required');

  const cols = [..._BASE_COLUMNS];
  for (const [col, sqlType, dflt] of PRODUCT_MASTER_COLUMNS) {
    const caster = sqlType === 'TEXT' ? (v => String(v ?? dflt)) : (v => _num(v, dflt));
    cols.push([col, sqlType === 'TEXT' ? 'TEXT' : 'NUM', caster]);
  }
  const existing = get(sku, clientId) || {};
  const values = cols.map(([col, , caster]) => caster(data[col] !== undefined ? data[col] : existing[col]));

  const colNames = ['client_id', 'sku', ...cols.map(c => c[0])];
  const placeholders = colNames.map(() => '?').join(',');
  const updateSet = cols.map(([col]) => `${col}=excluded.${col}`).join(',');
  db.prepare(`INSERT INTO inventory (${colNames.join(',')},updated_at)
    VALUES (${placeholders},datetime('now'))
    ON CONFLICT(client_id, sku) DO UPDATE SET ${updateSet},updated_at=datetime('now')`)
    .run(clientId, sku, ...values);
  return get(sku, clientId);
}

function remove(sku, clientId) {
  const db = _open();
  if (!db) return;
  if (!clientId) throw new Error('clientId is required');
  db.prepare('DELETE FROM inventory WHERE client_id = ? AND sku = ?').run(clientId, sku);
}

function adjust(sku, clientId, qty, type = 'adjustment', reason = '', orderId = null) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const item = get(sku, clientId);
  if (!item) throw new Error('SKU ' + sku + ' not found for client ' + clientId);
  const newQty = Math.max(0, item.stock_qty + Number(qty));
  db.prepare("UPDATE inventory SET stock_qty=?, updated_at=datetime('now') WHERE client_id=? AND sku=?").run(newQty, clientId, sku);
  db.prepare('INSERT INTO stock_movements (sku,client_id,type,qty,reason,order_id) VALUES (?,?,?,?,?,?)').run(sku, clientId, type, Number(qty), reason, orderId);
  return get(sku, clientId);
}

// Order lifecycle hooks — clientId required
function reserveOrder(clientId, order) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  return db.transaction(() => {
    const out = [];
    for (const item of (order.items || [])) {
      if (!item.sku) continue;
      const inv = get(item.sku, clientId);
      if (!inv) { out.push({ sku: item.sku, ok: false, error: 'SKU not found' }); continue; }
      const newReserved = inv.reserved_qty + Number(item.qty);
      db.prepare("UPDATE inventory SET reserved_qty=?, updated_at=datetime('now') WHERE client_id=? AND sku=?").run(newReserved, clientId, item.sku);
      db.prepare('INSERT INTO stock_movements (sku,client_id,type,qty,reason,order_id) VALUES (?,?,?,?,?,?)').run(item.sku, clientId, 'reserve', Number(item.qty), 'Reserved for ' + order.id, order.id);
      out.push({ sku: item.sku, ok: true, reservedQty: newReserved });
    }
    return out;
  })();
}

function deductOrder(clientId, order) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  return db.transaction(() => {
    const out = [];
    for (const item of (order.items || [])) {
      if (!item.sku) continue;
      const inv = get(item.sku, clientId);
      if (!inv) { out.push({ sku: item.sku, ok: false, error: 'SKU not found' }); continue; }
      const qty = Number(item.qty);
      db.prepare("UPDATE inventory SET stock_qty=?, reserved_qty=?, updated_at=datetime('now') WHERE client_id=? AND sku=?")
        .run(Math.max(0, inv.stock_qty - qty), Math.max(0, inv.reserved_qty - qty), clientId, item.sku);
      db.prepare('INSERT INTO stock_movements (sku,client_id,type,qty,reason,order_id) VALUES (?,?,?,?,?,?)').run(item.sku, clientId, 'outbound', -qty, 'Shipped ' + order.id, order.id);
      out.push({ sku: item.sku, ok: true });
    }
    return out;
  })();
}

// Release a reservation WITHOUT shipping — the inverse of reserveOrder. Used
// when an unshipped order is cancelled/voided: reserved qty drops, stock_qty is
// untouched, so those units become available again.
function releaseOrder(clientId, order) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  return db.transaction(() => {
    const out = [];
    for (const item of (order.items || [])) {
      if (!item.sku) continue;
      const inv = get(item.sku, clientId);
      if (!inv) { out.push({ sku: item.sku, ok: false, error: 'SKU not found' }); continue; }
      const qty = Number(item.qty);
      db.prepare("UPDATE inventory SET reserved_qty=?, updated_at=datetime('now') WHERE client_id=? AND sku=?")
        .run(Math.max(0, inv.reserved_qty - qty), clientId, item.sku);
      db.prepare('INSERT INTO stock_movements (sku,client_id,type,qty,reason,order_id) VALUES (?,?,?,?,?,?)').run(item.sku, clientId, 'release', qty, 'Released ' + order.id, order.id);
      out.push({ sku: item.sku, ok: true });
    }
    return out;
  })();
}

function movements(sku, clientId, limit = 50) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  return db.prepare('SELECT * FROM stock_movements WHERE sku = ? AND client_id = ? ORDER BY at DESC LIMIT ?').all(sku, clientId, Number(limit) || 50);
}

function getStats({ clientId } = {}) {
  const db = _open();
  if (!db) return { totalSKUs: 0, lowStock: 0, outOfStock: 0, totalValue: 0, totalReserved: 0, categories: [] };
  if (!clientId) throw new Error('clientId is required');
  let rows = db.prepare('SELECT * FROM inventory WHERE client_id = ?').all(clientId).map(_avail);
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

function velocity(clientId, limit = 20) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  return db.prepare(`
    SELECT sm.sku, SUM(ABS(sm.qty)) as total_out, i.name, i.category
    FROM stock_movements sm LEFT JOIN inventory i ON i.sku = sm.sku AND i.client_id = sm.client_id
    WHERE sm.type = 'outbound' AND sm.client_id = ?
    GROUP BY sm.sku ORDER BY total_out DESC LIMIT ?
  `).all(clientId, Number(limit) || 20);
}

// One-time-per-tenant seed of the item catalog from the base's SKU→description
// map, seeded FOR A CLIENT so a tenant's inventory page comes up populated with
// real SKUs at zero stock (ready to receive/adjust) the first time it's opened.
function seedFromSkuMap(clientId, skuDescMap) {
  const db = _open();
  if (!db) return 0;
  if (!clientId) throw new Error('clientId is required');
  const entries = Object.entries(skuDescMap || {});
  if (!entries.length) return 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO inventory (client_id,sku,name,description) VALUES (?,?,?,?)`);
  const tx = db.transaction(rows => { for (const [sku, desc] of rows) stmt.run(clientId, sku, desc || sku, desc || ''); });
  tx(entries);
  return entries.length;
}

// ── Warehouse Locations & Stock Distribution ────────────────────────────
// Shared warehouse divided into zones (A=fast, B=med, C=slow), aisles, shelves, bins.
// stock_by_location tracks how many units of each SKU are in each bin.

function createLocation(zone, aisle, shelf, bin, capacity = 1000, environment = 'dry') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  const locationId = `${zone}-${aisle}-${shelf}-${bin}`;
  db.prepare('INSERT OR IGNORE INTO warehouse_locations (location_id, zone, aisle, shelf, bin, capacity, environment) VALUES (?,?,?,?,?,?,?)')
    .run(locationId, zone, aisle, shelf, bin, Number(capacity), environment);
  return db.prepare('SELECT * FROM warehouse_locations WHERE location_id=?').get(locationId);
}

function getLocations({ zone, active } = {}) {
  const db = _open();
  if (!db) return [];
  let sql = 'SELECT * FROM warehouse_locations WHERE 1=1';
  const params = [];
  if (zone) { sql += ' AND zone=?'; params.push(zone); }
  if (active !== undefined) { sql += ' AND active=?'; params.push(active ? 1 : 0); }
  sql += ' ORDER BY zone, aisle, shelf, bin';
  return db.prepare(sql).all(...params);
}

function stockByLocation(clientId, sku) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  return db.prepare(`SELECT sbl.*, wl.zone, wl.aisle, wl.shelf, wl.bin FROM stock_by_location sbl
    LEFT JOIN warehouse_locations wl ON wl.location_id=sbl.location_id
    WHERE sbl.client_id=? AND sbl.sku=? ORDER BY wl.zone, wl.aisle, wl.shelf, wl.bin`).all(clientId, sku);
}

function transferStock(clientId, sku, fromLocation, toLocation, qty, operator = '') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  return db.transaction(() => {
    const fromBefore = db.prepare('SELECT quantity FROM stock_by_location WHERE client_id=? AND sku=? AND location_id=?').get(clientId, sku, fromLocation);
    if (!fromBefore || fromBefore.quantity < qty) throw new Error(`Insufficient stock at ${fromLocation}`);

    db.prepare('UPDATE stock_by_location SET quantity=quantity-?, last_counted=datetime("now") WHERE client_id=? AND sku=? AND location_id=?')
      .run(Number(qty), clientId, sku, fromLocation);
    db.prepare(`INSERT INTO stock_by_location (client_id, sku, location_id, quantity, last_counted) VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(client_id, sku, location_id) DO UPDATE SET quantity=quantity+?, last_counted=datetime('now')`)
      .run(clientId, sku, toLocation, Number(qty), Number(qty));

    db.prepare('INSERT INTO stock_movements (sku, client_id, type, qty, reason, from_location, to_location, operator, at) VALUES (?,?,?,?,?,?,?,?,datetime("now"))')
      .run(sku, clientId, 'transfer', Number(qty), `Transfer from ${fromLocation}`, fromLocation, toLocation, operator);

    return { ok: true, sku, qty: Number(qty), from: fromLocation, to: toLocation };
  })();
}

// ── Suppliers & Reorder Management — all per-client ──────────────────────

function upsertSupplier(clientId, supplierId, data = {}) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId || !supplierId) throw new Error('clientId and supplierId required');
  const { name, contact_person, phone, email, lead_time_days, min_order_qty } = data;
  if (!name) throw new Error('supplier name required');

  db.prepare(`INSERT INTO suppliers (supplier_id, client_id, name, contact_person, phone, email, lead_time_days, min_order_qty)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(supplier_id) DO UPDATE SET name=excluded.name, contact_person=excluded.contact_person,
    phone=excluded.phone, email=excluded.email, lead_time_days=excluded.lead_time_days, min_order_qty=excluded.min_order_qty`)
    .run(supplierId, clientId, name, contact_person || '', phone || '', email || '', Number(lead_time_days) || 7, Number(min_order_qty) || 1);
  return db.prepare('SELECT * FROM suppliers WHERE supplier_id=?').get(supplierId);
}

function getSuppliers(clientId, { active } = {}) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  let sql = 'SELECT * FROM suppliers WHERE client_id=?';
  const params = [clientId];
  if (active !== undefined) { sql += ' AND active=?'; params.push(active ? 1 : 0); }
  sql += ' ORDER BY name';
  return db.prepare(sql).all(...params);
}

function mapSupplierSku(clientId, supplierId, sku, data = {}) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const { supplier_sku, unit_cost, moq, lead_time_days } = data;

  db.prepare(`INSERT INTO supplier_sku_mapping (supplier_id, client_id, sku, supplier_sku, unit_cost, moq, lead_time_days)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(supplier_id, sku) DO UPDATE SET supplier_sku=excluded.supplier_sku,
    unit_cost=excluded.unit_cost, moq=excluded.moq, lead_time_days=excluded.lead_time_days`)
    .run(supplierId, clientId, sku, supplier_sku || sku, Number(unit_cost) || 0, Number(moq) || 1, Number(lead_time_days) || 7);
  return db.prepare('SELECT * FROM supplier_sku_mapping WHERE supplier_id=? AND sku=?').get(supplierId, sku);
}

function getSupplierOptions(clientId, sku) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  return db.prepare(`SELECT s.*, ssm.* FROM supplier_sku_mapping ssm
    LEFT JOIN suppliers s ON s.supplier_id=ssm.supplier_id
    WHERE ssm.client_id=? AND ssm.sku=? AND s.active=1 ORDER BY s.name`).all(clientId, sku);
}

function getReorderSuggestions(clientId) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  // available_qty is computed (stock_qty - reserved_qty), not a stored column;
  // suppliers are joined via supplier_sku_mapping (per client + sku).
  return db.prepare(`
    SELECT i.sku, i.name,
      MAX(0, i.stock_qty - i.reserved_qty) AS available_qty,
      i.reorder_point,
      i.reorder_point - MAX(0, i.stock_qty - i.reserved_qty) AS needed,
      i.cost_price,
      (i.reorder_point - MAX(0, i.stock_qty - i.reserved_qty)) * i.cost_price AS cost_needed,
      s.name AS supplier, s.supplier_id
    FROM inventory i
    LEFT JOIN supplier_sku_mapping ssm ON ssm.client_id = i.client_id AND ssm.sku = i.sku
    LEFT JOIN suppliers s ON s.supplier_id = ssm.supplier_id AND s.client_id = i.client_id
    WHERE i.client_id = ?
      AND MAX(0, i.stock_qty - i.reserved_qty) <= i.reorder_point
      AND MAX(0, i.stock_qty - i.reserved_qty) > 0
    ORDER BY needed DESC`).all(clientId);
}

// ── Cycle Counts — client-scoped ────────────────────────────────────────

function startCycleCount(clientId, countId, locationId = null, countedBy = '') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  db.prepare('INSERT INTO cycle_counts (count_id, location_id, counted_by, status) VALUES (?,?,?,?)')
    .run(countId, locationId || null, countedBy, 'in_progress');
  return db.prepare('SELECT * FROM cycle_counts WHERE count_id=?').get(countId);
}

function recordCycleCountLine(clientId, countId, sku, countedQty, expectedQty = null, reason = '') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const expected = expectedQty !== null ? expectedQty : get(sku, clientId)?.stock_qty || 0;
  const variance = countedQty - expected;

  db.prepare(`INSERT INTO cycle_count_lines (count_id, sku, expected_qty, counted_qty, variance, variance_reason)
    VALUES (?,?,?,?,?,?)`)
    .run(countId, sku, expected, countedQty, variance, reason || '');

  if (variance !== 0) {
    db.prepare('UPDATE cycle_counts SET variance_count = variance_count + 1 WHERE count_id=?').run(countId);
  }
  return { sku, expected, counted: countedQty, variance, reason };
}

function completeCycleCount(clientId, countId, verifiedBy = '') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  return db.transaction(() => {
    const count = db.prepare('SELECT * FROM cycle_counts WHERE count_id=?').get(countId);
    if (!count) throw new Error('Cycle count not found');

    const lines = db.prepare('SELECT * FROM cycle_count_lines WHERE count_id=?').all(countId);
    const adjustedSkus = [];
    for (const line of lines) {
      if (line.variance !== 0) {
        db.prepare('UPDATE inventory SET stock_qty=? WHERE client_id=? AND sku=?').run(line.counted_qty, clientId, line.sku);
        db.prepare('INSERT INTO stock_movements (sku, client_id, type, qty, reason, operator) VALUES (?,?,?,?,?,?)')
          .run(line.sku, clientId, 'count_adjustment', line.variance, `Cycle count ${countId}: ${line.variance_reason}`, verifiedBy);
        adjustedSkus.push(line.sku);
      }
    }

    db.prepare('UPDATE cycle_counts SET status=?, verified_by=?, completed_at=datetime("now") WHERE count_id=?')
      .run('completed', verifiedBy, countId);

    return { count_id: countId, lines: lines.length, variances: count.variance_count, adjustedSkus };
  })();
}

// ── Stock Alerts — client-scoped ────────────────────────────────────────

function createAlert(clientId, alertId, sku, alertType, message, severity = 'info') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  db.prepare(`INSERT INTO stock_alerts (alert_id, sku, client_id, alert_type, message, severity)
    VALUES (?,?,?,?,?,?)`)
    .run(alertId, sku, clientId, alertType, message, severity);
  return db.prepare('SELECT * FROM stock_alerts WHERE alert_id=?').get(alertId);
}

function getActiveAlerts(clientId, { sku, severity } = {}) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  let sql = 'SELECT * FROM stock_alerts WHERE client_id=? AND resolved=0';
  const params = [clientId];
  if (sku) { sql += ' AND sku=?'; params.push(sku); }
  if (severity) { sql += ' AND severity=?'; params.push(severity); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

function resolveAlert(alertId) {
  const db = _open();
  if (!db) return null;
  db.prepare('UPDATE stock_alerts SET resolved=1, resolved_at=datetime("now") WHERE alert_id=?').run(alertId);
  return db.prepare('SELECT * FROM stock_alerts WHERE alert_id=?').get(alertId);
}

// ── Batch/Lot Tracking — client-scoped ─────────────────────────────────

function createBatch(clientId, batchId, sku, quantity, data = {}) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const { batch_number, expiry_date } = data;
  db.prepare(`INSERT INTO batch_tracking (batch_id, client_id, sku, batch_number, expiry_date, quantity)
    VALUES (?,?,?,?,?,?)`)
    .run(batchId, clientId, sku, batch_number || '', expiry_date || null, Number(quantity));
  return db.prepare('SELECT * FROM batch_tracking WHERE batch_id=?').get(batchId);
}

function getBatchesBySku(clientId, sku, { includeQuarantined } = {}) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  let sql = 'SELECT * FROM batch_tracking WHERE client_id=? AND sku=?';
  const params = [clientId, sku];
  if (!includeQuarantined) { sql += ' AND quarantine=0'; }
  sql += ' ORDER BY created_at ASC';
  return db.prepare(sql).all(...params);
}

function quarantineBatch(batchId) {
  const db = _open();
  if (!db) return null;
  db.prepare('UPDATE batch_tracking SET quarantine=1 WHERE batch_id=?').run(batchId);
  return db.prepare('SELECT * FROM batch_tracking WHERE batch_id=?').get(batchId);
}

// ── Analytics & Reports — client-scoped ─────────────────────────────────

function stockAging(clientId, limit = 50) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  return db.prepare(`SELECT sku, name, stock_qty, reserved_qty,
    CAST((julianday('now') - julianday(first_added_at)) AS INTEGER) as days_on_hand,
    cost_price * stock_qty as stock_value
    FROM inventory WHERE client_id=? AND stock_qty > 0 ORDER BY first_added_at ASC LIMIT ?`).all(clientId, Number(limit));
}

function turnoverRate(clientId, skuList = [], days = 30) {
  const db = _open();
  if (!db) return {};
  if (!clientId) throw new Error('clientId is required');
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const result = {};
  const prep = db.prepare(`SELECT SUM(ABS(qty)) as units_moved FROM stock_movements
    WHERE client_id=? AND sku=? AND type='outbound' AND at > ?`);
  for (const sku of skuList) {
    const row = prep.get(clientId, sku, cutoff);
    result[sku] = row?.units_moved || 0;
  }
  return result;
}

function slowMovers(clientId, days = 30, minDaysOnHand = 60) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare(`SELECT i.sku, i.name, i.stock_qty, COALESCE(SUM(sm.qty), 0) as units_moved,
    CAST((julianday('now') - julianday(i.first_added_at)) AS INTEGER) as days_on_hand
    FROM inventory i LEFT JOIN stock_movements sm ON i.client_id=sm.client_id AND i.sku=sm.sku AND sm.type='outbound' AND sm.at > ?
    WHERE i.client_id=? AND i.stock_qty > 0 AND CAST((julianday('now') - julianday(i.first_added_at)) AS INTEGER) >= ?
    GROUP BY i.sku HAVING units_moved < ?
    ORDER BY days_on_hand DESC`).all(cutoff, minDaysOnHand, 1);
}

function stockValue(clientId) {
  const db = _open();
  if (!db) return { totalCost: 0, byCategory: {} };
  if (!clientId) throw new Error('clientId is required');
  const rows = db.prepare('SELECT * FROM inventory WHERE client_id=? AND stock_qty > 0').all(clientId);
  const totalCost = rows.reduce((s, r) => s + (r.stock_qty * r.cost_price), 0);
  const byCategory = {};
  for (const r of rows) {
    if (!byCategory[r.category]) byCategory[r.category] = { cost: 0, qty: 0 };
    byCategory[r.category].cost += r.stock_qty * r.cost_price;
    byCategory[r.category].qty += r.stock_qty;
  }
  return { totalCost, byCategory };
}

module.exports = {
  init, available,
  getAll, get, upsert, remove, adjust, reserveOrder, deductOrder, releaseOrder, movements, getStats, velocity,
  seedFromSkuMap,
  // Warehouse locations
  createLocation, getLocations, stockByLocation, transferStock,
  // Suppliers
  upsertSupplier, getSuppliers, mapSupplierSku, getSupplierOptions, getReorderSuggestions,
  // Cycle counts
  startCycleCount, recordCycleCountLine, completeCycleCount,
  // Alerts
  createAlert, getActiveAlerts, resolveAlert,
  // Batch tracking
  createBatch, getBatchesBySku, quarantineBatch,
  // Analytics
  stockAging, turnoverRate, slowMovers, stockValue,
};
