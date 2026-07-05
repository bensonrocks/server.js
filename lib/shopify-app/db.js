'use strict';
const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.SHOPIFY_PG_URL || 'postgresql://localhost/idealoms_shopify',
      max: 10,
    });
    pool.on('error', e => console.error('[shopify-pg] idle client error:', e.message));
  }
  return pool;
}

async function query(sql, params) {
  return getPool().query(sql, params);
}

async function initSchema() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS shopify_shops (
      id           SERIAL PRIMARY KEY,
      shop_domain  TEXT UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      scope        TEXT,
      tenant_id    TEXT NOT NULL DEFAULT 'default',
      installed_at TIMESTAMPTZ DEFAULT NOW(),
      uninstalled  BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS shopify_sku_mappings (
      id                SERIAL PRIMARY KEY,
      shop_domain       TEXT NOT NULL,
      variant_id        BIGINT NOT NULL,
      product_id        BIGINT NOT NULL,
      shopify_sku       TEXT,
      idealone_sku      TEXT NOT NULL,
      title             TEXT,
      inventory_item_id TEXT,
      UNIQUE(shop_domain, variant_id)
    );

    CREATE TABLE IF NOT EXISTS shopify_inventory_levels (
      id                SERIAL PRIMARY KEY,
      shop_domain       TEXT NOT NULL,
      inventory_item_id TEXT NOT NULL,
      location_id       TEXT NOT NULL,
      location_name     TEXT,
      available         INTEGER DEFAULT 0,
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(shop_domain, inventory_item_id, location_id)
    );

    CREATE TABLE IF NOT EXISTS shopify_webhooks (
      id          SERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      topic       TEXT NOT NULL,
      webhook_id  BIGINT,
      address     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(shop_domain, topic)
    );

    CREATE TABLE IF NOT EXISTS shopify_fulfillments (
      id                SERIAL PRIMARY KEY,
      shop_domain       TEXT NOT NULL,
      order_id          TEXT NOT NULL,
      shopify_order_id  BIGINT NOT NULL,
      fulfillment_id    BIGINT,
      tracking_number   TEXT,
      carrier           TEXT,
      pushed_at         TIMESTAMPTZ DEFAULT NOW(),
      status            TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS shopify_order_map (
      id                 SERIAL PRIMARY KEY,
      shop_domain        TEXT NOT NULL,
      shopify_order_id   BIGINT NOT NULL,
      idealone_order_id  TEXT NOT NULL,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(shop_domain, shopify_order_id)
    );
  `);
}

async function getShop(shopDomain) {
  const r = await query('SELECT * FROM shopify_shops WHERE shop_domain=$1 AND uninstalled=FALSE', [shopDomain]);
  return r.rows[0] || null;
}

async function getAllActiveShops() {
  const r = await query('SELECT * FROM shopify_shops WHERE uninstalled=FALSE');
  return r.rows;
}

module.exports = { getPool, query, initSchema, getShop, getAllActiveShops };
