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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signals (
      id           TEXT PRIMARY KEY,
      instrument   TEXT NOT NULL,
      direction    TEXT NOT NULL,
      entry        NUMERIC NOT NULL,
      stop_loss    NUMERIC NOT NULL,
      tp1          NUMERIC NOT NULL,
      tp2          NUMERIC,
      tp3          NUMERIC,
      rr1          NUMERIC,
      signal_date  DATE NOT NULL,
      outcome      TEXT NOT NULL DEFAULT 'open',
      outcome_date DATE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(instrument, signal_date)
    )
  `);
}

module.exports = { pool, hasDb, init };
