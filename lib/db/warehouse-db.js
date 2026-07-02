'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

// One physically separate SQLite file per (tenant, client) pair — never shared
// with sibling clients or with the tenant's own orders/leads database.
const BASE_DIR = path.join(__dirname, '..', '..', 'data', 'tenants');
const cache    = new Map();

function getWarehouseDb(tenantId, clientId) {
  const cacheKey = `${tenantId}::${clientId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const dir = path.join(BASE_DIR, tenantId, 'warehouses');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(path.join(dir, `${clientId}.db`));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouse_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_field_defs (
      id         TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,               -- 'item' | 'location'
      field_key  TEXT NOT NULL,
      label      TEXT NOT NULL,
      field_type TEXT NOT NULL DEFAULT 'text',  -- text|number|boolean|select
      options    TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS facilities (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      address    TEXT NOT NULL DEFAULT '',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS facility_locations (
      id            TEXT PRIMARY KEY,
      facility_id   TEXT NOT NULL,
      code          TEXT NOT NULL,
      zone          TEXT NOT NULL DEFAULT '',
      type          TEXT NOT NULL DEFAULT 'bin',
      custom_fields TEXT NOT NULL DEFAULT '{}',
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (facility_id) REFERENCES facilities(id)
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id            TEXT PRIMARY KEY,
      sku           TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      uom           TEXT NOT NULL DEFAULT 'unit',
      custom_fields TEXT NOT NULL DEFAULT '{}',
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory_stock (
      item_id           TEXT NOT NULL,
      location_id       TEXT NOT NULL,
      quantity          REAL NOT NULL DEFAULT 0,
      reserved_quantity REAL NOT NULL DEFAULT 0,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (item_id, location_id),
      FOREIGN KEY (item_id)     REFERENCES inventory_items(id),
      FOREIGN KEY (location_id) REFERENCES facility_locations(id)
    );

    CREATE TABLE IF NOT EXISTS inventory_moves (
      id               TEXT PRIMARY KEY,
      item_id          TEXT NOT NULL,
      from_location_id TEXT,
      to_location_id   TEXT,
      quantity         REAL NOT NULL,
      move_type        TEXT NOT NULL,            -- receive|pick|ship|transfer|adjust
      reference        TEXT NOT NULL DEFAULT '',
      note             TEXT NOT NULL DEFAULT '',
      created_by       TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (item_id) REFERENCES inventory_items(id)
    );

    -- ── Ported from IDEALPICK (claude/idealpick-subfunction-8kdzj1) ──────────
    -- Adapted from a single flat "inventory" table to this client's own
    -- inventory_items/facility_locations model. Orders themselves still live
    -- in the tenant's shared orders table, not here — pick/pack modules are
    -- handed an ordersApi accessor to reach across to that table.

    CREATE TABLE IF NOT EXISTS pick_waves (
      id           TEXT PRIMARY KEY,
      wave_number  TEXT NOT NULL,
      strategy     TEXT NOT NULL DEFAULT 'fifo',
      status       TEXT NOT NULL DEFAULT 'open',
      notes        TEXT NOT NULL DEFAULT '',
      thu_code     TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pick_tasks (
      id           TEXT PRIMARY KEY,
      wave_id      TEXT NOT NULL,
      order_id     TEXT NOT NULL,
      item_id      TEXT NOT NULL,
      sku          TEXT NOT NULL,
      item_name    TEXT NOT NULL DEFAULT '',
      qty_required REAL NOT NULL DEFAULT 0,
      qty_picked   REAL NOT NULL DEFAULT 0,
      location_id  TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      picker_id    TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      picked_at    TEXT,
      FOREIGN KEY (wave_id)     REFERENCES pick_waves(id),
      FOREIGN KEY (item_id)     REFERENCES inventory_items(id),
      FOREIGN KEY (location_id) REFERENCES facility_locations(id)
    );

    -- Records exactly which location(s) a task's reservation came from, so
    -- releasing/consuming stock on wave completion/cancel is deterministic
    -- even when a SKU is split across multiple locations.
    CREATE TABLE IF NOT EXISTS pick_task_reservations (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      location_id TEXT NOT NULL,
      quantity    REAL NOT NULL,
      FOREIGN KEY (task_id)     REFERENCES pick_tasks(id),
      FOREIGN KEY (location_id) REFERENCES facility_locations(id)
    );

    CREATE TABLE IF NOT EXISTS pack_orders (
      id            TEXT PRIMARY KEY,
      pack_number   TEXT NOT NULL,
      wave_id       TEXT NOT NULL,
      order_id      TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      packer_id     TEXT NOT NULL DEFAULT '',
      total_items   INTEGER NOT NULL DEFAULT 0,
      packed_items  INTEGER NOT NULL DEFAULT 0,
      box_count     INTEGER NOT NULL DEFAULT 0,
      notes         TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      packed_at     TEXT,
      FOREIGN KEY (wave_id) REFERENCES pick_waves(id)
    );

    CREATE TABLE IF NOT EXISTS pack_boxes (
      id            TEXT PRIMARY KEY,
      pack_order_id TEXT NOT NULL,
      box_number    INTEGER NOT NULL,
      sscc          TEXT NOT NULL DEFAULT '',
      weight_kg     REAL NOT NULL DEFAULT 0,
      length_cm     REAL NOT NULL DEFAULT 0,
      width_cm      REAL NOT NULL DEFAULT 0,
      height_cm     REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (pack_order_id) REFERENCES pack_orders(id)
    );

    CREATE TABLE IF NOT EXISTS pack_box_items (
      id            TEXT PRIMARY KEY,
      box_id        TEXT NOT NULL,
      pack_order_id TEXT NOT NULL,
      item_id       TEXT NOT NULL,
      sku           TEXT NOT NULL,
      item_name     TEXT NOT NULL DEFAULT '',
      qty           REAL NOT NULL DEFAULT 0,
      lot_number    TEXT NOT NULL DEFAULT '',
      expiry_date   TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (box_id) REFERENCES pack_boxes(id)
    );

    CREATE TABLE IF NOT EXISTS shipments (
      id               TEXT PRIMARY KEY,
      shipment_number  TEXT NOT NULL,
      pack_order_id    TEXT NOT NULL,
      order_id         TEXT NOT NULL,
      carrier          TEXT NOT NULL DEFAULT '',
      service          TEXT NOT NULL DEFAULT '',
      tracking_no      TEXT NOT NULL DEFAULT '',
      weight_kg        REAL NOT NULL DEFAULT 0,
      box_count        INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'pending',
      recipient_name   TEXT NOT NULL DEFAULT '',
      address_line1    TEXT NOT NULL DEFAULT '',
      address_line2    TEXT NOT NULL DEFAULT '',
      city             TEXT NOT NULL DEFAULT '',
      state_region     TEXT NOT NULL DEFAULT '',
      zip              TEXT NOT NULL DEFAULT '',
      country          TEXT NOT NULL DEFAULT '',
      shipped_at       TEXT,
      est_delivery     TEXT,
      notes            TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (pack_order_id) REFERENCES pack_orders(id)
    );
  `);

  cache.set(cacheKey, db);
  return db;
}

module.exports = { getWarehouseDb };
