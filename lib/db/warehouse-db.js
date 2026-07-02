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
  `);

  cache.set(cacheKey, db);
  return db;
}

module.exports = { getWarehouseDb };
