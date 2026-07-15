'use strict';

const hasDb = !!process.env.IDEALINBOUND_DATABASE_URL;

let pool = null;

if (hasDb) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.IDEALINBOUND_DATABASE_URL,
    ssl: !process.env.IDEALINBOUND_DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false }
      : false,
  });
}

async function init() {
  if (!pool) return; // no IDEALINBOUND_DATABASE_URL — JSON file store will be used instead
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      email          TEXT UNIQUE NOT NULL,
      password_hash  TEXT NOT NULL,
      role           TEXT NOT NULL DEFAULT 'warehouse',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

module.exports = { pool, hasDb, init };
