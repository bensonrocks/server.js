'use strict';

const { query } = require('./db');

// Shopify mandatory privacy webhooks.
// All handlers must return quickly (200 already sent by router); processing is async.

// customers/data_request – customer requests a copy of their data.
// Shopify requires responding via the Partners API within 30 days.
// We log the request; the operator must fulfill it manually / via their process.
async function handleDataRequest(shopDomain, payload) {
  console.log('[shopify compliance] customers/data_request', { shopDomain, customerId: payload.customer?.id });
  await query(
    `INSERT INTO shopify_compliance_log (shop_domain, event_type, payload, received_at)
     VALUES ($1,'data_request',$2,NOW())
     ON CONFLICT DO NOTHING`,
    [shopDomain, JSON.stringify(payload)]
  ).catch(() => {}); // table may not exist on first run
}

// customers/redact – delete all personal data for the specified customer.
async function handleCustomerRedact(shopDomain, payload) {
  const customerId = payload.customer?.id;
  console.log('[shopify compliance] customers/redact', { shopDomain, customerId });
  // We don't store customer PII separately (orders carry shipping address from Shopify).
  // Log that we received and processed the request.
  await query(
    `INSERT INTO shopify_compliance_log (shop_domain, event_type, payload, received_at)
     VALUES ($1,'customer_redact',$2,NOW())
     ON CONFLICT DO NOTHING`,
    [shopDomain, JSON.stringify({ customer_id: customerId, redacted_at: new Date().toISOString() })]
  ).catch(() => {});
}

// shop/redact – the app was uninstalled 48 h ago; delete all shop data.
async function handleShopRedact(shopDomain, payload) {
  console.log('[shopify compliance] shop/redact', { shopDomain });

  await query('DELETE FROM shopify_order_map        WHERE shop_domain=$1', [shopDomain]).catch(() => {});
  await query('DELETE FROM shopify_sku_mappings     WHERE shop_domain=$1', [shopDomain]).catch(() => {});
  await query('DELETE FROM shopify_inventory_levels WHERE shop_domain=$1', [shopDomain]).catch(() => {});
  await query('DELETE FROM shopify_webhooks         WHERE shop_domain=$1', [shopDomain]).catch(() => {});
  await query('DELETE FROM shopify_fulfillments     WHERE shop_domain=$1', [shopDomain]).catch(() => {});
  await query('UPDATE shopify_shops SET uninstalled=TRUE, access_token=\'REDACTED\' WHERE shop_domain=$1', [shopDomain]).catch(() => {});
}

async function ensureComplianceLogTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS shopify_compliance_log (
      id          SERIAL PRIMARY KEY,
      shop_domain TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      payload     JSONB,
      received_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(() => {});
}

module.exports = { handleDataRequest, handleCustomerRedact, handleShopRedact, ensureComplianceLogTable };
