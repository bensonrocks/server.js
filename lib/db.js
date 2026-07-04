'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'idealoms.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS credentials (
    platform   TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

  CREATE TABLE IF NOT EXISTS sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    platform   TEXT NOT NULL,
    at         TEXT NOT NULL,
    fetched    INTEGER,
    added      INTEGER,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inventory (
    sku          TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    category     TEXT DEFAULT '',
    unit         TEXT DEFAULT 'pcs',
    stock_qty    INTEGER DEFAULT 0,
    reserved_qty INTEGER DEFAULT 0,
    reorder_point INTEGER DEFAULT 10,
    cost_price   REAL DEFAULT 0,
    sell_price   REAL DEFAULT 0,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock_movements (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    sku      TEXT NOT NULL,
    type     TEXT NOT NULL,
    qty      INTEGER NOT NULL,
    reason   TEXT DEFAULT '',
    order_id TEXT DEFAULT NULL,
    at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
