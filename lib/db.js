'use strict';

const crypto = require('crypto');

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

async function columnExists(table, column) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

// One-time backfill so pre-existing rows (from before organizations existed)
// get assigned into a tenant. Safe to run on every boot — it's a no-op once
// every user/order has an organization_id.
async function backfillOrganizations() {
  const { rows: orphanUsers } = await pool.query(
    `SELECT id, name, company FROM users WHERE organization_id IS NULL`
  );
  for (const u of orphanUsers) {
    const orgName = u.company || `${u.name}'s Organization`;
    const orgId = crypto.randomUUID();
    await pool.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [orgId, orgName]);
    await pool.query(
      `UPDATE users SET organization_id = $1, role = 'owner' WHERE id = $2`,
      [orgId, u.id]
    );
  }

  if (await columnExists('orders', 'client_id')) {
    await pool.query(`
      UPDATE orders o SET
        organization_id = u.organization_id,
        created_by_user_id = o.client_id
      FROM users u
      WHERE o.client_id = u.id AND o.organization_id IS NULL
    `);
    await pool.query(`ALTER TABLE orders DROP COLUMN IF EXISTS client_id`);
  }
}

async function init() {
  if (!pool) return; // no DATABASE_URL — JSON file store will be used instead

  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      company         TEXT NOT NULL DEFAULT '',
      organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      role            TEXT NOT NULL DEFAULT 'owner',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_organization_id_idx ON users(organization_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                  TEXT PRIMARY KEY,
      organization_id     TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      created_by_user_id  TEXT REFERENCES users(id),
      recipient_name      TEXT NOT NULL,
      address_line1       TEXT NOT NULL,
      city                TEXT NOT NULL,
      region              TEXT,
      postal_code         TEXT,
      country             TEXT NOT NULL,
      items               JSONB NOT NULL,
      service_level       TEXT NOT NULL DEFAULT 'standard',
      provider_id         TEXT,
      provider_name       TEXT,
      dc_location         TEXT,
      status              TEXT NOT NULL DEFAULT 'received',
      status_history      JSONB NOT NULL DEFAULT '[]',
      tracking_number     TEXT,
      carrier             TEXT,
      price_breakdown     JSONB,
      price_total         NUMERIC NOT NULL DEFAULT 0,
      currency            TEXT NOT NULL DEFAULT 'USD',
      notes               TEXT,
      external_ref        TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES users(id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS orders_organization_id_idx ON orders(organization_id)`);

  await backfillOrganizations();
}

module.exports = { pool, hasDb, init };
