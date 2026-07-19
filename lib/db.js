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
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );

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

  CREATE TABLE IF NOT EXISTS admin_ui_settings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    theme             TEXT DEFAULT 'light',
    accent_color      TEXT DEFAULT 'blue',
    font_size         TEXT DEFAULT 'medium',
    warehouse_layout  TEXT DEFAULT 'split-screen',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_attributes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    type      TEXT NOT NULL,
    required  INTEGER DEFAULT 0,
    visible   INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_role_permissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id       INTEGER NOT NULL,
    permission    TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (role_id) REFERENCES admin_roles(id)
  );
`);

module.exports = db;
