'use strict';

const fs   = require('fs');
const path = require('path');
const { pool, hasDb } = require('../db');

// Document store for the Hunter CRM: PostgreSQL (JSONB) when DATABASE_URL
// is set, JSON files otherwise — same dual-backend pattern as lib/users.js.
// Collections: orgs | staff | leads | events
const DIR = path.join(__dirname, '../../data');

let ready = null;
function init() {
  if (!hasDb) return Promise.resolve();
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS hunter_docs (
        collection TEXT NOT NULL,
        id         TEXT NOT NULL,
        doc        JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (collection, id)
      )`);
  }
  return ready;
}

function file(col) { return path.join(DIR, `hunter-${col}.json`); }
function readFile(col) {
  try { return JSON.parse(fs.readFileSync(file(col), 'utf8')); } catch { return {}; }
}
function writeFile(col, map) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(col), JSON.stringify(map, null, 2));
}

async function list(col) {
  if (hasDb) {
    await init();
    const r = await pool.query('SELECT doc FROM hunter_docs WHERE collection=$1', [col]);
    return r.rows.map(row => row.doc);
  }
  return Object.values(readFile(col));
}

async function get(col, id) {
  if (hasDb) {
    await init();
    const r = await pool.query('SELECT doc FROM hunter_docs WHERE collection=$1 AND id=$2', [col, id]);
    return r.rows[0] ? r.rows[0].doc : null;
  }
  return readFile(col)[id] || null;
}

async function put(col, id, doc) {
  if (hasDb) {
    await init();
    await pool.query(`
      INSERT INTO hunter_docs (collection, id, doc) VALUES ($1, $2, $3)
      ON CONFLICT (collection, id) DO UPDATE SET doc = $3, updated_at = NOW()`,
      [col, id, doc]);
    return doc;
  }
  const map = readFile(col);
  map[id] = doc;
  writeFile(col, map);
  return doc;
}

async function del(col, id) {
  if (hasDb) {
    await init();
    await pool.query('DELETE FROM hunter_docs WHERE collection=$1 AND id=$2', [col, id]);
    return;
  }
  const map = readFile(col);
  delete map[id];
  writeFile(col, map);
}

module.exports = { init, list, get, put, del, backend: hasDb ? 'postgres' : 'json-file' };
