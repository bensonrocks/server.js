'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'main.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    plan       TEXT NOT NULL DEFAULT 'basic',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Ensure the default tenant always exists
const hasTenant = db.prepare("SELECT id FROM tenants WHERE id = 'default'").get();
if (!hasTenant) {
  db.prepare("INSERT INTO tenants (id, name, plan) VALUES ('default', 'Default Tenant', 'basic')").run();
}

module.exports = db;
