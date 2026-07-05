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
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      company       TEXT NOT NULL DEFAULT '',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                TEXT PRIMARY KEY,
      client_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_name    TEXT NOT NULL,
      address_line1     TEXT NOT NULL,
      city              TEXT NOT NULL,
      region            TEXT,
      postal_code       TEXT,
      country           TEXT NOT NULL,
      items             JSONB NOT NULL,
      service_level     TEXT NOT NULL DEFAULT 'standard',
      provider_id       TEXT,
      provider_name     TEXT,
      dc_location       TEXT,
      status            TEXT NOT NULL DEFAULT 'received',
      status_history    JSONB NOT NULL DEFAULT '[]',
      tracking_number   TEXT,
      carrier           TEXT,
      price_breakdown   JSONB,
      price_total       NUMERIC NOT NULL DEFAULT 0,
      currency          TEXT NOT NULL DEFAULT 'USD',
      notes             TEXT,
      external_ref      TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS orders_client_id_idx ON orders(client_id)`);
}

module.exports = { pool, hasDb, init };
