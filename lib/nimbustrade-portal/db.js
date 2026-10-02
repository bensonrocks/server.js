'use strict';

// Fully isolated from the main OMS product's data (lib/db/main.js, lib/db/tenant.js).
// Postgres when DATABASE_URL is set (Railway). SQLite file otherwise, so a
// checkout without a database still runs the portal.

if (process.env.DATABASE_URL) {
  module.exports = require('./pg-sync').open(process.env.DATABASE_URL);
  return;
}

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.NT_DB_PATH || path.join(DATA_DIR, 'nimbustrade-portal.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS nt_clients (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS nt_users (
    id            TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES nt_clients(id)
  );

  CREATE TABLE IF NOT EXISTS nt_sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    client_id  TEXT NOT NULL,
    username   TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nt_locations (
    id           TEXT PRIMARY KEY,
    client_id    TEXT NOT NULL,
    country      TEXT NOT NULL,
    country_name TEXT NOT NULL,
    city         TEXT NOT NULL,
    lat          REAL NOT NULL,
    lng          REAL NOT NULL,
    FOREIGN KEY (client_id) REFERENCES nt_clients(id)
  );

  CREATE TABLE IF NOT EXISTS nt_inventory (
    id                   TEXT PRIMARY KEY,
    location_id          TEXT NOT NULL,
    sku                  TEXT NOT NULL,
    product_name         TEXT NOT NULL,
    qty_on_hand          INTEGER NOT NULL DEFAULT 0,
    replenish_threshold  INTEGER NOT NULL DEFAULT 0,
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (location_id) REFERENCES nt_locations(id)
  );

  CREATE TABLE IF NOT EXISTS nt_orders (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    order_ref      TEXT NOT NULL,
    country        TEXT NOT NULL,
    country_name   TEXT NOT NULL,
    customer_name  TEXT NOT NULL,
    sku            TEXT NOT NULL,
    product_name   TEXT NOT NULL,
    qty            INTEGER NOT NULL DEFAULT 1,
    status         TEXT NOT NULL DEFAULT 'dropped',
    issue_note     TEXT NOT NULL DEFAULT '',
    vendor_id      TEXT NOT NULL DEFAULT '',
    carrier        TEXT NOT NULL DEFAULT '',
    waybill_number TEXT NOT NULL DEFAULT '',
    due_date       TEXT NOT NULL DEFAULT '',
    order_date     TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES nt_clients(id)
  );

  CREATE TABLE IF NOT EXISTS nt_order_events (
    id         TEXT PRIMARY KEY,
    order_id   TEXT NOT NULL,
    status     TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES nt_orders(id)
  );

  -- Stock replenishment shipments arriving INTO a DC — distinct from
  -- nt_orders, which is outbound to customers. "Inbound to DC" in reports.
  -- Typically originates from the Singapore hub (self-run) onward to an
  -- appointed-partner DC, but origin is a free field since a shipment can
  -- also move DC-to-DC directly.
  CREATE TABLE IF NOT EXISTS nt_inbound_shipments (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    location_id    TEXT NOT NULL,
    reference      TEXT NOT NULL,
    origin         TEXT NOT NULL DEFAULT 'Singapore',
    mode           TEXT NOT NULL DEFAULT 'air',
    carrier        TEXT NOT NULL DEFAULT '',
    waybill_number TEXT NOT NULL DEFAULT '',
    contents       TEXT NOT NULL DEFAULT '',
    expected_qty   INTEGER NOT NULL DEFAULT 0,
    received_qty   INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'in_transit',
    expected_date  TEXT NOT NULL,
    arrived_date   TEXT NOT NULL DEFAULT '',
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES nt_clients(id),
    FOREIGN KEY (location_id) REFERENCES nt_locations(id)
  );

  CREATE TABLE IF NOT EXISTS nt_rates (
    id             TEXT PRIMARY KEY,
    location_id    TEXT NOT NULL UNIQUE,
    currency       TEXT NOT NULL DEFAULT 'USD',
    base_fee       REAL NOT NULL DEFAULT 0,
    per_unit_fee   REAL NOT NULL DEFAULT 0,
    storage_fee    REAL NOT NULL DEFAULT 0,
    notes          TEXT NOT NULL DEFAULT '',
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (location_id) REFERENCES nt_locations(id)
  );

  -- Real negotiated fee schedule, as issued to the client — a structured
  -- document (tiers, bands, terms), not a single per-DC number. Distinct from
  -- nt_rates (the older flat per-DC quick-reference figures).
  CREATE TABLE IF NOT EXISTS nt_rate_cards (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL UNIQUE,
    currency       TEXT NOT NULL DEFAULT 'USD',
    data_json      TEXT NOT NULL,
    prepared_by    TEXT NOT NULL DEFAULT '',
    prepared_title TEXT NOT NULL DEFAULT '',
    issued_date    TEXT NOT NULL DEFAULT '',
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES nt_clients(id)
  );

  CREATE TABLE IF NOT EXISTS nt_vendors (
    id            TEXT PRIMARY KEY,
    country       TEXT NOT NULL,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS nt_vendor_sessions (
    token      TEXT PRIMARY KEY,
    vendor_id  TEXT NOT NULL,
    username   TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nt_staff_users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS nt_staff_sessions (
    token      TEXT PRIMARY KEY,
    staff_id   TEXT NOT NULL,
    username   TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_nt_orders_client ON nt_orders(client_id);
  CREATE INDEX IF NOT EXISTS idx_nt_orders_country ON nt_orders(client_id, country);
  CREATE INDEX IF NOT EXISTS idx_nt_orders_status ON nt_orders(client_id, status);
  CREATE INDEX IF NOT EXISTS idx_nt_orders_vendor ON nt_orders(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_nt_inventory_location ON nt_inventory(location_id);
  CREATE INDEX IF NOT EXISTS idx_nt_order_events_order ON nt_order_events(order_id);
  CREATE INDEX IF NOT EXISTS idx_nt_inbound_client ON nt_inbound_shipments(client_id);
  CREATE INDEX IF NOT EXISTS idx_nt_inbound_location ON nt_inbound_shipments(location_id);
`);

// Migration: earlier deployments created nt_orders before vendor_id/carrier/waybill_number existed.
const orderCols = db.prepare("PRAGMA table_info(nt_orders)").all().map((c) => c.name);
if (!orderCols.includes('vendor_id')) {
  db.exec("ALTER TABLE nt_orders ADD COLUMN vendor_id TEXT NOT NULL DEFAULT ''");
}
if (!orderCols.includes('carrier')) {
  db.exec("ALTER TABLE nt_orders ADD COLUMN carrier TEXT NOT NULL DEFAULT ''");
}
if (!orderCols.includes('waybill_number')) {
  db.exec("ALTER TABLE nt_orders ADD COLUMN waybill_number TEXT NOT NULL DEFAULT ''");
}
if (!orderCols.includes('due_date')) {
  db.exec("ALTER TABLE nt_orders ADD COLUMN due_date TEXT NOT NULL DEFAULT ''");
}
if (!orderCols.includes('detail_json')) {
  db.exec("ALTER TABLE nt_orders ADD COLUMN detail_json TEXT");
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nt_orders_date ON nt_orders(client_id, order_date);
  CREATE INDEX IF NOT EXISTS idx_nt_orders_due ON nt_orders(client_id, due_date);
`);

// Migration: earlier deployments created nt_inbound_shipments before origin/mode existed.
const inboundCols = db.prepare("PRAGMA table_info(nt_inbound_shipments)").all().map((c) => c.name);
if (!inboundCols.includes('origin')) {
  db.exec("ALTER TABLE nt_inbound_shipments ADD COLUMN origin TEXT NOT NULL DEFAULT 'Singapore'");
}
if (!inboundCols.includes('mode')) {
  db.exec("ALTER TABLE nt_inbound_shipments ADD COLUMN mode TEXT NOT NULL DEFAULT 'air'");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS nt_item_master (
    id            TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL,
    sku           TEXT NOT NULL,
    description   TEXT NOT NULL,
    batch_details TEXT,
    serial_number TEXT,
    remark_1      TEXT,
    remark_2      TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (client_id, sku)
  );
  CREATE TABLE IF NOT EXISTS nt_uploads (
    id           TEXT PRIMARY KEY,
    client_id    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    filename     TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT NOT NULL,
    row_count    INTEGER NOT NULL DEFAULT 0,
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at   TEXT,
    decided_by   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_nt_uploads_client ON nt_uploads (client_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_nt_uploads_status ON nt_uploads (status, created_at);
  CREATE INDEX IF NOT EXISTS idx_nt_item_master_client ON nt_item_master (client_id, sku);
`);

module.exports = db;
