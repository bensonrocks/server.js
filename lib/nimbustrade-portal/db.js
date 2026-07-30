'use strict';

// Fully isolated from the main OMS product's data (lib/db/main.js, lib/db/tenant.js).
// This is a separate SQLite file so nothing here can ever touch a real OMS client's data.

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'nimbustrade-portal.db'));

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
  CREATE TABLE IF NOT EXISTS nt_inbound_shipments (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    location_id    TEXT NOT NULL,
    reference      TEXT NOT NULL,
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

module.exports = db;
