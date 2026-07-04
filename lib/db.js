'use strict';

const hasDb = !!process.env.DATABASE_URL;

let pool = null;

if (hasDb) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: !process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false }
      : false,
  });
}

async function init() {
  if (!pool) return; // no DATABASE_URL — JSON file store will be used instead
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      email                  TEXT UNIQUE NOT NULL,
      password_hash          TEXT NOT NULL,
      subscription_status    TEXT NOT NULL DEFAULT 'pending',
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

module.exports = { pool, hasDb, init };
