'use strict';

const { verifyWebhookHmac }    = require('./hmac');
const { query }                = require('./db');
const { handleOrderCreate, handleOrderUpdated, handleOrderCancelled } = require('./orders');
const { handleDataRequest, handleCustomerRedact, handleShopRedact }   = require('./compliance');

const TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'app/uninstalled',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
];

const API_VER = '2025-01';

async function registerWebhook(shopDomain, accessToken, topic, address) {
  const res = await fetch(`https://${shopDomain}/admin/api/${API_VER}/webhooks.json`, {
    method:  'POST',
    headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ webhook: { topic, address, format: 'json' } }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.webhook;
}

async function registerAll(shopDomain, accessToken, baseUrl) {
  const address = `${baseUrl}/shopify/webhooks`;
  for (const topic of TOPICS) {
    try {
      const wh = await registerWebhook(shopDomain, accessToken, topic, address);
      await query(
        `INSERT INTO shopify_webhooks (shop_domain, topic, webhook_id, address)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (shop_domain, topic) DO UPDATE SET webhook_id=$3, address=$4`,
        [shopDomain, topic, wh.id, address]
      );
    } catch (e) {
      console.warn(`[shopify] webhook ${topic} registration failed:`, e.message);
    }
  }
}

function makeWebhookRouter(clientSecret, getCtx) {
  const express = require('express');
  const router  = express.Router();

  // req.rawBody is set by the express.json verify callback in server.js
  router.post('/', async (req, res) => {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    // Use raw buffer captured by express.json verify; fall back to re-serialised body
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

    if (!verifyWebhookHmac(rawBody, hmacHeader, clientSecret)) {
      return res.status(401).send('HMAC verification failed');
    }

    // Acknowledge immediately before processing
    res.status(200).send('OK');

    const topic      = req.headers['x-shopify-topic'] || '';
    const shopDomain = req.headers['x-shopify-shop-domain'] || '';
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { payload = {}; }

    try {
      if      (topic === 'orders/create')           await handleOrderCreate(shopDomain, payload, getCtx);
      else if (topic === 'orders/updated')          await handleOrderUpdated(shopDomain, payload, getCtx);
      else if (topic === 'orders/cancelled')        await handleOrderCancelled(shopDomain, payload, getCtx);
      else if (topic === 'app/uninstalled')         await handleAppUninstalled(shopDomain, payload);
      else if (topic === 'customers/data_request')  await handleDataRequest(shopDomain, payload);
      else if (topic === 'customers/redact')        await handleCustomerRedact(shopDomain, payload);
      else if (topic === 'shop/redact')             await handleShopRedact(shopDomain, payload);
      else console.warn('[shopify] unhandled webhook topic:', topic);
    } catch (e) {
      console.error(`[shopify] webhook handler error (${topic}):`, e.message);
    }
  });

  return router;
}

async function handleAppUninstalled(shopDomain) {
  await query('UPDATE shopify_shops SET uninstalled=TRUE WHERE shop_domain=$1', [shopDomain]);
}

module.exports = { TOPICS, registerAll, makeWebhookRouter };
