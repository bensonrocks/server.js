'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR    = path.join(__dirname, '..', '..', 'data', 'tenants');
const cache       = new Map();

function getTenantDb(tenantId) {
  if (cache.has(tenantId)) return cache.get(tenantId);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(path.join(DATA_DIR, `${tenantId}.db`));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id            TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      client_name   TEXT NOT NULL,
      channel       TEXT NOT NULL,
      order_date    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      currency      TEXT NOT NULL DEFAULT 'USD',
      notes         TEXT DEFAULT '',
      items         TEXT NOT NULL DEFAULT '[]',
      shipping      TEXT NOT NULL DEFAULT '{}',
      subtotal      REAL DEFAULT 0,
      shipping_cost REAL DEFAULT 0,
      tax           REAL DEFAULT 0,
      total         REAL DEFAULT 0,
      source        TEXT DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_orders (
      id                TEXT PRIMARY KEY,
      tenant_id         TEXT NOT NULL,
      client_id         TEXT NOT NULL,
      client_name       TEXT NOT NULL,
      order_data        TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      upload_filename   TEXT DEFAULT '',
      uploaded_at       TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at       TEXT,
      reviewed_by       TEXT,
      rejection_reason  TEXT DEFAULT '',
      notes             TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS cancellation_requests (
      id                TEXT PRIMARY KEY,
      order_id          TEXT NOT NULL UNIQUE,
      reason            TEXT DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'pending',
      requested_by      TEXT NOT NULL,
      requested_at      TEXT NOT NULL,
      approved_by       TEXT,
      approved_at       TEXT,
      rejected_by       TEXT,
      rejected_at       TEXT,
      rejection_reason  TEXT DEFAULT '',
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      platform   TEXT NOT NULL,
      at         TEXT NOT NULL,
      fetched    INTEGER,
      added      INTEGER,
      error      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lead_sessions (
      id            TEXT PRIMARY KEY,
      vertical      TEXT NOT NULL,
      location      TEXT DEFAULT '',
      seniority     TEXT DEFAULT '',
      company_size  TEXT DEFAULT '',
      total_found   INTEGER DEFAULT 0,
      lead_count    INTEGER DEFAULT 0,
      dug_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS client_users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      active        INTEGER DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS client_sessions (
      token       TEXT PRIMARY KEY,
      client_id   TEXT NOT NULL,
      client_name TEXT NOT NULL,
      username    TEXT NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_api_keys (
      key          TEXT PRIMARY KEY,
      client_id    TEXT NOT NULL,
      client_name  TEXT NOT NULL,
      label        TEXT DEFAULT '',
      active       INTEGER DEFAULT 1,
      last_used_at TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
      apollo_id            TEXT PRIMARY KEY,
      session_id           TEXT NOT NULL,
      vertical             TEXT NOT NULL,
      first_name           TEXT DEFAULT '',
      last_name_masked     TEXT DEFAULT '',
      title                TEXT DEFAULT '',
      company              TEXT DEFAULT '',
      location             TEXT DEFAULT '',
      linkedin_url         TEXT DEFAULT '',
      photo_url            TEXT DEFAULT '',
      has_email            INTEGER DEFAULT 0,
      has_phone            INTEGER DEFAULT 0,
      email                TEXT DEFAULT '',
      phone                TEXT DEFAULT '',
      enriched             INTEGER DEFAULT 0,
      enriched_at          TEXT DEFAULT '',
      contacted            INTEGER DEFAULT 0,
      contacted_at         TEXT DEFAULT '',
      contact_note         TEXT DEFAULT '',
      dug_at               TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES lead_sessions(id)
    );

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
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      client_id     TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      sku       TEXT NOT NULL,
      type      TEXT NOT NULL,
      qty       INTEGER NOT NULL,
      reason    TEXT DEFAULT '',
      order_id  TEXT DEFAULT NULL,
      at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pick_sessions (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL DEFAULT 'manual',
      status       TEXT NOT NULL DEFAULT 'active',
      order_ids    TEXT NOT NULL DEFAULT '[]',
      notes        TEXT DEFAULT '',
      created_by   TEXT DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS pick_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL,
      order_id     TEXT NOT NULL,
      sku          TEXT NOT NULL,
      name         TEXT DEFAULT '',
      location     TEXT DEFAULT '',
      qty_required INTEGER NOT NULL DEFAULT 1,
      qty_picked   INTEGER NOT NULL DEFAULT 0,
      picked_at    TEXT DEFAULT NULL,
      FOREIGN KEY (session_id) REFERENCES pick_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS zetpy_store_mappings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name         TEXT NOT NULL,
      app_account_name TEXT NOT NULL,
      client_id        TEXT NOT NULL,
      client_name      TEXT DEFAULT '',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(app_name, app_account_name)
    );

    CREATE TABLE IF NOT EXISTS store_connection_requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id    TEXT NOT NULL,
      client_name  TEXT DEFAULT '',
      marketplace  TEXT NOT NULL,
      store_name   TEXT NOT NULL,
      notes        TEXT DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at  TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_sku_map (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      platform        TEXT NOT NULL,
      oms_sku         TEXT NOT NULL,
      external_id     TEXT NOT NULL DEFAULT '',
      external_sku_id TEXT NOT NULL DEFAULT '',
      external_name   TEXT NOT NULL DEFAULT '',
      last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, oms_sku)
    );

    CREATE TABLE IF NOT EXISTS order_lines (
      id            TEXT PRIMARY KEY,
      order_id      TEXT NOT NULL,
      sku_id        TEXT,
      sku_code      TEXT,
      sku_name      TEXT DEFAULT '',
      ordered_qty   INTEGER DEFAULT 0,
      picked_qty    INTEGER DEFAULT 0,
      line_number   INTEGER DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS skus (
      id            TEXT PRIMARY KEY,
      code          TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      barcode       TEXT,
      category      TEXT DEFAULT '',
      description   TEXT DEFAULT '',
      unit_price    REAL DEFAULT 0,
      stock_qty     INTEGER DEFAULT 0,
      reserved_qty  INTEGER DEFAULT 0,
      reorder_point INTEGER DEFAULT 10,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrations for existing DBs
  try { db.exec(`ALTER TABLE inventory ADD COLUMN location TEXT DEFAULT ''`); } catch (_) {}
  try { db.exec("ALTER TABLE inventory ADD COLUMN client_id TEXT DEFAULT ''"); } catch (_) {}
  try { db.exec(`ALTER TABLE pick_sessions ADD COLUMN created_by TEXT DEFAULT ''`); } catch (_) {}

  // Initialize WMS schema (auto-allocation, picking waves, returns, etc.)
  const initWMSSchema = require('./wms-schema');
  try { initWMSSchema(db); } catch (e) { console.error('WMS schema init error:', e.message); }

  // Update orders table with warehouse_id if not exists
  try { db.exec('ALTER TABLE orders ADD COLUMN warehouse_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE orders ADD COLUMN external_order_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE orders ADD COLUMN external_order_source TEXT'); } catch (_) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))"); } catch (_) {}

  // WMS enhancements: THU code generation and wave linking
  try { db.exec('ALTER TABLE picking_waves ADD COLUMN thu_code TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE scan_sessions ADD COLUMN wave_id TEXT'); } catch (_) {}

  // B2B Phase 1: Extended order attributes
  try { db.exec('ALTER TABLE order_lines ADD COLUMN serial_number TEXT DEFAULT \'\''); } catch (_) {}
  try { db.exec('ALTER TABLE order_lines ADD COLUMN batch_number TEXT DEFAULT \'\''); } catch (_) {}
  try { db.exec('ALTER TABLE order_lines ADD COLUMN expiry_date TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE order_lines ADD COLUMN length_cm REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE order_lines ADD COLUMN width_cm REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE order_lines ADD COLUMN height_cm REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE order_lines ADD COLUMN weight_kg REAL'); } catch (_) {}

  // B2B Phase 1: Order type tracking
  try { db.exec('ALTER TABLE orders ADD COLUMN order_type TEXT DEFAULT \'b2c\''); } catch (_) {}
  try { db.exec('ALTER TABLE orders ADD COLUMN po_number TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE orders ADD COLUMN waybill TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE orders ADD COLUMN upload_source TEXT'); } catch (_) {}

  // Client-level configuration (for Mayer & other clients with special requirements)
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_config (
      client_id      TEXT PRIMARY KEY,
      bundling_enabled INTEGER DEFAULT 0,
      virtual_warehouse_enabled INTEGER DEFAULT 0,
      settings       TEXT DEFAULT '{}',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS client_bundles (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id      TEXT NOT NULL,
      bundle_sku     TEXT NOT NULL,
      bundle_name    TEXT NOT NULL,
      description    TEXT DEFAULT '',
      config         TEXT NOT NULL DEFAULT '[]',
      active         INTEGER DEFAULT 1,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(client_id, bundle_sku),
      FOREIGN KEY (client_id) REFERENCES client_config(client_id)
    );

    CREATE TABLE IF NOT EXISTS client_virtual_skus (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id      TEXT NOT NULL,
      sku            TEXT NOT NULL,
      warehouse_name TEXT DEFAULT 'Virtual',
      supplier_info  TEXT DEFAULT '',
      fulfillment_method TEXT DEFAULT 'dropship',
      active         INTEGER DEFAULT 1,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(client_id, sku),
      FOREIGN KEY (client_id) REFERENCES client_config(client_id)
    );

    CREATE INDEX IF NOT EXISTS idx_client_bundles_client ON client_bundles(client_id);
    CREATE INDEX IF NOT EXISTS idx_client_virtual_skus_client ON client_virtual_skus(client_id);
  `);

  // TMS: Transport Management System (Address Book, Delivery Tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS address_book (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain TEXT,
      name TEXT NOT NULL UNIQUE,
      code TEXT,
      address TEXT,
      zip TEXT NOT NULL,
      phone TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_address_book_zip ON address_book(zip);
    CREATE INDEX IF NOT EXISTS idx_address_book_name ON address_book(name);

    CREATE TABLE IF NOT EXISTS depot_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zip TEXT NOT NULL DEFAULT '609216',
      address TEXT NOT NULL DEFAULT '40 Penjuru Lane #04-01',
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS delivery_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tms_id TEXT NOT NULL UNIQUE,
      order_id TEXT,
      store TEXT,
      address TEXT,
      zip TEXT,
      phone TEXT,
      cartons TEXT,
      driver TEXT,
      status TEXT DEFAULT 'preplanned',
      pod_remarks TEXT,
      created_at TEXT,
      updated_at TEXT,
      delivered_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status ON delivery_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_delivery_jobs_driver ON delivery_jobs(driver);
    CREATE INDEX IF NOT EXISTS idx_delivery_jobs_delivered_at ON delivery_jobs(delivered_at);

    CREATE TABLE IF NOT EXISTS delivery_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id TEXT NOT NULL UNIQUE,
      job_ids TEXT NOT NULL,
      driver TEXT,
      vehicle TEXT,
      status TEXT DEFAULT 'planning',
      estimated_km REAL,
      estimated_mins INTEGER,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_routes_status ON delivery_routes(status);
  `);

  // Add approval tracking columns to bundles and virtual SKUs (if not exist)
  try { db.exec('ALTER TABLE client_bundles ADD COLUMN status TEXT DEFAULT "approved"'); } catch (_) {}
  try { db.exec('ALTER TABLE client_bundles ADD COLUMN submitted_by TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE client_bundles ADD COLUMN submitted_at TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE client_bundles ADD COLUMN approved_by TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE client_bundles ADD COLUMN approved_at TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE client_bundles ADD COLUMN rejection_reason TEXT'); } catch (_) {}

  try { db.exec('ALTER TABLE client_virtual_skus ADD COLUMN status TEXT DEFAULT "approved"'); } catch (_) {}
  try { db.exec('ALTER TABLE client_virtual_skus ADD COLUMN submitted_by TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE client_virtual_skus ADD COLUMN submitted_at TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE client_virtual_skus ADD COLUMN approved_by TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE client_virtual_skus ADD COLUMN approved_at TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE client_virtual_skus ADD COLUMN rejection_reason TEXT'); } catch (_) {}

  cache.set(tenantId, db);
  return db;
}

module.exports = { getTenantDb };
