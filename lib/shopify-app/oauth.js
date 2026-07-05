'use strict';

const crypto              = require('crypto');
const { encrypt }         = require('./crypto');
const { verifyOAuthHmac } = require('./hmac');
const { query }           = require('./db');
const { registerAll }     = require('./webhooks');
const { syncProductVariants } = require('./skumap');

const SCOPES = [
  'read_orders', 'write_orders',
  'read_customers',
  'read_fulfillments', 'write_fulfillments',
  'read_inventory', 'write_inventory',
  'read_products',
].join(',');

function normaliseShop(raw) {
  let s = raw.trim().replace(/https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!s.includes('.')) s = `${s}.myshopify.com`;
  return s;
}

function makeRouter(cfg) {
  const { clientId, clientSecret, baseUrl, tenantId = 'default' } = cfg;
  if (!clientId || !clientSecret) throw new Error('SHOPIFY_API_KEY and SHOPIFY_API_SECRET are required');

  const callbackUrl = `${baseUrl}/shopify/callback`;
  // In-memory nonce store (suitable for single-process; use Redis/DB for multi-process)
  const stateStore = new Map();

  const express = require('express');
  const router  = express.Router();

  // GET /shopify/install?shop=mystore.myshopify.com
  router.get('/install', (req, res) => {
    const shop = normaliseShop(req.query.shop || '');
    if (!shop.endsWith('.myshopify.com')) {
      return res.status(400).send('Invalid shop domain — must end in .myshopify.com');
    }
    const state = crypto.randomBytes(16).toString('hex');
    stateStore.set(state, { shop, ts: Date.now() });
    const p = new URLSearchParams({ client_id: clientId, scope: SCOPES, redirect_uri: callbackUrl, state });
    res.redirect(`https://${shop}/admin/oauth/authorize?${p}`);
  });

  // GET /shopify/callback
  router.get('/callback', async (req, res) => {
    const { shop: rawShop, code, state } = req.query;
    const shop = normaliseShop(rawShop || '');

    if (!verifyOAuthHmac(req.query, clientSecret)) {
      return res.status(403).send('HMAC mismatch');
    }
    const stored = stateStore.get(state);
    stateStore.delete(state);
    if (!stored || stored.shop !== shop || Date.now() - stored.ts > 10 * 60 * 1000) {
      return res.status(403).send('Invalid or expired state');
    }

    let accessToken, scope;
    try {
      const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      });
      const j = await r.json();
      if (!j.access_token) throw new Error(j.error_description || 'Token exchange failed');
      accessToken = j.access_token;
      scope       = j.scope;
    } catch (e) {
      return res.status(500).send('OAuth token exchange failed: ' + e.message);
    }

    const encToken = encrypt(accessToken);
    await query(
      `INSERT INTO shopify_shops (shop_domain, access_token, scope, tenant_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (shop_domain) DO UPDATE SET access_token=$2, scope=$3, uninstalled=FALSE, installed_at=NOW()`,
      [shop, encToken, scope, tenantId]
    );

    // Register webhooks and sync product SKUs in background
    setImmediate(async () => {
      try { await registerAll(shop, accessToken, baseUrl); } catch (e) { console.warn('[shopify] webhook reg:', e.message); }
      try { await syncProductVariants(shop, accessToken); } catch (e) { console.warn('[shopify] sku sync:', e.message); }
    });

    res.redirect('/?shopify=connected&shop=' + encodeURIComponent(shop));
  });

  return router;
}

module.exports = { makeRouter };
