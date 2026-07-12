// Persistence for the IDEAL engine: model state, signal history, learning journal.
// Uses PostgreSQL (a single JSONB key/value table) when DATABASE_URL is set,
// otherwise JSON files under data/ideal/ — same dual-backend pattern as lib/users.js.
'use strict';

const fs   = require('fs');
const path = require('path');
const { pool, hasDb } = require('../db');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'ideal');

async function init() {
  if (!hasDb) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ideal_store (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function filePath(key) {
  return path.join(DATA_DIR, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

async function load(key, fallback = null) {
  if (hasDb) {
    const { rows } = await pool.query('SELECT value FROM ideal_store WHERE key = $1', [key]);
    return rows.length ? rows[0].value : fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath(key), 'utf8'));
  } catch {
    return fallback;
  }
}

async function save(key, value) {
  if (hasDb) {
    await pool.query(
      `INSERT INTO ideal_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath(key), JSON.stringify(value, null, 2));
}

module.exports = { init, load, save };
