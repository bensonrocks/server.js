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
  // bundles.type was added after the table first shipped (virtual vs physical).
  if (tableExists('bundles') && !cols('bundles').has('type')) {
    handle.exec(`ALTER TABLE bundles ADD COLUMN type TEXT NOT NULL DEFAULT 'virtual'`);
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

// Location dimensions (Admin fills L×B×H and max unit capacity per bin). capacity
// already exists on warehouse_locations (max UNITS); these add the physical size.
function _migrateLocationDims(handle) {
  const cols = new Set(handle.prepare('PRAGMA table_info(warehouse_locations)').all().map(c => c.name));
  if (!cols.has('length_cm')) handle.exec(`ALTER TABLE warehouse_locations ADD COLUMN length_cm REAL DEFAULT 0`);
  if (!cols.has('width_cm'))  handle.exec(`ALTER TABLE warehouse_locations ADD COLUMN width_cm REAL DEFAULT 0`);
  if (!cols.has('height_cm')) handle.exec(`ALTER TABLE warehouse_locations ADD COLUMN height_cm REAL DEFAULT 0`);
  // Bin role for replenishment: 'pick' = pick face / shelf (kept stocked), 'bulk'
  // = overflow/reserve (feeds the pick faces). Default 'pick' so pre-existing bins
  // behave as before.
  if (!cols.has('kind')) handle.exec(`ALTER TABLE warehouse_locations ADD COLUMN kind TEXT NOT NULL DEFAULT 'pick'`);
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

      -- Bundle / BOM definitions (IdealOne is the master). A bundle SKU maps to
      -- component SKUs + qty-per-bundle; its sellable quantity is DERIVED from
      -- component stock, never stored. Per client (all stock is client-owned).
      CREATE TABLE IF NOT EXISTS bundles (
        client_id    TEXT NOT NULL,
        bundle_sku   TEXT NOT NULL,
        name         TEXT DEFAULT '',
        components   TEXT NOT NULL DEFAULT '[]',   -- JSON: [{sku, qty}]
        type         TEXT NOT NULL DEFAULT 'virtual', -- 'virtual' | 'physical'
        updated_at   TEXT DEFAULT (datetime('now')),
        UNIQUE(client_id, bundle_sku)
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

      -- Lot-level bin stock — the authoritative record of WHICH physical lot of a
      -- SKU sits in WHICH bin, with the inbound date (FIFO key) and expiry (FEFO
      -- key). A bin can hold several lots of one SKU; a lot lives in exactly one
      -- bin. This is what FEFO/FIFO pick allocation rotates over, and what a pick
      -- decrements. (stock_by_location, the old flat qty-per-bin table, is now
      -- derived from this — occupancy = SUM(bin_lots.qty).)
      CREATE TABLE IF NOT EXISTS bin_lots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id    TEXT NOT NULL,
        sku          TEXT NOT NULL,
        location_id  TEXT NOT NULL,
        qty          INTEGER NOT NULL DEFAULT 0,
        received_at  TEXT,                       -- inbound date (FIFO key)
        expiry_date  TEXT,                       -- FEFO key (nullable)
        lot_number   TEXT DEFAULT '',
        created_at   TEXT DEFAULT (datetime('now'))
      );

      -- Serial-number registry (for serial_tracked SKUs). Each unit's serial is
      -- captured at receive (status in_stock) and marked shipped at pick, so a
      -- unit is traceable end to end. Unique per (client, serial).
      CREATE TABLE IF NOT EXISTS serials (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id    TEXT NOT NULL,
        sku          TEXT NOT NULL,
        serial       TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'in_stock',   -- in_stock | shipped
        received_ref TEXT DEFAULT '',
        received_at  TEXT DEFAULT (datetime('now')),
        shipped_ref  TEXT DEFAULT '',
        shipped_at   TEXT,
        UNIQUE(client_id, serial)
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
      CREATE INDEX IF NOT EXISTS idx_binlots_client_sku ON bin_lots(client_id, sku);
      CREATE INDEX IF NOT EXISTS idx_binlots_location ON bin_lots(location_id);
      CREATE INDEX IF NOT EXISTS idx_serials_client_sku ON serials(client_id, sku);
    `);
    _migrateProductMasterColumns(handle);
    _migrateNewColumns(handle);
    _migrateLocationDims(handle);
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

// Resolve ANY incoming code (an in-house SKU, or a barcode) to the client's
// canonical in-house SKU. Returns the in-house SKU string, or null if the code
// matches nothing in the item master (leave it as-is for teach/validation).
// Used to normalize order lines at import so everything downstream keys on the
// in-house SKU regardless of whether the source (ZORT/file) used SKU or barcode.
function resolveToInhouseSku(code, clientId) {
  const c = String(code || '').trim();
  if (!c || !clientId) return null;
  if (get(c, clientId)) return c;                 // already an in-house SKU
  const byBc = getByBarcode(c, clientId);         // else try it as a barcode
  return byBc ? byBc.sku : null;
}

// Look a product up by its BARCODE within a client's item master. Powers the
// SKU↔barcode inter-search: a client uploads SKU + Barcode, and scanning
// either one resolves to the product. Case/space-insensitive on the barcode.
function getByBarcode(barcode, clientId) {
  const db = _open();
  if (!db) return null;
  if (!clientId) throw new Error('clientId is required');
  const bc = String(barcode || '').trim();
  if (!bc) return null;
  const r = db.prepare('SELECT * FROM inventory WHERE client_id = ? AND barcode <> \'\' AND LOWER(TRIM(barcode)) = LOWER(?)').get(clientId, bc);
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
      // Available BEFORE this reservation — anything the order needs beyond it is
      // a shortfall (the order is backordered on that SKU until stock arrives).
      const availableBefore = Math.max(0, inv.stock_qty - inv.reserved_qty);
      const ordered = Number(item.qty);
      const shortfall = Math.max(0, ordered - availableBefore);
      const newReserved = inv.reserved_qty + ordered;
      db.prepare("UPDATE inventory SET reserved_qty=?, updated_at=datetime('now') WHERE client_id=? AND sku=?").run(newReserved, clientId, item.sku);
      db.prepare('INSERT INTO stock_movements (sku,client_id,type,qty,reason,order_id) VALUES (?,?,?,?,?,?)').run(item.sku, clientId, 'reserve', ordered, 'Reserved for ' + order.id, order.id);
      out.push({ sku: item.sku, ok: true, reservedQty: newReserved, availableBefore, ordered, shortfall });
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
  // Aggregate lots per bin (a bin may hold several lots of the SKU).
  return db.prepare(`SELECT bl.location_id, SUM(bl.qty) AS quantity,
      MIN(bl.expiry_date) AS next_expiry, wl.zone, wl.aisle, wl.shelf, wl.bin
    FROM bin_lots bl LEFT JOIN warehouse_locations wl ON wl.location_id=bl.location_id
    WHERE bl.client_id=? AND bl.sku=? AND bl.qty>0
    GROUP BY bl.location_id ORDER BY wl.zone, wl.aisle, wl.shelf, wl.bin`).all(clientId, sku);
}

// Update a bin's physical dimensions + max unit capacity (Admin).
function updateLocation(locationId, { length_cm, width_cm, height_cm, capacity, environment, active, kind } = {}) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  const loc = db.prepare('SELECT * FROM warehouse_locations WHERE location_id=?').get(locationId);
  if (!loc) throw new Error(`Location ${locationId} does not exist`);
  const v = (x, d) => (x === undefined || x === null || x === '') ? d : Number(x) || 0;
  const k = (kind === 'pick' || kind === 'bulk') ? kind : (loc.kind || 'pick');
  db.prepare(`UPDATE warehouse_locations SET length_cm=?, width_cm=?, height_cm=?, capacity=?, environment=?, active=?, kind=? WHERE location_id=?`)
    .run(v(length_cm, loc.length_cm), v(width_cm, loc.width_cm), v(height_cm, loc.height_cm),
      v(capacity, loc.capacity), environment || loc.environment, active === undefined ? loc.active : (active ? 1 : 0), k, locationId);
  return db.prepare('SELECT * FROM warehouse_locations WHERE location_id=?').get(locationId);
}

// Total units currently in a bin (all clients/SKUs) — for capacity checks/display.
function locationOccupancy(locationId) {
  const db = _open();
  if (!db) return 0;
  const r = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM bin_lots WHERE location_id=?').get(locationId);
  return r ? r.n : 0;
}
function getLocation(locationId) {
  const db = _open();
  if (!db) return null;
  return db.prepare('SELECT * FROM warehouse_locations WHERE location_id=?').get(locationId) || null;
}
// Would adding `addQty` to this bin exceed its max capacity? capacity 0 = unlimited.
function binCapacityCheck(locationId, addQty) {
  const loc = getLocation(locationId);
  const capacity = loc ? Number(loc.capacity) || 0 : 0;
  const occupied = locationOccupancy(locationId);
  const after = occupied + Number(addQty || 0);
  return { capacity, occupied, adding: Number(addQty || 0), after, exceeds: capacity > 0 && after > capacity, over: Math.max(0, after - capacity) };
}
// Everything physically in one bin, across ALL clients — for the bin-lookup /
// physical-audit view (scan a bin → see its contents).
function binContents(locationId) {
  const db = _open();
  if (!db) return [];
  return db.prepare(`SELECT bl.client_id, bl.sku, bl.qty, bl.expiry_date, bl.received_at, bl.lot_number, i.name
    FROM bin_lots bl LEFT JOIN inventory i ON i.client_id=bl.client_id AND i.sku=bl.sku
    WHERE bl.location_id=? AND bl.qty>0
    ORDER BY (bl.expiry_date IS NULL), bl.expiry_date ASC, bl.client_id, bl.sku`).all(locationId);
}

// ── Lot-level bin stock — the FEFO/FIFO foundation ──────────────────────────
// A "lot" = a distinct (sku, location, expiry, received_at) parcel of stock. Bin
// quantities are a physical-distribution view over inventory.stock_qty; placing/
// moving/picking lots never changes the sellable total (that's stock_qty), exactly
// as before — only WHERE stock sits and which parcel gets picked first.

// Merge a placed parcel into an identical existing lot (same bin+expiry+lot_number)
// or create a new one. dir=+1 adds. Returns the affected row id.
function _addLot(db, clientId, sku, locationId, qty, receivedAt, expiryDate, lotNumber) {
  const exp = expiryDate || null, lot = lotNumber || '';
  const existing = db.prepare(`SELECT id, qty FROM bin_lots WHERE client_id=? AND sku=? AND location_id=?
      AND IFNULL(expiry_date,'')=IFNULL(?, '') AND IFNULL(lot_number,'')=? LIMIT 1`).get(clientId, sku, locationId, exp, lot);
  if (existing) { db.prepare('UPDATE bin_lots SET qty=qty+? WHERE id=?').run(qty, existing.id); return existing.id; }
  const info = db.prepare(`INSERT INTO bin_lots (client_id, sku, location_id, qty, received_at, expiry_date, lot_number)
    VALUES (?,?,?,?,?,?,?)`).run(clientId, sku, locationId, qty, receivedAt || null, exp, lot);
  return info.lastInsertRowid;
}

// Putaway / bin seeding — now lot-aware. opts: {received_at, expiry_date, lot_number, operator}
function placeStock(clientId, sku, locationId, qty, opts = {}) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  if (!sku || !locationId) throw new Error('sku and locationId required');
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) throw new Error('qty must be a positive number');
  const { received_at, expiry_date, lot_number, operator = '' } = (typeof opts === 'string' ? { operator: opts } : opts);
  return db.transaction(() => {
    const loc = db.prepare('SELECT location_id FROM warehouse_locations WHERE location_id=?').get(locationId);
    if (!loc) throw new Error(`Location ${locationId} does not exist`);
    _addLot(db, clientId, sku, locationId, n, received_at || new Date().toISOString().slice(0, 10), expiry_date, lot_number);
    db.prepare('INSERT INTO stock_movements (sku, client_id, type, qty, reason, to_location, operator, at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
      .run(sku, clientId, 'putaway', n, `Placed at ${locationId}${expiry_date ? ' exp ' + expiry_date : ''}`, locationId, operator);
    const total = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM bin_lots WHERE client_id=? AND sku=? AND location_id=?').get(clientId, sku, locationId).n;
    return { ok: true, sku, location_id: locationId, quantity: total };
  })();
}

// Transfer between bins — moves whole/partial lots, consuming the source bin's
// lots earliest-expiry-first and preserving each lot's expiry/received at the dest.
function transferStock(clientId, sku, fromLocation, toLocation, qty, operator = '') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const need = Number(qty);
  if (!(need > 0)) throw new Error('qty must be a positive number');
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM warehouse_locations WHERE location_id=?').get(toLocation)) throw new Error(`Destination bin ${toLocation} does not exist`);
    const avail = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM bin_lots WHERE client_id=? AND sku=? AND location_id=?').get(clientId, sku, fromLocation).n;
    if (avail < need) throw new Error(`Insufficient stock at ${fromLocation} (have ${avail}, need ${need})`);
    const lots = db.prepare(`SELECT * FROM bin_lots WHERE client_id=? AND sku=? AND location_id=? AND qty>0
      ORDER BY (expiry_date IS NULL), expiry_date ASC, received_at ASC, id ASC`).all(clientId, sku, fromLocation);
    let remaining = need;
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, lot.qty);
      db.prepare('UPDATE bin_lots SET qty=qty-? WHERE id=?').run(take, lot.id);
      _addLot(db, clientId, sku, toLocation, take, lot.received_at, lot.expiry_date, lot.lot_number);
      remaining -= take;
    }
    db.prepare('DELETE FROM bin_lots WHERE client_id=? AND sku=? AND qty<=0').run(clientId, sku);
    db.prepare('INSERT INTO stock_movements (sku, client_id, type, qty, reason, from_location, to_location, operator, at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
      .run(sku, clientId, 'transfer', need, `Transfer from ${fromLocation}`, fromLocation, toLocation, operator);
    return { ok: true, sku, qty: need, from: fromLocation, to: toLocation };
  })();
}

// Client-wide bin occupancy — one row per lot (sku×bin×expiry), newest-expiry
// info included so the Locations overview can show what's where and expiring when.
function locationStockForClient(clientId) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  return db.prepare(`SELECT bl.sku, bl.location_id, bl.qty AS quantity, bl.expiry_date, bl.received_at, bl.lot_number,
      wl.zone, wl.aisle, wl.shelf, wl.bin, wl.environment, wl.capacity, i.name
    FROM bin_lots bl
    LEFT JOIN warehouse_locations wl ON wl.location_id=bl.location_id
    LEFT JOIN inventory i ON i.client_id=bl.client_id AND i.sku=bl.sku
    WHERE bl.client_id=? AND bl.qty>0
    ORDER BY wl.zone, wl.aisle, wl.shelf, wl.bin, (bl.expiry_date IS NULL), bl.expiry_date ASC`).all(clientId);
}

// All lots of one SKU across bins (ordered by the given strategy).
function binLotsForSku(clientId, sku, strategy = 'fefo') {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  const order = strategy === 'fifo'
    ? 'received_at ASC, id ASC'                                          // fifo: oldest inbound first (id breaks same-day ties by receipt order)
    : '(expiry_date IS NULL), expiry_date ASC, received_at ASC, id ASC'; // fefo: nearest expiry first, nulls last
  return db.prepare(`SELECT bl.*, wl.zone, wl.aisle, wl.shelf, wl.bin FROM bin_lots bl
    LEFT JOIN warehouse_locations wl ON wl.location_id=bl.location_id
    WHERE bl.client_id=? AND bl.sku=? AND bl.qty>0 ORDER BY ${order}`).all(clientId, sku);
}

// Units of a SKU currently sitting in bins (sum of its lots).
function binnedQty(clientId, sku) {
  const db = _open();
  if (!db) return 0;
  const r = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM bin_lots WHERE client_id=? AND sku=?').get(clientId, sku);
  return r ? r.n : 0;
}
// STAGING = on-hand received but NOT yet put away into a bin (stock_qty − binned).
// This is the pool the "allocate from staging vs wait till binned" choice governs.
function stagingQty(clientId, sku) {
  const item = get(sku, clientId);
  if (!item) return 0;
  return Math.max(0, item.stock_qty - binnedQty(clientId, sku));
}

// ── Replenishment — keep pick faces stocked to ~N days of demand ────────────
// Velocity-driven: for each SKU, demand rate = units shipped over the lookback
// window ÷ its days; target = ceil(rate × daysCover) (default a week). When a
// SKU's pick-face stock is below target and there's stock in a BULK bin, suggest
// moving the shortfall from bulk → the SKU's pick face. Pure read (no moves).
function replenishmentSuggestions(clientId, { daysCover = 7, lookbackDays = 28 } = {}) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  const days = Math.max(1, Number(lookbackDays) || 28);
  const cover = Math.max(1, Number(daysCover) || 7);
  // Demand = units shipped (deductOrder writes one 'outbound' movement per order×SKU).
  const shipped = {};
  for (const r of db.prepare(`SELECT sku, SUM(ABS(qty)) AS n FROM stock_movements
      WHERE client_id=? AND type='outbound' AND at >= datetime('now', ?) GROUP BY sku`).all(clientId, `-${days} days`)) {
    shipped[r.sku] = r.n;
  }
  // Pick-face and bulk quantities per SKU, plus the bin holding the most in each.
  const rows = db.prepare(`SELECT bl.sku, wl.kind, bl.location_id, SUM(bl.qty) AS q
    FROM bin_lots bl JOIN warehouse_locations wl ON wl.location_id=bl.location_id
    WHERE bl.client_id=? AND bl.qty>0 GROUP BY bl.sku, wl.kind, bl.location_id`).all(clientId);
  const bySku = {}; // sku -> {pick, bulk, pickBins:{loc:q}, bulkBins:{loc:q}, name}
  for (const r of rows) {
    const s = bySku[r.sku] || (bySku[r.sku] = { pick: 0, bulk: 0, pickBins: {}, bulkBins: {} });
    if (r.kind === 'bulk') { s.bulk += r.q; s.bulkBins[r.location_id] = r.q; }
    else { s.pick += r.q; s.pickBins[r.location_id] = r.q; }
  }
  const nameOf = sku => (db.prepare('SELECT name FROM inventory WHERE client_id=? AND sku=?').get(clientId, sku) || {}).name || '';
  const topBin = bins => Object.entries(bins).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  // The SKU's "home" pick face when its shelf is currently empty: the pick-kind
  // bin it was most recently picked FROM (stock_movements 'pick'/'transfer' out).
  const homePickFace = sku => (db.prepare(`SELECT m.from_location AS loc FROM stock_movements m
    JOIN warehouse_locations wl ON wl.location_id=m.from_location
    WHERE m.client_id=? AND m.sku=? AND wl.kind='pick' AND IFNULL(m.from_location,'')<>''
    ORDER BY m.at DESC, m.id DESC LIMIT 1`).get(clientId, sku) || {}).loc || null;
  const out = [];
  const allSkus = new Set([...Object.keys(shipped), ...Object.keys(bySku)]);
  for (const sku of allSkus) {
    const dem = shipped[sku] || 0;
    if (dem <= 0) continue;                                  // no demand history → nothing to plan yet
    const s = bySku[sku] || { pick: 0, bulk: 0, pickBins: {}, bulkBins: {} };
    const rate = dem / days;
    const target = Math.ceil(rate * cover);
    const need = target - s.pick;
    if (need <= 0) continue;                                 // pick face already covers the target
    if (s.bulk <= 0) continue;                               // nothing in bulk to replenish from
    const moveQty = Math.min(need, s.bulk);
    out.push({
      sku, name: nameOf(sku),
      daily_rate: Math.round(rate * 100) / 100,
      target, pick_qty: s.pick, bulk_qty: s.bulk, need, move_qty: moveQty,
      from_bin: topBin(s.bulkBins),
      to_bin: topBin(s.pickBins) || homePickFace(sku),       // current pick face, else its home; null if never picked from one
    });
  }
  out.sort((a, b) => (b.need) - (a.need));
  return out;
}

// ── Serial numbers (for serial_tracked SKUs) ────────────────────────────────
function addSerials(clientId, sku, serials, receivedRef = '') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId || !sku) throw new Error('clientId and sku required');
  const ins = db.prepare(`INSERT OR IGNORE INTO serials (client_id, sku, serial, status, received_ref) VALUES (?,?,?,'in_stock',?)`);
  let added = 0; const skipped = [];
  const tx = db.transaction(() => {
    for (const raw of (serials || [])) {
      const s = String(raw || '').trim();
      if (!s) continue;
      const info = ins.run(clientId, sku, s, receivedRef);
      if (info.changes > 0) added++; else skipped.push(s); // already exists
    }
  });
  tx();
  return { added, skipped };
}
function shipSerials(clientId, serials, shippedRef = '') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const upd = db.prepare(`UPDATE serials SET status='shipped', shipped_ref=?, shipped_at=CURRENT_TIMESTAMP WHERE client_id=? AND serial=? AND status='in_stock'`);
  let shipped = 0; const notFound = [];
  const tx = db.transaction(() => {
    for (const raw of (serials || [])) {
      const s = String(raw || '').trim();
      if (!s) continue;
      const info = upd.run(shippedRef, clientId, s);
      if (info.changes > 0) shipped++; else notFound.push(s); // unknown or already shipped
    }
  });
  tx();
  return { shipped, notFound };
}
function serialLookup(clientId, serial) {
  const db = _open();
  if (!db) return null;
  if (!clientId) throw new Error('clientId is required');
  return db.prepare('SELECT * FROM serials WHERE client_id=? AND serial=?').get(clientId, String(serial || '').trim()) || null;
}
function serialsForSku(clientId, sku, { status } = {}) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  let sql = 'SELECT * FROM serials WHERE client_id=? AND sku=?';
  const params = [clientId, sku];
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY received_at DESC LIMIT 1000';
  return db.prepare(sql).all(...params);
}
function serialCounts(clientId, sku) {
  const db = _open();
  if (!db) return { in_stock: 0, shipped: 0 };
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM serials WHERE client_id=? AND sku=? GROUP BY status').all(clientId, sku);
  const out = { in_stock: 0, shipped: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// Suggest the bin where this SKU already lives (most stock) — for putaway co-location.
function suggestLocationForSku(clientId, sku) {
  const db = _open();
  if (!db) return null;
  if (!clientId) return null;
  const r = db.prepare(`SELECT location_id, SUM(qty) AS n FROM bin_lots WHERE client_id=? AND sku=? AND qty>0
    GROUP BY location_id ORDER BY n DESC LIMIT 1`).get(clientId, sku);
  return r ? r.location_id : null;
}

// Compute a pick allocation for one SKU/qty WITHOUT consuming — returns the lots
// to pick from, in strategy order (FEFO nearest-expiry / FIFO oldest-inbound), and
// the shortfall if bins don't hold enough. Used to build the pick list at order drop.
function allocatePick(clientId, sku, qty, strategy = 'fefo') {
  const need = Number(qty) || 0;
  const lots = binLotsForSku(clientId, sku, strategy);
  const picks = [];
  let remaining = need;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.qty);
    picks.push({ lot_id: lot.id, location_id: lot.location_id, qty: take, expiry_date: lot.expiry_date, received_at: lot.received_at, lot_number: lot.lot_number });
    remaining -= take;
  }
  return { sku, requested: need, allocated: need - remaining, shortfall: remaining, picks };
}

// Actually decrement the allocated lots (called when the order is picked/completed).
// Re-validates each lot still holds enough; silently caps at what's present so a
// stale allocation can never drive a lot negative. Returns what was consumed.
function consumeAllocations(clientId, allocations, operator = '') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  return db.transaction(() => {
    const consumed = [];
    for (const a of (allocations || [])) {
      for (const p of (a.picks || [])) {
        const lot = db.prepare('SELECT id, qty FROM bin_lots WHERE id=? AND client_id=?').get(p.lot_id, clientId);
        const take = lot ? Math.min(p.qty, lot.qty) : 0;
        if (take > 0) {
          db.prepare('UPDATE bin_lots SET qty=qty-? WHERE id=?').run(take, p.lot_id);
          db.prepare('INSERT INTO stock_movements (sku, client_id, type, qty, reason, from_location, operator, at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
            .run(a.sku, clientId, 'pick', -take, `Picked from ${p.location_id}`, p.location_id, operator);
          consumed.push({ sku: a.sku, location_id: p.location_id, qty: take });
        }
      }
    }
    db.prepare('DELETE FROM bin_lots WHERE client_id=? AND qty<=0').run(clientId);
    return consumed;
  })();
}

// A bin the packer physically found EMPTY — remove this SKU's phantom lots there
// (they aren't really present) and return how many units were cleared. Used by
// short-pick handling so re-allocation stops pointing at the empty bin.
function zeroBinLot(clientId, sku, locationId, operator = '') {
  const db = _open();
  if (!db) return 0;
  if (!clientId) throw new Error('clientId is required');
  return db.transaction(() => {
    const r = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM bin_lots WHERE client_id=? AND sku=? AND location_id=?').get(clientId, sku, locationId);
    const removed = r ? r.n : 0;
    if (removed > 0) {
      db.prepare('DELETE FROM bin_lots WHERE client_id=? AND sku=? AND location_id=?').run(clientId, sku, locationId);
      db.prepare('INSERT INTO stock_movements (sku, client_id, type, qty, reason, from_location, operator, at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
        .run(sku, clientId, 'bin_empty', -removed, `Bin ${locationId} reported empty`, locationId, operator);
    }
    return removed;
  })();
}

// Put previously-consumed units BACK into their bins — the inverse of a pick,
// used when a scan is corrected downward (setqty lower) so bin occupancy stays
// true. entries: [{sku, location_id, qty, received_at, expiry_date, lot_number}].
function restoreLots(clientId, entries, operator = '') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  return db.transaction(() => {
    for (const e of (entries || [])) {
      if (!e.sku || !e.location_id || !(e.qty > 0)) continue;
      _addLot(db, clientId, e.sku, e.location_id, e.qty, e.received_at, e.expiry_date, e.lot_number);
      db.prepare('INSERT INTO stock_movements (sku, client_id, type, qty, reason, to_location, operator, at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
        .run(e.sku, clientId, 'pick_return', e.qty, `Returned to ${e.location_id}`, e.location_id, operator);
    }
    return { ok: true };
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

    db.prepare('UPDATE cycle_counts SET status=?, verified_by=?, completed_at=CURRENT_TIMESTAMP WHERE count_id=?')
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
  db.prepare('UPDATE stock_alerts SET resolved=1, resolved_at=CURRENT_TIMESTAMP WHERE alert_id=?').run(alertId);
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

// Total on-hand units per client across the whole store — one row per client.
// Used by the daily storage-billing snapshot. Returns { clientId: units }.
function stockByClientTotals() {
  const db = _open();
  if (!db) return {};
  const rows = db.prepare('SELECT client_id, SUM(stock_qty) AS units FROM inventory GROUP BY client_id').all();
  const out = {};
  for (const r of rows) out[r.client_id] = Number(r.units) || 0;
  return out;
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

// ── Bundles / BOM — client-scoped (IdealOne is the master) ──────────────────

function _normComponents(components) {
  return (Array.isArray(components) ? components : [])
    .map(c => ({ sku: String(c.sku || '').trim(), qty: Math.max(1, Math.round(Number(c.qty) || 0)) }))
    .filter(c => c.sku && c.qty > 0);
}

function upsertBundle(clientId, bundleSku, name, components, type) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const sku = String(bundleSku || '').trim();
  if (!sku) throw new Error('bundle_sku is required');
  const comps = _normComponents(components);
  if (!comps.length) throw new Error('a bundle needs at least one component (sku + qty)');
  const t = type === 'physical' ? 'physical' : 'virtual';
  db.prepare(`INSERT INTO bundles (client_id, bundle_sku, name, components, type, updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(client_id, bundle_sku) DO UPDATE SET name=excluded.name, components=excluded.components, type=excluded.type, updated_at=datetime('now')`)
    .run(clientId, sku, String(name || sku), JSON.stringify(comps), t);
  return getBundle(clientId, sku);
}

function _rowToBundle(r) {
  if (!r) return null;
  let components = [];
  try { components = JSON.parse(r.components || '[]'); } catch (_) {}
  return { client_id: r.client_id, bundle_sku: r.bundle_sku, name: r.name, components, type: r.type || 'virtual', updated_at: r.updated_at };
}

// PHYSICAL KITTING — build `qty` bundle units: consume the component stock and
// inbound the bundle SKU as real on-hand. Atomic; refuses if any component is
// short (checked against AVAILABLE so reserved units aren't cannibalised).
function buildBundle(clientId, bundleSku, qty) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const n = Math.max(1, Math.round(Number(qty) || 0));
  const b = getBundle(clientId, bundleSku);
  if (!b || !b.components.length) throw new Error('bundle not found');
  return db.transaction(() => {
    // 1. Verify + deduct each component (physical consumption from on-hand).
    for (const c of b.components) {
      const item = get(c.sku, clientId);
      const need = n * c.qty;
      const avail = item ? Math.max(0, item.stock_qty - item.reserved_qty) : 0;
      if (avail < need) throw new Error(`Not enough ${c.sku}: need ${need}, available ${avail}`);
      db.prepare("UPDATE inventory SET stock_qty=stock_qty-?, updated_at=datetime('now') WHERE client_id=? AND sku=?").run(need, clientId, c.sku);
      db.prepare('INSERT INTO stock_movements (sku,client_id,type,qty,reason) VALUES (?,?,?,?,?)').run(c.sku, clientId, 'kit_consume', -need, `Kitted into ${bundleSku}`);
    }
    // 2. Inbound the built bundle SKU as real stock (create the row if new).
    if (!get(bundleSku, clientId)) upsert({ sku: bundleSku, name: b.name || bundleSku, clientId });
    db.prepare("UPDATE inventory SET stock_qty=stock_qty+?, updated_at=datetime('now') WHERE client_id=? AND sku=?").run(n, clientId, bundleSku);
    db.prepare('INSERT INTO stock_movements (sku,client_id,type,qty,reason) VALUES (?,?,?,?,?)').run(bundleSku, clientId, 'kit_build', n, `Built from components`);
    return { bundleSku, built: n, consumed: b.components.map(c => ({ sku: c.sku, qty: n * c.qty })) };
  })();
}

function getBundle(clientId, bundleSku) {
  const db = _open();
  if (!db) return null;
  if (!clientId) throw new Error('clientId is required');
  return _rowToBundle(db.prepare('SELECT * FROM bundles WHERE client_id=? AND bundle_sku=?').get(clientId, bundleSku));
}

function getBundles(clientId) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  return db.prepare('SELECT * FROM bundles WHERE client_id=? ORDER BY bundle_sku').all(clientId).map(_rowToBundle);
}

function deleteBundle(clientId, bundleSku) {
  const db = _open();
  if (!db) return;
  if (!clientId) throw new Error('clientId is required');
  db.prepare('DELETE FROM bundles WHERE client_id=? AND bundle_sku=?').run(clientId, bundleSku);
}

// Derived sellable quantity: how many whole bundles the current component stock
// can make = min over components of floor(componentAvailable / qtyPerBundle).
// A missing component (no stock row) means 0.
function bundleAvailable(clientId, bundleSku) {
  const b = getBundle(clientId, bundleSku);
  if (!b || !b.components.length) return 0;
  let min = Infinity;
  for (const c of b.components) {
    const item = get(c.sku, clientId);
    const avail = item ? Math.max(0, item.stock_qty - item.reserved_qty) : 0;
    min = Math.min(min, Math.floor(avail / c.qty));
  }
  return min === Infinity ? 0 : Math.max(0, min);
}

// VIRTUAL bundle SKUs whose recipe includes the given component — used to
// re-push a derived-availability bundle whenever a component moves. Physical
// kits are excluded: once built, their sellable stock is their own on-hand and
// no longer tracks the components.
function bundlesContaining(clientId, componentSku) {
  return getBundles(clientId)
    .filter(b => b.type === 'virtual' && b.components.some(c => c.sku === componentSku))
    .map(b => b.bundle_sku);
}

module.exports = {
  init, available,
  getAll, get, getByBarcode, resolveToInhouseSku, upsert, remove, adjust, reserveOrder, deductOrder, releaseOrder, movements, getStats, velocity,
  seedFromSkuMap,
  // Bundles / BOM
  upsertBundle, getBundle, getBundles, deleteBundle, bundleAvailable, bundlesContaining, buildBundle,
  // Warehouse locations + lot-level bin stock (FEFO/FIFO)
  createLocation, getLocations, getLocation, updateLocation, locationOccupancy, binCapacityCheck, binContents, replenishmentSuggestions, stockByLocation,
  transferStock, placeStock, locationStockForClient,
  binLotsForSku, suggestLocationForSku, allocatePick, consumeAllocations, restoreLots, zeroBinLot, binnedQty, stagingQty,
  // Serial numbers
  addSerials, shipSerials, serialLookup, serialsForSku, serialCounts,
  // Suppliers
  upsertSupplier, getSuppliers, mapSupplierSku, getSupplierOptions, getReorderSuggestions,
  // Cycle counts
  startCycleCount, recordCycleCountLine, completeCycleCount,
  // Alerts
  createAlert, getActiveAlerts, resolveAlert,
  // Batch tracking
  createBatch, getBatchesBySku, quarantineBatch,
  // Analytics
  stockAging, turnoverRate, slowMovers, stockValue, stockByClientTotals,
};
