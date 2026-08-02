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

// MUST resolve exactly like server.js does. This previously omitted the
// Railway volume, so on Railway (volume mounted, no explicit DATA_DIR)
// db.json went to the PERSISTENT volume while inventory.db was written into
// the container filesystem — which is wiped on every restart/redeploy. The
// symptom was brutal and misleading: orders/batches survived a redeploy but
// bin locations, stock and everything else in the inventory store silently
// vanished. Keep these two in lockstep; server.js asserts it at boot.
const DATA_DIR = process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || path.join(__dirname, '..', 'data');

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
  // Physical tier, derived from the bin id (see parseLocationId). Stored rather
  // than derived on every read so the suggestion engine can filter in SQL, the
  // admin can OVERRIDE a bin the grammar reads wrongly (tier_locked=1 survives
  // re-stamping), and an unparseable id stays visibly 'unknown' instead of
  // being silently guessed at.
  if (!cols.has('tier'))        handle.exec(`ALTER TABLE warehouse_locations ADD COLUMN tier TEXT DEFAULT ''`);
  if (!cols.has('level_no'))    handle.exec(`ALTER TABLE warehouse_locations ADD COLUMN level_no INTEGER DEFAULT 0`);
  if (!cols.has('row_code'))    handle.exec(`ALTER TABLE warehouse_locations ADD COLUMN row_code TEXT DEFAULT ''`);
  if (!cols.has('bay_code'))    handle.exec(`ALTER TABLE warehouse_locations ADD COLUMN bay_code TEXT DEFAULT ''`);
  if (!cols.has('tier_locked')) handle.exec(`ALTER TABLE warehouse_locations ADD COLUMN tier_locked INTEGER DEFAULT 0`);
  _stampLocationTiers(handle);
  try { _migrateSerialLocation(handle); } catch (e) { /* serials table may not exist yet on a brand-new db */ }
}

// ── LOCATION GRAMMAR ───────────────────────────────────────────────────────
// Per the user: "AA-01-04-02 means Row AA, Bay 1, Level 4, Location 2", and
// "locations with 99-01-01 ... are what we call floor locations". For a racked
// id the THIRD part is the level, and level 01 is on the floor whatever the
// fourth part says.
//
// This reads the location_id and NOTHING else. The zone/aisle/shelf/bin columns
// cannot be trusted for it: in the client's own 10,438-bin sheet, zone says
// "FLOOR A" on level-4 racking (it is a STOREY, not ground level) and
// AA-003-001-A imported as shelf=1, bin=3 — the bay landed in `bin` and the
// -A was dropped.
const FLOOR_ROW_PAT  = /^(\d{2,3})-(\d{1,3})-(\d{1,3})$/;          // 99-01-01, 090-001-001
const RACK_PAT       = /^([A-Z][A-Z0-9]{0,3})-(\d{1,3})-(\d{1,3})(?:-([A-Z0-9]{1,2}))?$/;
const BONDED_PAT     = /BOND/i;   // customs-controlled — never auto-suggested

function parseLocationId(locationId) {
  const id = String(locationId || '').trim().toUpperCase();
  if (!id) return { tier: 'unknown', level: 0, row: '', bay: '', pos: '', bonded: false, label: '' };
  const bonded = BONDED_PAT.test(id);
  let m = id.match(FLOOR_ROW_PAT);
  if (m && !bonded) {
    return { tier: 'floor', level: 1, row: m[1], bay: m[2], pos: m[3], bonded: false,
      label: `Row ${m[1]} · Bay ${Number(m[2])} · floor` };
  }
  m = id.match(RACK_PAT);
  if (m && !bonded) {
    const level = Number(m[3]);
    const pos = m[4] || '';
    return {
      tier: level === 1 ? 'floor' : 'rack', level, row: m[1], bay: m[2], pos, bonded: false,
      label: `Row ${m[1]} · Bay ${Number(m[2])} · Level ${level}${level === 1 ? ' (floor)' : ''}`
        + (pos ? ` · ${pos}` : ''),
    };
  }
  return { tier: 'unknown', level: 0, row: '', bay: '', pos: '', bonded, label: id };
}

// Fill tier/level/row/bay for every bin whose tier the admin has not pinned.
// Idempotent — safe to re-run after any bulk racking change.
function _stampLocationTiers(handle) {
  const rows = handle.prepare(
    `SELECT location_id, tier, level_no, row_code, bay_code FROM warehouse_locations WHERE IFNULL(tier_locked,0)=0`).all();
  if (!rows.length) return;
  const upd = handle.prepare(
    'UPDATE warehouse_locations SET tier=?, level_no=?, row_code=?, bay_code=? WHERE location_id=?');
  handle.transaction(list => {
    for (const r of list) {
      const p = parseLocationId(r.location_id);
      if (r.tier === p.tier && r.level_no === p.level && r.row_code === p.row && r.bay_code === p.bay) continue;
      upd.run(p.tier, p.level, p.row, p.bay, r.location_id);
    }
  })(rows);
}
// A serial identifies ONE physical unit, so once that unit is binned the
// registry should say WHICH bin — otherwise a split line ("10 of these in
// AA-01-01-01, 20 in BB-01-02-01, different serials") is only half recorded.
function _migrateSerialLocation(handle) {
  const cols = new Set(handle.prepare('PRAGMA table_info(serials)').all().map(c => c.name));
  if (!cols.has('location_id')) handle.exec(`ALTER TABLE serials ADD COLUMN location_id TEXT DEFAULT ''`);
  if (!cols.has('lot_number'))  handle.exec(`ALTER TABLE serials ADD COLUMN lot_number TEXT DEFAULT ''`);
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

// Last REAL stock movement per SKU, for aging/slow-mover reporting.
// Deliberately excludes 'reserve' and 'release': allocating stock to an order
// and releasing it again does not move a single physical piece, so counting
// them would reset the aging clock on stock that never left the shelf.
// One query for the whole client — a per-SKU call would be hundreds of round
// trips on a real catalogue.
function lastMovementBySku(clientId) {
  const db = _open();
  const out = new Map();
  if (!db) return out;
  if (!clientId) throw new Error('clientId is required');
  const rows = db.prepare(`
    SELECT sku, MAX(at) AS last_at
      FROM stock_movements
     WHERE client_id = ? AND type NOT IN ('reserve','release')
     GROUP BY sku`).all(clientId);
  for (const r of rows) out.set(r.sku, r.last_at);
  return out;
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

// Warehouse-wide overview across EVERY client — the landing view of the
// Inventory tab. Deliberately NOT client-scoped (unlike getStats above,
// which requires a clientId): this answers "how full is my warehouse, whose
// stock is in it, and what kind of goods are they" for the 3PL operator.
function warehouseOverview() {
  const db = _open();
  if (!db) return null;
  const one = (sql, ...p) => db.prepare(sql).get(...p) || {};

  const loc = one(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN active=1 THEN capacity ELSE 0 END) AS capacity
    FROM warehouse_locations`);
  const occ = one(`SELECT COUNT(DISTINCT location_id) AS binsUsed, SUM(qty) AS units
    FROM bin_lots WHERE qty > 0`);

  const zones = db.prepare(`SELECT zone,
      COUNT(*) AS bins, SUM(capacity) AS capacity
    FROM warehouse_locations WHERE active=1 GROUP BY zone ORDER BY zone`).all();
  const zoneUnits = db.prepare(`SELECT wl.zone AS zone, SUM(bl.qty) AS units,
      COUNT(DISTINCT bl.location_id) AS binsUsed
    FROM bin_lots bl JOIN warehouse_locations wl ON wl.location_id = bl.location_id
    WHERE bl.qty > 0 GROUP BY wl.zone`).all();
  const zUnits = Object.fromEntries(zoneUnits.map(z => [z.zone, z]));

  const clients = db.prepare(`SELECT client_id AS clientId,
      COUNT(*) AS skus,
      SUM(stock_qty) AS onHand,
      SUM(reserved_qty) AS reserved,
      SUM(CASE WHEN stock_qty > reserved_qty THEN stock_qty - reserved_qty ELSE 0 END) AS available
    FROM inventory GROUP BY client_id`).all();
  const clientBins = db.prepare(`SELECT client_id AS clientId,
      COUNT(DISTINCT location_id) AS bins, SUM(qty) AS binUnits
    FROM bin_lots WHERE qty > 0 GROUP BY client_id`).all();
  const cBins = Object.fromEntries(clientBins.map(c => [c.clientId, c]));

  const commodities = db.prepare(`SELECT
      COALESCE(NULLIF(TRIM(category), ''), '(uncategorised)') AS commodity,
      COUNT(*) AS skus, SUM(stock_qty) AS units,
      COUNT(DISTINCT client_id) AS clients
    FROM inventory GROUP BY 1 ORDER BY units DESC`).all();

  const capacity  = loc.capacity || 0;
  const storedQty = occ.units || 0;
  return {
    locations: {
      total:        loc.total   || 0,
      active:       loc.active  || 0,
      capacity,
      binsUsed:     occ.binsUsed || 0,
      binsEmpty:    Math.max(0, (loc.active || 0) - (occ.binsUsed || 0)),
      storedQty,
      occupancyPct: capacity > 0 ? Math.round((storedQty / capacity) * 100) : 0,
    },
    zones: zones.map(z => {
      const u = zUnits[z.zone] || {};
      const cap = z.capacity || 0;
      const units = u.units || 0;
      return {
        zone: z.zone, bins: z.bins || 0, capacity: cap, units,
        binsUsed: u.binsUsed || 0,
        occupancyPct: cap > 0 ? Math.round((units / cap) * 100) : 0,
      };
    }),
    clients: clients.map(c => ({
      clientId:  c.clientId,
      skus:      c.skus      || 0,
      onHand:    c.onHand    || 0,
      reserved:  c.reserved  || 0,
      available: c.available || 0,
      bins:      (cBins[c.clientId] || {}).bins     || 0,
      binUnits:  (cBins[c.clientId] || {}).binUnits || 0,
      // share of TOTAL stored units, so the operator can see who fills the shed
      sharePct:  storedQty > 0 ? Math.round((((cBins[c.clientId] || {}).binUnits || 0) / storedQty) * 100) : 0,
    })).sort((a, b) => b.onHand - a.onHand),
    commodities: commodities.map(c => ({
      commodity: c.commodity, skus: c.skus || 0, units: c.units || 0, clients: c.clients || 0,
    })),
    totals: {
      clients: clients.length,
      skus:    clients.reduce((s, c) => s + (c.skus || 0), 0),
      onHand:  clients.reduce((s, c) => s + (c.onHand || 0), 0),
      reserved: clients.reduce((s, c) => s + (c.reserved || 0), 0),
      available: clients.reduce((s, c) => s + (c.available || 0), 0),
    },
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
  _stampLocationTiers(db);
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
function updateLocation(locationId, { length_cm, width_cm, height_cm, capacity, environment, active, kind, tier } = {}) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  const loc = db.prepare('SELECT * FROM warehouse_locations WHERE location_id=?').get(locationId);
  if (!loc) throw new Error(`Location ${locationId} does not exist`);
  const v = (x, d) => (x === undefined || x === null || x === '') ? d : Number(x) || 0;
  const k = (kind === 'pick' || kind === 'bulk') ? kind : (loc.kind || 'pick');
  db.prepare(`UPDATE warehouse_locations SET length_cm=?, width_cm=?, height_cm=?, capacity=?, environment=?, active=?, kind=? WHERE location_id=?`)
    .run(v(length_cm, loc.length_cm), v(width_cm, loc.width_cm), v(height_cm, loc.height_cm),
      v(capacity, loc.capacity), environment || loc.environment, active === undefined ? loc.active : (active ? 1 : 0), k, locationId);
  // An explicit tier PINS the bin (tier_locked), so re-stamping after a racking
  // import can never undo a correction someone made by hand. '' hands it back
  // to the grammar.
  if (tier !== undefined) {
    const t = ['floor', 'rack', 'unknown'].includes(tier) ? tier : '';
    if (t) db.prepare('UPDATE warehouse_locations SET tier=?, tier_locked=1 WHERE location_id=?').run(t, locationId);
    else { db.prepare('UPDATE warehouse_locations SET tier_locked=0 WHERE location_id=?').run(locationId); _stampLocationTiers(db); }
  }
  return db.prepare('SELECT * FROM warehouse_locations WHERE location_id=?').get(locationId);
}

// Bulk create/update bins from a spreadsheet — warehouse setup, or a racking
// change, without clicking one bin at a time. Upsert by location_id
// (zone-aisle-shelf-bin) so re-uploading a corrected sheet UPDATES the
// existing bins rather than erroring or duplicating. Tolerant per-row like
// the other importers: a bad row is skipped and reported, never aborting the
// whole sheet. Runs in one transaction so a mid-file failure can't leave the
// racking half-applied.
function bulkUpsertLocations(rows) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  const find = db.prepare('SELECT * FROM warehouse_locations WHERE location_id=?');
  const ins  = db.prepare(`INSERT INTO warehouse_locations
      (location_id, zone, aisle, shelf, bin, capacity, environment, active, kind, length_cm, width_cm, height_cm)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const upd  = db.prepare(`UPDATE warehouse_locations
      SET zone=?, aisle=?, shelf=?, bin=?, capacity=?, environment=?, active=?, kind=?, length_cm=?, width_cm=?, height_cm=?
      WHERE location_id=?`);

  const num = (v, d) => (v === undefined || v === null || String(v).trim() === '') ? d : (Number(v) || 0);
  const str = v => String(v === undefined || v === null ? '' : v).trim();

  const tx = db.transaction(list => {
    list.forEach((raw, i) => {
      const rowNo = i + 2; // sheet row (1 = header)
      const zone = str(raw.zone), aisle = str(raw.aisle), shelf = str(raw.shelf), bin = str(raw.bin);
      // An explicit location_id wins over the derived one. Real warehouses
      // already have ids printed on the racking (e.g. "90-001-001" or
      // "AQ-008-002-A") that don't always have exactly four dash-separated
      // parts — re-deriving would silently RENAME those bins and break every
      // physical label and picking list referencing them. zone/aisle/shelf/
      // bin are still stored for grouping on the map.
      const explicitId = str(raw.location_id);
      if (!explicitId && (!zone || !aisle || !shelf || !bin)) {
        result.skipped++;
        result.errors.push({ row: rowNo, error: 'give a location_id, or all of zone, aisle, shelf and bin' });
        return;
      }
      if (!zone) {
        result.skipped++;
        result.errors.push({ row: rowNo, error: 'zone is required' });
        return;
      }
      const id  = explicitId || `${zone}-${aisle}-${shelf}-${bin}`;
      const cur = find.get(id);
      const env = str(raw.environment).toLowerCase() || (cur ? cur.environment : 'dry');
      const kindRaw = str(raw.kind).toLowerCase();
      const kind = (kindRaw === 'pick' || kindRaw === 'bulk') ? kindRaw : (cur ? (cur.kind || 'pick') : 'pick');
      // blank "active" keeps the existing value; only an explicit no/0/false deactivates
      const activeRaw = str(raw.active).toLowerCase();
      const active = activeRaw === '' ? (cur ? cur.active : 1)
                   : (['0', 'no', 'false', 'n', 'inactive'].includes(activeRaw) ? 0 : 1);
      const cap = num(raw.capacity, cur ? cur.capacity : 1000);
      const L = num(raw.length_cm, cur ? cur.length_cm : 0);
      const W = num(raw.width_cm,  cur ? cur.width_cm  : 0);
      const H = num(raw.height_cm, cur ? cur.height_cm : 0);
      try {
        if (cur) { upd.run(zone, aisle, shelf, bin, cap, env, active, kind, L, W, H, id); result.updated++; }
        else     { ins.run(id, zone, aisle, shelf, bin, cap, env, active, kind, L, W, H);  result.created++; }
      } catch (e) {
        result.skipped++;
        result.errors.push({ row: rowNo, location: id, error: e.message });
      }
    });
  });
  tx(rows);
  _stampLocationTiers(db);
  return result;
}

// Generate a regular block of racking (zone + aisle/shelf/bin ranges) — the
// fast path for standard racking where a spreadsheet is overkill. Numeric
// ranges are zero-padded to the widest bound ("1".."12" -> 01..12) so bin ids
// sort correctly; existing bins are left untouched (counted as skipped).
function generateLocations({ zone, aisleFrom, aisleTo, shelfFrom, shelfTo, binFrom, binTo,
                             capacity = 1000, environment = 'dry', kind = 'pick' } = {}) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  const z = String(zone || '').trim();
  if (!z) throw new Error('zone is required');
  const seq = (from, to, label) => {
    const a = parseInt(from, 10), b = parseInt(to, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`${label} range must be numeric`);
    if (b < a) throw new Error(`${label} range is backwards (${from}–${to})`);
    if (b - a > 500) throw new Error(`${label} range is too large (max 500)`);
    const pad = String(Math.max(Math.abs(a), Math.abs(b))).length;
    const out = [];
    for (let i = a; i <= b; i++) out.push(String(i).padStart(pad, '0'));
    return out;
  };
  const aisles = seq(aisleFrom, aisleTo, 'Aisle');
  const shelves = seq(shelfFrom, shelfTo, 'Shelf');
  const bins = seq(binFrom, binTo, 'Bin');
  const total = aisles.length * shelves.length * bins.length;
  if (total > 5000) throw new Error(`That would create ${total} bins — narrow the ranges (max 5000 at a time).`);

  const rows = [];
  for (const a of aisles) for (const s of shelves) for (const b of bins) {
    rows.push({ zone: z, aisle: a, shelf: s, bin: b, capacity, environment, kind });
  }
  // Reuse the upsert path, but never clobber a bin that already exists.
  const find = db.prepare('SELECT location_id FROM warehouse_locations WHERE location_id=?');
  const fresh = rows.filter(r => !find.get(`${r.zone}-${r.aisle}-${r.shelf}-${r.bin}`));
  const res = bulkUpsertLocations(fresh);
  return { ...res, requested: total, alreadyExisted: total - fresh.length };
}

// ── Client-identity casing merge ────────────────────────────────────────────
// client_id is the client's NAME, so the same client uploaded as "BETIME" by
// one source and "Betime" by another ended up with two separate stock
// accounts — half the inventory invisible from each side. The app now
// canonicalises the name on the way in, but rows already written under the
// other casing have to be folded together.
//
// Everything runs in ONE transaction, and quantities are SUMMED rather than
// overwritten, so no stock can be lost by merging. Tables with a UNIQUE
// constraint on client_id need the collision handled explicitly; the rest are
// a straight re-key.
function mergeClientCasing(canonicalNames) {
  const db = _open();
  if (!db) return { merged: [], moved: 0 };
  // Which client_ids actually exist, grouped by lowercase.
  const present = new Set();
  for (const t of ['inventory', 'stock_movements', 'stock_by_location', 'suppliers',
                   'supplier_sku_mapping', 'batch_tracking', 'stock_alerts', 'bin_lots',
                   'serials', 'bundles', 'cycle_counts']) {
    try {
      for (const r of db.prepare(`SELECT DISTINCT client_id AS c FROM ${t}`).all()) {
        if (r.c) present.add(String(r.c));
      }
    } catch (_) { /* table or column absent on an older db */ }
  }
  const byLower = new Map();
  for (const c of present) {
    const k = c.trim().toLowerCase();
    if (!byLower.has(k)) byLower.set(k, []);
    byLower.get(k).push(c);
  }
  // Prefer the spelling the rest of the app has settled on; else the one with
  // the most inventory rows.
  const wanted = new Map((canonicalNames || []).map(n => [String(n).trim().toLowerCase(), String(n).trim()]));
  const jobs = [];
  for (const [k, variants] of byLower) {
    // The winner is the spelling the REST OF THE APP uses, even when no
    // inventory row currently carries that exact casing — otherwise stock ends
    // up filed under "ACME PTE LTD" while orders say "Acme Pte Ltd", and
    // invClientId() looks in the wrong account and finds nothing. Falling back
    // to a variant only happens when the app has no opinion.
    const winner = wanted.get(k) || variants.slice().sort((a, b) => {
      const n = t => { try { return db.prepare('SELECT COUNT(*) n FROM inventory WHERE client_id=?').get(t).n; } catch { return 0; } };
      return n(b) - n(a);
    })[0];
    for (const loser of variants) if (loser !== winner) jobs.push({ winner, loser });
  }
  if (!jobs.length) return { merged: [], moved: 0 };

  let moved = 0;
  const plainTables = ['stock_movements', 'suppliers', 'supplier_sku_mapping',
                       'batch_tracking', 'stock_alerts', 'cycle_counts'];
  const tx = db.transaction(() => {
    for (const { winner, loser } of jobs) {
      // inventory — UNIQUE(client_id, sku): sum the quantities on collision
      try {
        const rows = db.prepare('SELECT * FROM inventory WHERE client_id=?').all(loser);
        for (const r of rows) {
          const hit = db.prepare('SELECT * FROM inventory WHERE client_id=? AND sku=?').get(winner, r.sku);
          if (hit) {
            db.prepare('UPDATE inventory SET stock_qty=stock_qty+?, reserved_qty=reserved_qty+? WHERE client_id=? AND sku=?')
              .run(r.stock_qty || 0, r.reserved_qty || 0, winner, r.sku);
            db.prepare('DELETE FROM inventory WHERE client_id=? AND sku=?').run(loser, r.sku);
          } else {
            db.prepare('UPDATE inventory SET client_id=? WHERE client_id=? AND sku=?').run(winner, loser, r.sku);
          }
          moved++;
        }
      } catch (_) {}
      // stock_by_location — UNIQUE(client_id, sku, location_id): sum on collision
      try {
        const rows = db.prepare('SELECT * FROM stock_by_location WHERE client_id=?').all(loser);
        for (const r of rows) {
          const hit = db.prepare('SELECT * FROM stock_by_location WHERE client_id=? AND sku=? AND location_id=?')
            .get(winner, r.sku, r.location_id);
          if (hit) {
            db.prepare('UPDATE stock_by_location SET qty=qty+? WHERE client_id=? AND sku=? AND location_id=?')
              .run(r.qty || 0, winner, r.sku, r.location_id);
            db.prepare('DELETE FROM stock_by_location WHERE client_id=? AND sku=? AND location_id=?')
              .run(loser, r.sku, r.location_id);
          } else {
            db.prepare('UPDATE stock_by_location SET client_id=? WHERE client_id=? AND sku=? AND location_id=?')
              .run(winner, loser, r.sku, r.location_id);
          }
          moved++;
        }
      } catch (_) {}
      // bundles — UNIQUE(client_id, bundle_sku): the winner's definition wins
      try {
        for (const r of db.prepare('SELECT * FROM bundles WHERE client_id=?').all(loser)) {
          const hit = db.prepare('SELECT 1 FROM bundles WHERE client_id=? AND bundle_sku=?').get(winner, r.bundle_sku);
          if (hit) db.prepare('DELETE FROM bundles WHERE client_id=? AND bundle_sku=?').run(loser, r.bundle_sku);
          else db.prepare('UPDATE bundles SET client_id=? WHERE client_id=? AND bundle_sku=?').run(winner, loser, r.bundle_sku);
          moved++;
        }
      } catch (_) {}
      // serials — UNIQUE(client_id, serial): a duplicate serial is the same
      // physical unit, so keep one
      try {
        for (const r of db.prepare('SELECT * FROM serials WHERE client_id=?').all(loser)) {
          const hit = db.prepare('SELECT 1 FROM serials WHERE client_id=? AND serial=?').get(winner, r.serial);
          if (hit) db.prepare('DELETE FROM serials WHERE client_id=? AND serial=?').run(loser, r.serial);
          else db.prepare('UPDATE serials SET client_id=? WHERE client_id=? AND serial=?').run(winner, loser, r.serial);
          moved++;
        }
      } catch (_) {}
      // bin_lots has no client-unique constraint — straight re-key
      try { moved += db.prepare('UPDATE bin_lots SET client_id=? WHERE client_id=?').run(winner, loser).changes; } catch (_) {}
      for (const t of plainTables) {
        try { moved += db.prepare(`UPDATE ${t} SET client_id=? WHERE client_id=?`).run(winner, loser).changes; } catch (_) {}
      }
    }
  });
  tx();
  return { merged: jobs, moved };
}

// ── Backup / restore ────────────────────────────────────────────────────────
// The nightly backup previously covered db.json only — the entire inventory
// store (bin locations, stock, lots, serials, bundles, suppliers, counts)
// was never backed up at all. These dump and reload every table verbatim so
// a backup is genuinely complete and restorable.
const BACKUP_TABLES = [
  'warehouse_locations', 'inventory', 'bin_lots', 'stock_by_location',
  'stock_movements', 'serials', 'bundles', 'suppliers', 'supplier_sku_mapping',
  'cycle_counts', 'cycle_count_lines', 'stock_alerts', 'batch_tracking',
];

// ── SELECTIVE WIPE, per client ─────────────────────────────────────────────
// For handing a tested account over to the real client: clear the trial data
// without touching anyone else's, and without touching the racking (bins are
// the warehouse's, not the client's — deleting them would wipe every other
// client's locations too).
//
// `item_master` implies `stock`: stock for a SKU that no longer exists is
// orphaned data nothing can reconcile.
const WIPE_STOCK_TABLES = ['bin_lots', 'stock_by_location', 'stock_movements',
                           'serials', 'batch_tracking', 'stock_alerts'];
function clientDataCounts(clientId) {
  const db = _open();
  const out = { item_master: 0, stock_rows: 0, movements: 0, serials: 0, bundles: 0, cycle_counts: 0, on_hand: 0 };
  if (!db || !clientId) return out;
  const n = (sql, ...p) => { try { return db.prepare(sql).get(...p)?.n || 0; } catch { return 0; } };
  out.item_master = n('SELECT COUNT(*) n FROM inventory WHERE client_id=?', clientId);
  out.on_hand     = n('SELECT COALESCE(SUM(stock_qty),0) n FROM inventory WHERE client_id=?', clientId);
  out.stock_rows  = n('SELECT COUNT(*) n FROM bin_lots WHERE client_id=?', clientId);
  out.movements   = n('SELECT COUNT(*) n FROM stock_movements WHERE client_id=?', clientId);
  out.serials     = n('SELECT COUNT(*) n FROM serials WHERE client_id=?', clientId);
  out.bundles     = n('SELECT COUNT(*) n FROM bundles WHERE client_id=?', clientId);
  out.cycle_counts = n('SELECT COUNT(*) n FROM cycle_counts WHERE client_id=?', clientId);
  return out;
}
function wipeClient(clientId, scopes = []) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const want = new Set(scopes);
  const removed = {};
  const del = (table, sql, ...p) => {
    try { removed[table] = (removed[table] || 0) + db.prepare(sql).run(...p).changes; } catch (_) { /* absent table */ }
  };
  db.transaction(() => {
    if (want.has('stock') || want.has('item_master')) {
      for (const t of WIPE_STOCK_TABLES) del(t, `DELETE FROM ${t} WHERE client_id=?`, clientId);
      // Keeping the catalogue but clearing the position: the SKU stays, at zero.
      if (!want.has('item_master')) {
        try { db.prepare('UPDATE inventory SET stock_qty=0, reserved_qty=0 WHERE client_id=?').run(clientId); } catch (_) {}
      }
    }
    if (want.has('bundles')) del('bundles', 'DELETE FROM bundles WHERE client_id=?', clientId);
    if (want.has('cycle_counts')) {
      try {
        db.prepare(`DELETE FROM cycle_count_lines WHERE count_id IN
          (SELECT count_id FROM cycle_counts WHERE client_id=?)`).run(clientId);
      } catch (_) {}
      del('cycle_counts', 'DELETE FROM cycle_counts WHERE client_id=?', clientId);
    }
    if (want.has('suppliers')) {
      del('supplier_sku_mapping', 'DELETE FROM supplier_sku_mapping WHERE client_id=?', clientId);
      del('suppliers', 'DELETE FROM suppliers WHERE client_id=?', clientId);
    }
    // LAST, so the deletes above can still resolve against it.
    if (want.has('item_master')) del('inventory', 'DELETE FROM inventory WHERE client_id=?', clientId);
  })();
  return removed;
}

function exportAll() {
  const db = _open();
  if (!db) return null;
  const out = { exported_at: new Date().toISOString(), tables: {} };
  for (const t of BACKUP_TABLES) {
    try { out.tables[t] = db.prepare(`SELECT * FROM ${t}`).all(); }
    catch { out.tables[t] = []; }   // table may not exist on an older db
  }
  out.counts = Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length]));
  return out;
}

// Restore a dump. mode 'replace' clears each table first (a true point-in-time
// restore); 'merge' leaves existing rows and inserts what is missing. Runs in
// one transaction so a bad file can never leave the store half-written.
function importAll(dump, { mode = 'merge' } = {}) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!dump || !dump.tables) throw new Error('Not a valid inventory backup');
  const result = { mode, restored: {}, skipped: {} };
  const tx = db.transaction(() => {
    for (const t of BACKUP_TABLES) {
      const rows = dump.tables[t];
      if (!Array.isArray(rows)) continue;
      let cols;
      try { cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); }
      catch { continue; }
      if (!cols.length) continue;
      if (mode === 'replace') { try { db.prepare(`DELETE FROM ${t}`).run(); } catch {} }
      let n = 0, skip = 0;
      for (const row of rows) {
        // only columns this database actually has — a backup from a newer
        // build must not blow up an older one
        const use = cols.filter(c => Object.prototype.hasOwnProperty.call(row, c));
        if (!use.length) { skip++; continue; }
        const sql = `INSERT OR IGNORE INTO ${t} (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`;
        try { db.prepare(sql).run(...use.map(c => row[c])); n++; }
        catch { skip++; }
      }
      result.restored[t] = n;
      if (skip) result.skipped[t] = skip;
    }
  });
  tx();
  return result;
}

// Permanently remove a bin. Refuses while anything is still stored in it —
// deleting an occupied bin would orphan that stock with no way to find it.
function deleteLocation(locationId) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  const loc = db.prepare('SELECT * FROM warehouse_locations WHERE location_id=?').get(locationId);
  if (!loc) throw new Error(`Location ${locationId} does not exist`);
  const held = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM bin_lots WHERE location_id=? AND qty>0').get(locationId);
  if ((held?.n || 0) > 0) throw new Error(`${locationId} still holds ${held.n} unit(s) — move the stock out before deleting it.`);
  db.prepare('DELETE FROM warehouse_locations WHERE location_id=?').run(locationId);
  db.prepare('DELETE FROM bin_lots WHERE location_id=?').run(locationId);           // tidy zero-qty rows
  db.prepare('DELETE FROM stock_by_location WHERE location_id=?').run(locationId);
  return { ok: true, location_id: locationId };
}

// Every bin plus how full it is, in ONE query — backs the warehouse map.
// locationOccupancy() below answers this for a single bin; calling it per bin
// would be hundreds of round trips for a real site, so the map uses this.
function locationMap() {
  const db = _open();
  if (!db) return [];
  return db.prepare(`
    SELECT wl.location_id, wl.zone, wl.aisle, wl.shelf, wl.bin, wl.capacity,
           wl.environment, wl.kind, wl.active,
           COALESCE(SUM(bl.qty), 0)      AS occupied,
           COUNT(DISTINCT bl.sku)        AS skus,
           COUNT(DISTINCT bl.client_id)  AS clients
      FROM warehouse_locations wl
      LEFT JOIN bin_lots bl ON bl.location_id = wl.location_id AND bl.qty > 0
     GROUP BY wl.location_id
     ORDER BY wl.zone, wl.aisle, wl.shelf, wl.bin
  `).all();
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

// All lots of one SKU across bins, ordered for picking: PICK FACES FIRST (bulk is
// reserve — only touched when pick faces run dry), then the FEFO/FIFO rotation.
// Pick faces are refilled earliest-expiry-first by replenishment, so they hold
// the nearest-expiry stock — preferring them stays FEFO-consistent end to end.
function binLotsForSku(clientId, sku, strategy = 'fefo') {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  // PICKING PRIORITY — the mirror of the putaway ladder.
  //
  // Per the user: "always deplete from the ground locations first before
  // allocating to the racks IF THERE IS A CHOICE". The last clause is the whole
  // design. Rotation comes first, because FEFO is a compliance rule, not a
  // preference — sending a later-expiring floor unit ahead of a sooner-expiring
  // rack unit would ship the wrong lot and eventually ship expired stock. So:
  //
  //   1. dated lots before undated, nearest expiry first   (FEFO — no choice)
  //   2. GROUND before rack                                (the user's rule)
  //   3. pick face before bulk                             (leave pallets sealed)
  //   4. oldest received first                             (stable, FIFO-ish tie-break)
  //
  // For ordinary non-perishable goods every expiry is NULL, so steps 1 ties and
  // the FLOOR genuinely wins — which is the case this was asked for. Under FIFO
  // the received date leads instead, for the same reason: rotation is the rule,
  // ground is the preference between equals.
  const rotation = strategy === 'fifo'
    ? 'bl.received_at ASC'
    : '(bl.expiry_date IS NULL), bl.expiry_date ASC';
  const tier = `(CASE WHEN IFNULL(wl.tier,'') = 'floor' THEN 0
                      WHEN IFNULL(wl.tier,'') = 'rack'  THEN 2
                      ELSE 1 END)`;                       // unknown sits between: never preferred, never last
  const order = `${rotation}, ${tier}, (CASE WHEN wl.kind='bulk' THEN 1 ELSE 0 END), bl.received_at ASC, bl.id ASC`;
  return db.prepare(`SELECT bl.*, wl.zone, wl.aisle, wl.shelf, wl.bin, wl.kind, wl.tier, wl.level_no
    FROM bin_lots bl
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

// Bins holding this client's stock + when each was last cycle-counted — feeds
// the "counts due" suggestions (never counted / stale / repeat discrepancies).
function countDueBins(clientId, staleDays = 30) {
  const db = _open();
  if (!db) return [];
  if (!clientId) throw new Error('clientId is required');
  const bins = db.prepare(`SELECT location_id, SUM(qty) AS qty FROM bin_lots
    WHERE client_id=? AND qty>0 GROUP BY location_id`).all(clientId);
  const last = {};
  for (const r of db.prepare(`SELECT location_id, MAX(completed_at) AS t FROM cycle_counts
    WHERE status='completed' AND location_id IS NOT NULL GROUP BY location_id`).all()) last[r.location_id] = r.t;
  const cutoff = new Date(Date.now() - staleDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  return bins.map(b => ({
    location_id: b.location_id, qty: b.qty,
    last_counted: last[b.location_id] || null,
    stale: !last[b.location_id] || last[b.location_id] < cutoff,
  }));
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
// Un-register serials that were captured in error — the counterpart to
// addSerials, needed because correcting a receipt's quantity DOWN would
// otherwise leave phantom units registered against the client forever.
// A SHIPPED serial is never removed: that is real history, and the unit left
// the building. Refused ones are returned so the caller can say so.
function removeSerials(clientId, serials) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const del = db.prepare(`DELETE FROM serials WHERE client_id=? AND serial=? AND status='in_stock'`);
  const look = db.prepare('SELECT status FROM serials WHERE client_id=? AND serial=?');
  const removed = [], refused = [];
  db.transaction(() => {
    for (const raw of (serials || [])) {
      const sn = String(raw || '').trim();
      if (!sn) continue;
      const row = look.get(clientId, sn);
      if (!row) continue;                               // not registered — nothing to undo
      if (row.status !== 'in_stock') { refused.push(sn); continue; }
      if (del.run(clientId, sn).changes > 0) removed.push(sn);
    }
  })();
  return { removed, refused };
}
// Record which bin (and lot) a serialised unit went into at putaway. A serial
// that was never captured at receiving is registered now rather than dropped —
// the crew reading it off the carton is the first time the system could know
// it, and refusing it would lose the identity of a real unit.
// A serial already SHIPPED is never re-homed: that unit left the building.
function placeSerials(clientId, sku, serials, locationId, opts = {}) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId || !sku) throw new Error('clientId and sku required');
  const { lot_number = '', received_ref = '' } = opts;
  const look = db.prepare('SELECT id, sku, status FROM serials WHERE client_id=? AND serial=?');
  const upd  = db.prepare('UPDATE serials SET location_id=?, lot_number=?, sku=? WHERE id=?');
  const ins  = db.prepare(`INSERT INTO serials (client_id, sku, serial, status, received_ref, location_id, lot_number)
                           VALUES (?,?,?,'in_stock',?,?,?)`);
  const placed = [], refused = [], added = [];
  db.transaction(() => {
    for (const raw of (serials || [])) {
      const sn = String(raw || '').trim();
      if (!sn) continue;
      const row = look.get(clientId, sn);
      if (!row) { ins.run(clientId, sku, sn, received_ref, locationId, lot_number); added.push(sn); placed.push(sn); continue; }
      if (row.status !== 'in_stock') { refused.push(sn); continue; }
      upd.run(locationId, lot_number, sku, row.id);
      placed.push(sn);
    }
  })();
  return { placed, added, refused };
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

// ── PUTAWAY SUGGESTION ──────────────────────────────────────────────────────
// Where should this parcel go? Returns a RANKED list with a plain-English
// reason for each, never a single forced answer — the receiver puts it where
// the goods actually fit and scans that bin, and a difference is recorded.
//
// HARD CONSTRAINTS filter first (a bin that fails one is never offered):
//   • the bin is active
//   • it has unit headroom left (capacity 0 = unlimited)
//   • the carton physically fits, when both the carton and the bin are measured
// Everything after that is PREFERENCE, in this order:
//   1. CONSOLIDATE  — a bin already holding this SKU. Fewest bins per SKU is
//      the single biggest picking win, and it stops one product being smeared
//      across the warehouse. A bin holding the SAME lot/expiry is preferred
//      over one holding a different lot, so a bin stays easy to pick FEFO from.
//   2. HOME BIN     — where this SKU has historically lived, even if empty now.
//      Pickers build muscle memory; moving a product's home costs more than the
//      bin space it saves.
//   3. PICK FACE THEN BULK — top the pick face up to capacity and send the rest
//      to a bulk bin. This is what stops a full pallet being crammed into a
//      shelf that holds a day's picking.
//   4. SMALLEST BIN THAT FITS — don't burn a pallet location on a carton.
// Heavy cartons prefer LOW shelves (an ergonomics rule, not an optimisation).
const PUTAWAY_HEAVY_KG = 15;   // above this, prefer a low shelf
// ── VELOCITY ───────────────────────────────────────────────────────────────
// Per the user, a SKU is a FAST MOVER when either holds:
//   • it moves almost daily — outbound on ≥70% of the days in the window; or
//   • more than 20% of its OWN on-hand stock ships per week.
// The second rule is normalised against the SKU's own stock (the denominator
// the user chose), averaged over 28 days rather than one raw week so a single
// busy Monday doesn't promote a SKU into prime floor space.
//
// VELOCITY_MIN_UNITS exists because the percentage is meaningless on tiny
// numbers: 1 unit shipped against 2 on hand reads as 50% and would send a
// nothing-SKU to the floor.
//
// Computed on READ, never stamped on the row. The inventory table has a
// last_moved_at column that NOTHING writes — a stale derived field is worse
// than a query, and stock_movements is the real source.
// reserve/release are excluded: allocating stock to an order moves no piece.
const VELOCITY_WINDOW_DAYS = 28;
const VELOCITY_MIN_UNITS = 10;
const VELOCITY_DAILY_RATIO = 0.7;
const VELOCITY_WEEKLY_PCT = 0.20;

function skuVelocity(clientId, sku, { days = VELOCITY_WINDOW_DAYS } = {}) {
  const db = _open();
  const idle = { tier: 'new', units: 0, unitsPerWeek: 0, movementDays: 0, pctOfStock: 0, days, why: 'no movement history yet' };
  if (!db || !clientId || !sku) return idle;
  const row = db.prepare(`SELECT
      SUM(CASE WHEN at >= datetime('now', ?) THEN ABS(qty) ELSE 0 END) AS units,
      COUNT(DISTINCT CASE WHEN at >= datetime('now', ?) THEN date(at) END) AS move_days,
      COUNT(*) AS ever
    FROM stock_movements WHERE client_id=? AND sku=? AND type='outbound'`)
    .get(`-${days} days`, `-${days} days`, clientId, sku) || {};
  const ever = Number(row.ever) || 0;
  if (!ever) return idle;

  const units = Number(row.units) || 0;
  const movementDays = Number(row.move_days) || 0;
  const onHand = Number((db.prepare('SELECT stock_qty FROM inventory WHERE client_id=? AND sku=?')
    .get(clientId, sku) || {}).stock_qty) || 0;
  const unitsPerWeek = (units / days) * 7;
  const pctOfStock = onHand > 0 ? unitsPerWeek / onHand : 0;

  const daily = movementDays / days >= VELOCITY_DAILY_RATIO;
  const churns = pctOfStock >= VELOCITY_WEEKLY_PCT && units >= VELOCITY_MIN_UNITS;
  let tier = 'medium', why = `${Math.round(unitsPerWeek)}/week`;
  if (daily) { tier = 'fast'; why = `ships on ${movementDays} of the last ${days} days`; }
  else if (churns) { tier = 'fast'; why = `${Math.round(pctOfStock * 100)}% of stock ships each week`; }
  else if (!units) { tier = 'slow'; why = `nothing shipped in ${days} days`; }

  return { tier, units, unitsPerWeek: Math.round(unitsPerWeek * 10) / 10, movementDays,
    pctOfStock: Math.round(pctOfStock * 1000) / 1000, onHand, days, why };
}

function suggestPutaway(clientId, sku, qty, opts = {}) {
  const db = _open();
  if (!db || !clientId || !sku) return { suggestions: [], notes: [] };
  const want = Math.max(0, Number(qty) || 0);
  const notes = [];
  const prod = db.prepare('SELECT * FROM inventory WHERE client_id=? AND sku=?').get(clientId, sku) || {};
  const expiry = opts.expiry_date || null;
  const lot = opts.lot_number || '';

  const allBins = db.prepare(`SELECT wl.*,
      COALESCE((SELECT SUM(bl.qty) FROM bin_lots bl WHERE bl.location_id = wl.location_id), 0) AS occ
    FROM warehouse_locations wl WHERE wl.active=1`).all();
  if (!allBins.length) return { suggestions: [], notes: ['No bins are set up yet — add locations under Inventory first.'] };

  // BONDED AREAS ARE NEVER SUGGESTED. A bonded bin is customs-controlled, so
  // putting ordinary stock there is a compliance problem rather than a
  // preference — it is excluded outright, not merely scored down. It can still
  // be typed in by hand if that is genuinely where the goods went.
  const bins = allBins.filter(b => !BONDED_PAT.test(String(b.location_id)) && !BONDED_PAT.test(String(b.zone || '')));
  const bondedSkipped = allBins.length - bins.length;
  if (!bins.length) return { suggestions: [], notes: ['The only bins set up are bonded — those are never suggested automatically.'] };

  // What this SKU already occupies, and how it is lotted there.
  const mine = db.prepare(`SELECT location_id, SUM(qty) AS n,
      SUM(CASE WHEN IFNULL(expiry_date,'')=IFNULL(?, '') AND IFNULL(lot_number,'')=? THEN qty ELSE 0 END) AS sameLot
    FROM bin_lots WHERE client_id=? AND sku=? AND qty>0 GROUP BY location_id`)
    .all(expiry, lot, clientId, sku);
  const mineBy = new Map(mine.map(r => [r.location_id, r]));

  // Its home: where it has been put away most often, even if empty right now.
  // stock_movements records a placement as to_location (there is no
  // location_id column) — reading the wrong one would silently return no home.
  const home = db.prepare(`SELECT to_location AS location_id, COUNT(*) AS n FROM stock_movements
      WHERE client_id=? AND sku=? AND to_location IS NOT NULL AND to_location<>''
      GROUP BY to_location ORDER BY n DESC LIMIT 1`).get(clientId, sku);

  // Where else this CLIENT's stock already lives — so a client stays together
  // when this SKU has no bin of its own yet. Row is worth more than zone: a
  // picker walking one row beats one crossing the warehouse.
  const clientRows = new Map();   // row_code -> units
  const clientBins = new Set();
  for (const r of db.prepare(`SELECT bl.location_id, wl.row_code, SUM(bl.qty) AS q
      FROM bin_lots bl JOIN warehouse_locations wl ON wl.location_id=bl.location_id
      WHERE bl.client_id=? AND bl.qty>0 GROUP BY bl.location_id`).all(clientId)) {
    clientBins.add(r.location_id);
    if (r.row_code) clientRows.set(r.row_code, (clientRows.get(r.row_code) || 0) + Number(r.q));
  }

  const velocity = skuVelocity(clientId, sku);
  const cartonVol = (Number(prod.carton_l) || 0) * (Number(prod.carton_w) || 0) * (Number(prod.carton_h) || 0);
  const heavy = (Number(prod.carton_weight) || 0) >= PUTAWAY_HEAVY_KG;
  const chilled = /chill|cold|frozen|refriger/i.test(String(prod.storage_remarks || ''));

  const headroomOf = b => (Number(b.capacity) > 0 ? Number(b.capacity) - Number(b.occ) : Infinity);
  const fits = b => {
    // Only judged when BOTH are measured — an unmeasured bin or product must
    // not be silently excluded, or a warehouse that never keyed dimensions
    // would get no suggestions at all.
    const binVol = (Number(b.length_cm) || 0) * (Number(b.width_cm) || 0) * (Number(b.height_cm) || 0);
    if (!cartonVol || !binVol) return true;
    return binVol >= cartonVol;
  };

  const usable = bins.filter(b => headroomOf(b) > 0 && fits(b));
  if (!usable.length) {
    return { suggestions: [], notes: ['Every bin is full or too small for this carton — free some space or use an overflow bin.'] };
  }

  const scored = usable.map(b => {
    let score = 0;
    const reasons = [];
    const has = mineBy.get(b.location_id);
    if (has) {
      score += 100;
      if (has.sameLot > 0) { score += 30; reasons.push('already holds this batch'); }
      else reasons.push(`already holds ${sku}`);
    }
    if (home && home.location_id === b.location_id) { score += 60; reasons.push('its usual bin'); }

    // TIER — floor (level 01, or a numeric floor row) is prime space: no ladder,
    // no forklift, quickest to pick. A fast mover earns it; a slow one should
    // not squat on it. Deliberately a MODIFIER, not a gate, so consolidating a
    // SKU still outranks the tier — splitting one SKU across two bins costs the
    // pickers more than a slightly worse level.
    const tier = b.tier || parseLocationId(b.location_id).tier;
    if (velocity.tier === 'fast') {
      if (tier === 'floor') { score += 50; reasons.push('floor tier for a fast mover'); }
      else if (Number(b.level_no) >= 3) score -= 25;
    } else if (velocity.tier === 'slow' && tier === 'floor') {
      score -= 20;                                  // keep the floor for what turns
    }
    // An id the grammar cannot read is deprioritised rather than excluded — it
    // may be a perfectly good bin with an unusual label, but it must not beat a
    // bin we actually understand.
    if (tier === 'unknown') score -= 15;

    // SAME CLIENT TOGETHER — the fallback once this SKU has no bin of its own.
    if (!has && b.row_code && clientRows.has(b.row_code)) {
      score += 35; reasons.push("next to this client's other stock");
    } else if (!has && clientBins.size && b.zone && bins.some(o => o.zone === b.zone && clientBins.has(o.location_id))) {
      score += 12; reasons.push("this client's zone");
    }

    if (b.kind === 'pick') { score += 20; reasons.push('pick face'); }
    else reasons.push('bulk');
    if (chilled && b.environment && b.environment !== 'dry') { score += 40; reasons.push(`${b.environment} storage`); }
    if (chilled && (!b.environment || b.environment === 'dry')) score -= 40;
    // Heavy goods on the floor. This is the SAFETY rule, so it outranks the
    // velocity preference above when the two compete for the same bins — a
    // 15kg+ carton cannot be lifted to level 4 whatever its turnover.
    if (heavy) {
      if (tier === 'floor') { score += 45; reasons.push('floor level for a heavy carton'); }
      else score -= 10 * Math.max(1, Number(b.level_no) || 1);
    }
    // Among otherwise equal bins, the SMALLEST that still fits — a pallet
    // location is worth more than a carton needs.
    const head = headroomOf(b);
    score += head === Infinity ? 0 : Math.max(0, 20 - Math.min(20, head / Math.max(1, want)));
    if (!has && !(home && home.location_id === b.location_id) && Number(b.occ) === 0) reasons.push('empty');
    return { b, score, head, reasons };
  }).sort((x, y) => y.score - x.score);

  // Build the plan: fill the best bin up to its headroom, then the next.
  const suggestions = [];
  let left = want;
  for (const c of scored) {
    if (left <= 0 || suggestions.length >= 3) break;
    const take = c.head === Infinity ? left : Math.min(left, c.head);
    if (take <= 0) continue;
    const parsed = parseLocationId(c.b.location_id);
    suggestions.push({
      location_id: c.b.location_id,
      qty: take,
      kind: c.b.kind || 'pick',
      tier: c.b.tier || parsed.tier,
      level: Number(c.b.level_no) || parsed.level,
      where: parsed.label,                       // "Row AA · Bay 3 · Level 1 (floor)"
      capacity: Number(c.b.capacity) || 0,
      occupied: Number(c.b.occ) || 0,
      headroom: c.head === Infinity ? null : c.head,
      reason: c.reasons.join(' · ') || 'space available',
    });
    left -= take;
  }
  if (left > 0) notes.push(`${left} unit(s) have nowhere obvious to go — the bins above are full to capacity.`);
  if (suggestions.length > 1 && suggestions[0].kind === 'pick') {
    notes.push('More than the pick face holds — top it up and put the rest in bulk.');
  }
  // Say when a preference could not be honoured, rather than quietly degrading.
  if (velocity.tier === 'fast' && suggestions.length && suggestions.every(s => s.tier !== 'floor')) {
    notes.push('This is a fast mover but no floor location is free — the bins above are the next best.');
  }
  if (bondedSkipped) notes.push(`${bondedSkipped} bonded location(s) are never suggested automatically.`);
  return { suggestions, notes, velocity };
}

// SLOTTING — directed putaway for a SKU with no home: the best available PICK
// bin, preferring truly EMPTY bins, then the most free headroom (capacity −
// occupancy; capacity 0 = unlimited, treated as huge). Keeps new SKUs from
// piling into whatever bin the receiver stood nearest to.
function suggestSlotForNewSku() {
  const db = _open();
  if (!db) return null;
  const bins = db.prepare(`SELECT wl.location_id, wl.capacity,
      COALESCE((SELECT SUM(bl.qty) FROM bin_lots bl WHERE bl.location_id = wl.location_id), 0) AS occ
    FROM warehouse_locations wl WHERE wl.active=1 AND wl.kind='pick'`).all();
  if (!bins.length) return null;
  bins.sort((a, b) => {
    const emptyA = a.occ === 0 ? 0 : 1, emptyB = b.occ === 0 ? 0 : 1;
    if (emptyA !== emptyB) return emptyA - emptyB;                 // empty bins first
    const headA = (a.capacity || 1e9) - a.occ, headB = (b.capacity || 1e9) - b.occ;
    return headB - headA;                                          // then most headroom
  });
  return bins[0].location_id;
}

// Compute a pick allocation for one SKU/qty WITHOUT consuming — returns the lots
// to pick from and the shortfall if bins don't hold enough. Used to build the
// pick list at order drop and to keep bin occupancy truthful per scan.
//
// CARTON-AWARE (unitsPerCarton > 1): a large order case-picks the FULL-CARTON
// portion from BULK and takes only the loose remainder from the PICK FACE — so
// the fast-pick shelf isn't needlessly emptied and cartons stay sealed. When the
// SKU has no carton size (upc ≤ 1) it's the plain pick-face-first allocation.
// What would happen if we tried to reserve these lines RIGHT NOW — without
// reserving anything. Used by every intake path so the answer a client is shown
// before approving is the same answer the reservation would give.
// `unknown` = not in this client's item master at all; `short` = known but not
// enough free (available = stock − reserved).
// The outbound stock record: every reserve, release and shipment for a client,
// newest first. This is what the Outbound Stock report reads on both the office
// and the client side, so the two can never tell different stories.
// ── OPENING STOCK / STOCK-TAKE BY FILE ─────────────────────────────────────
// A position sheet ("inventory as on <date>": SKU, Location, Qty) SETS what is
// on the shelf — it does not add to it. That is the only reading that makes a
// re-upload safe: send the same file twice and the position is the same, not
// double. Sending a corrected file simply corrects it.
//
// Bins named in the sheet that do not exist yet are CREATED — the racking is
// physically there, the sheet is what tells us about it — but the count of new
// bins is returned so a typo shows up as "47 new locations" rather than
// vanishing into the map.
function setStockPositions(clientId, rows, { operator = '', reason = 'stock position import', mode = 'add' } = {}) {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  if (!clientId) throw new Error('clientId is required');
  const out = { placed: 0, units: 0, skusCreated: 0, binsCreated: 0, skipped: [], skus: new Set() };
  const findLoc = db.prepare('SELECT location_id FROM warehouse_locations WHERE location_id=?');
  const insLoc  = db.prepare(`INSERT INTO warehouse_locations (location_id, zone, aisle, shelf, bin, capacity, environment, kind)
                              VALUES (?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const r of rows || []) {
      const sku = String(r.sku || '').trim();
      const loc = String(r.location || '').trim().toUpperCase();
      const qty = Number(r.qty);
      if (!sku || !loc || !Number.isFinite(qty) || qty < 0) { out.skipped.push({ sku, location: loc, reason: 'missing sku, location or quantity' }); continue; }

      if (!findLoc.get(loc)) {
        const p = parseLocationId(loc);
        insLoc.run(loc, p.row || 'IMPORT', p.bay || '', String(p.level || ''), p.pos || '', 100000, 'dry', 'pick');
        out.binsCreated++;
      }
      let item = get(sku, clientId);
      if (!item) {
        upsert({ sku, clientId, name: r.name || sku, barcode: r.barcode || '', uom: r.uom || '' });
        out.skusCreated++;
        item = get(sku, clientId);
      } else if ((r.barcode && !item.barcode) || (r.name && !item.name)) {
        upsert({ ...item, sku, clientId, name: item.name || r.name, barcode: item.barcode || r.barcode });
      }
      // ADD (the default, per the user): a putaway file is a delivery being
      // binned, so its quantities go ON TOP of whatever the bin already holds.
      // SET exists for a stock-take, where the sheet states the position rather
      // than adding to it.
      if (mode === 'set') {
        db.prepare('DELETE FROM bin_lots WHERE client_id=? AND sku=? AND location_id=?').run(clientId, sku, loc);
        if (qty > 0) {
          db.prepare(`INSERT INTO bin_lots (client_id, sku, location_id, qty, received_at, lot_number, expiry_date)
                      VALUES (?,?,?,?,date('now'),?,NULL)`).run(clientId, sku, loc, qty, String(r.lot || ''));
        }
      } else if (qty > 0) {
        // Top up an existing undated lot in that bin rather than making a
        // second one, so a bin does not accumulate a row per upload.
        const lot = db.prepare(`SELECT id, qty FROM bin_lots
          WHERE client_id=? AND sku=? AND location_id=? AND expiry_date IS NULL
            AND IFNULL(lot_number,'')=? ORDER BY id LIMIT 1`).get(clientId, sku, loc, String(r.lot || ''));
        if (lot) db.prepare('UPDATE bin_lots SET qty=? WHERE id=?').run(lot.qty + qty, lot.id);
        else db.prepare(`INSERT INTO bin_lots (client_id, sku, location_id, qty, received_at, lot_number, expiry_date)
                         VALUES (?,?,?,?,date('now'),?,NULL)`).run(clientId, sku, loc, qty, String(r.lot || ''));
      }
      out.placed++; out.units += qty; out.skus.add(sku);
    }
    // On-hand is the sum of what is in bins for every SKU the file touched.
    // Reserved is left alone — a reservation belongs to an order, not to a
    // stock count, and wiping it would un-promise units already sold.
    for (const sku of out.skus) {
      const n = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM bin_lots WHERE client_id=? AND sku=?').get(clientId, sku).n;
      db.prepare('UPDATE inventory SET stock_qty=? WHERE client_id=? AND sku=?').run(n, clientId, sku);
      db.prepare(`INSERT INTO stock_movements (sku, client_id, type, qty, reason, operator)
                  VALUES (?,?,?,?,?,?)`).run(sku, clientId, mode === 'set' ? 'adjustment' : 'inbound', n, reason, operator);
    }
  })();
  out.skus = [...out.skus];
  return out;
}

// What is still reserved, per (order, sku), derived from the movement ledger:
// reserved minus released minus shipped. Used to find reservations whose order
// no longer exists — see releaseOrphanReservations in server.js.
function openReservations(clientId) {
  const db = _open();
  if (!db || !clientId) return [];
  return db.prepare(`SELECT order_id, sku,
      SUM(CASE WHEN type='reserve' THEN qty
               WHEN type='release' THEN -qty
               WHEN type='outbound' THEN qty      -- outbound qty is negative
               ELSE 0 END) AS open_qty
    FROM stock_movements
    WHERE client_id=? AND IFNULL(order_id,'')<>'' AND type IN ('reserve','release','outbound')
    GROUP BY order_id, sku
    HAVING open_qty > 0`).all(clientId);
}

function outboundMovements(clientId, { from, to, limit = 20000 } = {}) {
  const db = _open();
  if (!db || !clientId) return [];
  // Qualify every column: `inventory` also has client_id, so a bare one is
  // ambiguous once the join is in and SQLite refuses the whole query.
  const where = ['sm.client_id = ?', "sm.type IN ('reserve','release','outbound')"];
  const params = [clientId];
  if (from) { where.push('date(sm.at) >= date(?)'); params.push(from); }
  if (to)   { where.push('date(sm.at) <= date(?)'); params.push(to); }
  return db.prepare(`SELECT sm.at, sm.type, sm.sku, sm.qty, sm.reason, sm.order_id, sm.operator,
      i.name AS product
    FROM stock_movements sm
    LEFT JOIN inventory i ON i.client_id = sm.client_id AND i.sku = sm.sku
    WHERE ${where.join(' AND ')}
    ORDER BY sm.at DESC, sm.id DESC LIMIT ?`).all(...params, Number(limit) || 20000);
}

function checkAvailability(clientId, items) {
  const out = { unknown: [], short: [], ok: true };
  if (!clientId) return out;
  const need = new Map();
  for (const it of items || []) {
    if (!it || !it.sku) continue;
    need.set(it.sku, (need.get(it.sku) || 0) + (Number(it.qty) || 0));
  }
  for (const [sku, qty] of need) {
    const row = get(sku, clientId);
    if (!row) { out.unknown.push({ sku, qty }); continue; }
    const free = Math.max(0, (Number(row.stock_qty) || 0) - (Number(row.reserved_qty) || 0));
    if (qty > free) out.short.push({ sku, name: row.name || '', needed: qty, available: free, shortfall: qty - free });
  }
  out.ok = !out.unknown.length && !out.short.length;
  return out;
}

function allocatePick(clientId, sku, qty, strategy = 'fefo', unitsPerCarton = 1) {
  const need = Number(qty) || 0;
  const upc = Math.max(1, Number(unitsPerCarton) || 1);
  const lots = binLotsForSku(clientId, sku, strategy); // pick-face-first, each carries .kind, .qty
  const rem = new Map(lots.map(l => [l.id, l.qty]));    // working remaining per lot
  const picks = [];
  const takeFrom = (subset, amount) => {
    for (const l of subset) {
      if (amount <= 0) break;
      const avail = rem.get(l.id) || 0;
      if (avail <= 0) continue;
      const t = Math.min(amount, avail);
      rem.set(l.id, avail - t);
      picks.push({ lot_id: l.id, location_id: l.location_id, qty: t, expiry_date: l.expiry_date, received_at: l.received_at, lot_number: l.lot_number, kind: l.kind });
      amount -= t;
    }
    return amount; // unfulfilled remainder
  };
  let remaining;
  if (upc > 1 && need >= upc) {
    const looseNeed = need % upc;          // eaches beyond full cartons → pick face
    const caseNeed  = need - looseNeed;     // full-carton portion → bulk
    const bulkLots = lots.filter(l => l.kind === 'bulk');
    const pickLots = lots.filter(l => l.kind !== 'bulk');
    const caseLeft  = takeFrom(bulkLots, caseNeed);   // case-pick from bulk
    const looseLeft = takeFrom(pickLots, looseNeed);  // eaches from pick face
    remaining = takeFrom(lots, caseLeft + looseLeft); // fallback for any shortfall (pick-face-first)
  } else {
    remaining = takeFrom(lots, need);       // small order / no carton size → pick-face-first
  }
  return { sku, requested: need, allocated: need - remaining, shortfall: remaining, picks };
}

// Consume up to `qty` from ONE location's lots (FEFO/FIFO within the location),
// returning the lot entries taken. Used by the per-scan reconcile to decrement
// exactly the bins the pick plan says, so occupancy matches what was picked.
function consumeFromLocation(clientId, sku, locationId, qty, strategy = 'fefo', operator = '') {
  const db = _open();
  if (!db) throw new Error('inventory unavailable');
  const rotation = strategy === 'fifo'
    ? 'received_at ASC, id ASC'
    : '(expiry_date IS NULL), expiry_date ASC, received_at ASC, id ASC';
  return db.transaction(() => {
    const lots = db.prepare(`SELECT * FROM bin_lots WHERE client_id=? AND sku=? AND location_id=? AND qty>0 ORDER BY ${rotation}`).all(clientId, sku, locationId);
    let need = Number(qty) || 0; const taken = [];
    for (const lot of lots) {
      if (need <= 0) break;
      const t = Math.min(need, lot.qty);
      db.prepare('UPDATE bin_lots SET qty=qty-? WHERE id=?').run(t, lot.id);
      db.prepare('INSERT INTO stock_movements (sku, client_id, type, qty, reason, from_location, operator, at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
        .run(sku, clientId, 'pick', -t, `Picked from ${locationId}`, locationId, operator);
      taken.push({ lot_id: lot.id, location_id: locationId, qty: t, expiry_date: lot.expiry_date, received_at: lot.received_at, lot_number: lot.lot_number });
      need -= t;
    }
    db.prepare('DELETE FROM bin_lots WHERE client_id=? AND qty<=0').run(clientId);
    return taken;
  })();
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

// CASE-BREAK REPLENISHMENT — when an order needs `looseNeed` eaches but the pick
// face can't cover them, don't pull loose pieces from bulk: bring whole CARTONS
// down from bulk to the pick face (break at the shelf), leaving the remainder on
// the shelf. Returns {from, to, qty, cartons} if it moved stock, else null.
// Only tops up the shortfall (rounded up to whole cartons) — a shelf that already
// covers the eaches is left alone.
function caseBreakReplenish(clientId, sku, looseNeed, unitsPerCarton, operator = '') {
  const db = _open();
  if (!db) return null;
  if (!clientId) return null;
  const upc = Math.max(1, Number(unitsPerCarton) || 1);
  const need = Number(looseNeed) || 0;
  if (upc <= 1 || need <= 0) return null;
  const rows = db.prepare(`SELECT bl.location_id, wl.kind, SUM(bl.qty) AS q
    FROM bin_lots bl JOIN warehouse_locations wl ON wl.location_id=bl.location_id
    WHERE bl.client_id=? AND bl.sku=? AND bl.qty>0 GROUP BY bl.location_id, wl.kind`).all(clientId, sku);
  let pfQty = 0, bulkQty = 0; const pickBins = {}, bulkBins = {};
  for (const r of rows) { if (r.kind === 'bulk') { bulkQty += r.q; bulkBins[r.location_id] = r.q; } else { pfQty += r.q; pickBins[r.location_id] = r.q; } }
  if (pfQty >= need) return null;   // shelf already covers the eaches — no break
  if (bulkQty <= 0) return null;    // nothing to break from
  const shortfall = need - pfQty;
  const moveQty = Math.min(Math.ceil(shortfall / upc) * upc, bulkQty); // whole cartons, capped at bulk
  if (moveQty <= 0) return null;
  const topBin = bins => Object.entries(bins).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const from = topBin(bulkBins);
  let to = topBin(pickBins);
  if (!to) { // SKU has no current pick face — use its home pick face from pick history
    to = (db.prepare(`SELECT m.from_location AS loc FROM stock_movements m
      JOIN warehouse_locations wl ON wl.location_id=m.from_location
      WHERE m.client_id=? AND m.sku=? AND wl.kind='pick' AND IFNULL(m.from_location,'')<>''
      ORDER BY m.at DESC, m.id DESC LIMIT 1`).get(clientId, sku) || {}).loc || null;
  }
  if (!from || !to) return null;    // can't determine a pick face → leave to fallback allocation
  transferStock(clientId, sku, from, to, moveQty, operator || 'case-break');
  return { sku, from, to, qty: moveQty, cartons: Math.ceil(moveQty / upc), left_on_shelf: (pfQty + moveQty) - need };
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
  getAll, get, getByBarcode, resolveToInhouseSku, upsert, remove, adjust, reserveOrder, deductOrder, releaseOrder, movements, lastMovementBySku, getStats, velocity,
  seedFromSkuMap,
  // Bundles / BOM
  upsertBundle, getBundle, getBundles, deleteBundle, bundleAvailable, bundlesContaining, buildBundle,
  // Warehouse locations + lot-level bin stock (FEFO/FIFO)
  dataDir: () => DATA_DIR,
  exportAll, importAll, mergeClientCasing,
  warehouseOverview,
  createLocation, getLocations, getLocation, updateLocation, bulkUpsertLocations, generateLocations, locationMap, deleteLocation, locationOccupancy, binCapacityCheck, binContents, replenishmentSuggestions, stockByLocation,
  transferStock, placeStock, locationStockForClient,
  binLotsForSku, suggestLocationForSku, suggestSlotForNewSku, suggestPutaway, parseLocationId, skuVelocity, allocatePick, consumeAllocations, consumeFromLocation, restoreLots, zeroBinLot, caseBreakReplenish, binnedQty, stagingQty,
  // Serial numbers
  addSerials, removeSerials, placeSerials, shipSerials, serialLookup,
  checkAvailability, outboundMovements, setStockPositions, openReservations,
  clientDataCounts, wipeClient, serialsForSku, serialCounts,
  // Suppliers
  upsertSupplier, getSuppliers, mapSupplierSku, getSupplierOptions, getReorderSuggestions,
  // Cycle counts
  startCycleCount, recordCycleCountLine, completeCycleCount, countDueBins,
  // Alerts
  createAlert, getActiveAlerts, resolveAlert,
  // Batch tracking
  createBatch, getBatchesBySku, quarantineBatch,
  // Analytics
  stockAging, turnoverRate, slowMovers, stockValue, stockByClientTotals,
};
