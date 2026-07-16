'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'connections.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS platform_credentials (
    tenant_id   TEXT NOT NULL,
    platform    TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tenant_id, platform)
  );

  CREATE TABLE IF NOT EXISTS client_platform_connections (
    tenant_id    TEXT NOT NULL,
    client_id    TEXT NOT NULL,
    platform     TEXT NOT NULL,
    data         TEXT NOT NULL DEFAULT '{}',
    is_deleted   INTEGER NOT NULL DEFAULT 0,
    connected_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tenant_id, client_id, platform)
  );

  CREATE TABLE IF NOT EXISTS platform_credentials_v2 (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    platform    TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'direct',
    data        TEXT NOT NULL DEFAULT '{}',
    is_active   INTEGER NOT NULL DEFAULT 0,
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, platform, source),
    CHECK (is_active IN (0, 1)),
    CHECK (is_deleted IN (0, 1))
  );

  CREATE INDEX IF NOT EXISTS idx_platform_credentials_v2_tenant_platform
    ON platform_credentials_v2(tenant_id, platform, is_deleted);
  CREATE INDEX IF NOT EXISTS idx_platform_credentials_v2_active
    ON platform_credentials_v2(tenant_id, platform, is_active)
    WHERE is_deleted = 0;
`);

// Add is_deleted column to client_platform_connections if it doesn't exist
try {
  db.prepare('ALTER TABLE client_platform_connections ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0').run();
} catch (e) {
  if (!e.message.includes('duplicate column')) throw e;
}

module.exports = db;
