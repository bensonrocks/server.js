'use strict';

/**
 * Shopify Public App integration module for IdealOne OMS.
 *
 * Required env vars:
 *   SHOPIFY_API_KEY       - Shopify app client ID
 *   SHOPIFY_API_SECRET    - Shopify app client secret (also used for HMAC verification)
 *   SHOPIFY_TOKEN_SECRET  - 32-byte secret for AES-256-GCM token encryption
 *                           (generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
 *   SHOPIFY_PG_URL        - PostgreSQL connection string
 *                           e.g. postgresql://user:pass@localhost/idealoms_shopify
 *   BASE_URL              - Public URL of this server (for OAuth callback + webhook address)
 *
 * Routes mounted (all under /shopify):
 *   GET  /shopify/install           Start OAuth install flow
 *   GET  /shopify/callback          OAuth callback, stores encrypted token, registers webhooks
 *   POST /shopify/webhooks          Receives Shopify webhook events (HMAC-verified)
 *
 * API routes (tenant-authenticated via Bearer token):
 *   POST /api/shopify/sync-skus                 Sync product/variant → SKU mappings from Shopify
 *   POST /api/shopify/sync-inventory/pull       Pull inventory levels Shopify → IDEALONE
 *   POST /api/shopify/sync-inventory/push       Push inventory levels IDEALONE → Shopify
 *   POST /api/shopify/push-fulfillment/:orderId Push fulfillment + tracking for a packed/shipped order
 */

const express = require('express');

const { initSchema, query, getShop } = require('./db');
const { decrypt }                    = require('./crypto');
const { makeRouter: makeOAuthRouter } = require('./oauth');
const { makeWebhookRouter }          = require('./webhooks');
const { syncProductVariants }        = require('./skumap');
const { pullFromShopify, pushToShopify } = require('./inventory');
const { pushFulfillment }            = require('./fulfillment');
const { ensureComplianceLogTable }   = require('./compliance');

let _getCtx; // injected via init()

function init(app, getCtx, withTenant) {
  _getCtx = getCtx;

  const clientId     = process.env.SHOPIFY_API_KEY    || '';
  const clientSecret = process.env.SHOPIFY_API_SECRET || '';
  const baseUrl      = process.env.BASE_URL           || 'http://localhost:3000';

  if (!clientId || !clientSecret) {
    console.warn('[shopify-app] SHOPIFY_API_KEY / SHOPIFY_API_SECRET not set — Shopify app routes disabled');
    return;
  }

  // Initialize PostgreSQL schema (non-blocking)
  initSchema()
    .then(() => ensureComplianceLogTable())
    .catch(e => console.error('[shopify-app] DB schema init failed:', e.message));

  // ── Public OAuth routes ──────────────────────────────────────────────────────
  const oauthRouter = makeOAuthRouter({ clientId, clientSecret, baseUrl });
  app.use('/shopify', oauthRouter);

  // ── Webhook receiver ─────────────────────────────────────────────────────────
  const webhookRouter = makeWebhookRouter(clientSecret, getCtx);
  app.use('/shopify/webhooks', webhookRouter);

  // ── Tenant-authenticated API routes ─────────────────────────────────────────
  const api = express.Router();

  // Helper: get the active shop for the calling tenant, decrypt token
  async function getTenantShop(tenantId) {
    const r = await query(
      'SELECT * FROM shopify_shops WHERE tenant_id=$1 AND uninstalled=FALSE ORDER BY installed_at DESC LIMIT 1',
      [tenantId]
    );
    const shop = r.rows[0];
    if (!shop) throw Object.assign(new Error('No active Shopify connection for this tenant'), { status: 400 });
    shop.plainToken = decrypt(shop.access_token);
    return shop;
  }

  // POST /api/shopify/sync-skus
  api.post('/sync-skus', async (req, res) => {
    const tenantId = req.tenantId;
    try {
      const shop = await getTenantShop(tenantId);
      await syncProductVariants(shop.shop_domain, shop.plainToken);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST /api/shopify/sync-inventory/pull
  api.post('/sync-inventory/pull', async (req, res) => {
    const tenantId = req.tenantId;
    try {
      const shop   = await getTenantShop(tenantId);
      const result = await pullFromShopify(shop.shop_domain, shop.plainToken, getCtx);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST /api/shopify/sync-inventory/push
  api.post('/sync-inventory/push', async (req, res) => {
    const tenantId = req.tenantId;
    try {
      const shop   = await getTenantShop(tenantId);
      const result = await pushToShopify(shop.shop_domain, shop.plainToken, getCtx);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST /api/shopify/push-fulfillment/:orderId
  api.post('/push-fulfillment/:orderId', async (req, res) => {
    const tenantId = req.tenantId;
    const { orderId } = req.params;
    try {
      const shop  = await getTenantShop(tenantId);
      const { store } = getCtx(tenantId);
      const order = store.getOrder(orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      const src = order.source || {};
      if (!src.externalId) return res.status(400).json({ error: 'Order has no Shopify external ID' });

      const tracking = {
        number:  src.trackingNo   || req.body?.trackingNo   || null,
        company: src.courier      || req.body?.courier      || null,
        url:     src.trackingUrl  || req.body?.trackingUrl  || null,
      };

      const result = await pushFulfillment(shop.shop_domain, shop.plainToken, orderId, src.externalId, tracking);
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // Protect all /api/shopify/* routes with tenant auth if middleware provided
  if (withTenant) {
    app.use('/api/shopify', withTenant, api);
  } else {
    app.use('/api/shopify', api);
  }
  console.log('[shopify-app] routes mounted: /shopify/install, /shopify/callback, /shopify/webhooks, /api/shopify/*');
}

module.exports = { init };
