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

  CREATE TABLE IF NOT EXISTS staff_users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'warehouse',
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS staff_sessions (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Ensure the default tenant always exists
const hasTenant = db.prepare("SELECT id FROM tenants WHERE id = 'default'").get();
if (!hasTenant) {
  db.prepare("INSERT INTO tenants (id, name, plan) VALUES ('default', 'Default Tenant', 'basic')").run();
}

// Migrate: add role column to existing DBs
try { db.exec("ALTER TABLE staff_users ADD COLUMN role TEXT NOT NULL DEFAULT 'warehouse'"); } catch (_) {}

// Seed default staff admin — always sync password on startup so credentials are predictable
const { createHash } = require('crypto');
const _sha256 = s => createHash('sha256').update(s).digest('hex');
const DEFAULT_ADMIN_PW = process.env.ADMIN_PASSWORD || 'Admin@1234';
db.prepare("INSERT OR IGNORE INTO staff_users (username, password_hash, role) VALUES (?, ?, 'admin')").run('administrator', _sha256(DEFAULT_ADMIN_PW));
db.prepare("UPDATE staff_users SET password_hash = ?, role = 'admin' WHERE username = 'administrator'").run(_sha256(DEFAULT_ADMIN_PW));

module.exports = db;
