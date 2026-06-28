'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ldb = new Database(path.join(DATA_DIR, 'leads.db'));

ldb.pragma('journal_mode = WAL');
ldb.pragma('foreign_keys = ON');

ldb.exec(`
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
    apollo_id        TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL,
    vertical         TEXT NOT NULL,
    first_name       TEXT DEFAULT '',
    last_name_masked TEXT DEFAULT '',
    title            TEXT DEFAULT '',
    company          TEXT DEFAULT '',
    location         TEXT DEFAULT '',
    linkedin_url     TEXT DEFAULT '',
    photo_url        TEXT DEFAULT '',
    has_email        INTEGER DEFAULT 0,
    has_phone        INTEGER DEFAULT 0,
    email            TEXT DEFAULT '',
    phone            TEXT DEFAULT '',
    enriched         INTEGER DEFAULT 0,
    enriched_at      TEXT DEFAULT '',
    contacted        INTEGER DEFAULT 0,
    contacted_at     TEXT DEFAULT '',
    contact_note     TEXT DEFAULT '',
    dug_at           TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES lead_sessions(id)
  );
`);

module.exports = ldb;
