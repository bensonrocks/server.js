'use strict';

const express  = require('express');
const path     = require('path');
const { exec } = require('child_process');

const store   = require('./lib/store');
const emailP  = require('./lib/email-parser');
const creds   = require('./lib/credentials');
const syncLog = require('./lib/sync-log');
const lazada  = require('./lib/marketplace/lazada');
const shopee  = require('./lib/marketplace/shopee');
const tiktok  = require('./lib/marketplace/tiktok');
const shopify = require('./lib/marketplace/shopify');
const mapper  = require('./lib/marketplace/mapper');
const auth    = require('./lib/auth');

const app      = express();
const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth — public routes (before middleware) ──────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!auth.checkPassword(password)) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ token: auth.generateToken() });
});

app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  auth.revokeToken(token);
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  res.json({ authenticated: auth.validateToken(token) });
});

// ── Orders ────────────────────────────────────────────────────────────────────

app.get('/api/orders', (req, res) => {
  const { clientId, channel, status, search } = req.query;
  res.json(store.getOrders({ clientId, channel, status, search }));
});

app.get('/api/orders/:id', (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.post('/api/orders/ingest-email', (req, res) => {
  const { body, subject, from } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Email body is required' });
  try {
    const order = emailP.parseEmailBody(body);
    if (subject) order.source.emailSubject = subject;
    if (from)    order.source.emailFrom    = from;
    store.addOrder(order);
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/stats',    (req, res) => res.json(store.getStats()));
app.get('/api/clients',  (req, res) => res.json(store.getClients()));
app.get('/api/channels', (req, res) => res.json(store.getChannels()));

// ── Marketplace Connections ───────────────────────────────────────────────────

const PLATFORMS = ['lazada', 'shopee', 'tiktok', 'shopify'];

// Connection status for all platforms
app.get('/api/connect/status', (req, res) => {
  const all    = creds.getAll();
  const result = {};
  for (const p of PLATFORMS) {
    const c = all[p] || {};
    result[p] = {
      connected:      !!c.accessToken,
      hasCredentials: !!(c.appKey || c.partnerId),
      storeName:      c.storeName  || null,
      connectedAt:    c.connectedAt || null,
      lastSync:       c.lastSync   || null,
      lastSyncCount:  c.lastSyncCount ?? null,
    };
  }
  res.json(result);
});

// Save credentials (app key/secret/token) for a platform
app.post('/api/connect/:platform', (req, res) => {
  const { platform } = req.params;
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unknown platform' });
  const saved = creds.set(platform, req.body);
  // Strip secrets from the response
  const { appSecret, partnerKey, ...safe } = saved;
  res.json({ ok: true, ...safe });
});

// Disconnect a platform
app.delete('/api/connect/:platform', (req, res) => {
  const { platform } = req.params;
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unknown platform' });
  creds.remove(platform);
  res.json({ ok: true });
});

// ── OAuth flows ───────────────────────────────────────────────────────────────

// Lazada
app.get('/api/connect/lazada/oauth-url', (req, res) => {
  const c = creds.get('lazada');
  if (!c?.appKey) return res.status(400).json({ error: 'Save your Lazada App Key first' });
  res.json({ url: lazada.buildAuthUrl(c.appKey, `${BASE_URL}/api/connect/lazada/callback`) });
});

app.get('/api/connect/lazada/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send(errPage('Lazada', 'Missing authorization code'));
  try {
    const c      = creds.get('lazada');
    const tokens = await lazada.exchangeCode(c.appKey, c.appSecret, code);
    creds.set('lazada', { ...tokens, connectedAt: new Date().toISOString() });
    res.send(okPage('Lazada'));
  } catch (e) {
    res.status(500).send(errPage('Lazada', e.message));
  }
});

// Shopee
app.get('/api/connect/shopee/oauth-url', (req, res) => {
  const c = creds.get('shopee');
  if (!c?.partnerId) return res.status(400).json({ error: 'Save your Shopee Partner ID first' });
  res.json({ url: shopee.buildAuthUrl(c.partnerId, c.partnerKey, `${BASE_URL}/api/connect/shopee/callback`) });
});

app.get('/api/connect/shopee/callback', async (req, res) => {
  const { code, shop_id } = req.query;
  if (!code || !shop_id) return res.status(400).send(errPage('Shopee', 'Missing code or shop_id'));
  try {
    const c      = creds.get('shopee');
    const tokens = await shopee.exchangeCode(c.partnerId, c.partnerKey, code, shop_id);
    creds.set('shopee', { ...tokens, connectedAt: new Date().toISOString() });
    res.send(okPage('Shopee'));
  } catch (e) {
    res.status(500).send(errPage('Shopee', e.message));
  }
});

// TikTok Shop
app.get('/api/connect/tiktok/oauth-url', (req, res) => {
  const c = creds.get('tiktok');
  if (!c?.appKey) return res.status(400).json({ error: 'Save your TikTok App Key first' });
  res.json({ url: tiktok.buildAuthUrl(c.appKey, `${BASE_URL}/api/connect/tiktok/callback`) });
});

app.get('/api/connect/tiktok/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send(errPage('TikTok Shop', 'Missing authorization code'));
  try {
    const c      = creds.get('tiktok');
    const tokens = await tiktok.exchangeCode(c.appKey, c.appSecret, code);
    creds.set('tiktok', { ...tokens, connectedAt: new Date().toISOString() });
    res.send(okPage('TikTok Shop'));
  } catch (e) {
    res.status(500).send(errPage('TikTok Shop', e.message));
  }
});

// Shopify
app.get('/api/connect/shopify/oauth-url', (req, res) => {
  const c = creds.get('shopify');
  if (!c?.shopDomain) return res.status(400).json({ error: 'Save your Shopify shop domain first' });
  if (!c?.apiKey) return res.status(400).json({ error: 'Save your Shopify API Key first' });
  res.json({ url: shopify.buildAuthUrl(c.shopDomain, c.apiKey, `${BASE_URL}/api/connect/shopify/callback`) });
});

app.get('/api/connect/shopify/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code) return res.status(400).send(errPage('Shopify', 'Missing authorization code'));
  try {
    const c      = creds.get('shopify');
    const tokens = await shopify.exchangeCode(shop || c.shopDomain, c.apiKey, c.apiSecret, code);
    creds.set('shopify', { ...tokens, connectedAt: new Date().toISOString() });
    res.send(okPage('Shopify'));
  } catch (e) {
    res.status(500).send(errPage('Shopify', e.message));
  }
});

// ── Order Sync ────────────────────────────────────────────────────────────────

app.get('/api/sync/log', (req, res) => res.json(syncLog.recent(100)));

async function syncPlatform(platform, fetchFn, mapFn, opts = {}) {
  const c = creds.get(platform);
  if (!c?.accessToken) throw new Error(`${platform} not connected — save credentials first`);
  const storeName = c.storeName || { lazada: 'Lazada Store', shopee: 'Shopee Store', tiktok: 'TikTok Shop' }[platform];
  const raw       = await fetchFn(c, opts);
  let added = 0;
  for (const item of raw) {
    try { store.addOrder(mapFn(item, storeName)); added++; } catch { /* skip duplicates */ }
  }
  creds.set(platform, { lastSync: new Date().toISOString(), lastSyncCount: added });
  return { platform, at: new Date().toISOString(), fetched: raw.length, added };
}

app.post('/api/sync/lazada', async (req, res) => {
  try {
    const entry = await syncPlatform('lazada', lazada.getOrders, mapper.fromLazada, req.body);
    syncLog.push(entry);
    res.json(entry);
  } catch (e) {
    const entry = { platform: 'lazada', at: new Date().toISOString(), error: e.message };
    syncLog.push(entry);
    res.status(500).json(entry);
  }
});

app.post('/api/sync/shopee', async (req, res) => {
  try {
    const entry = await syncPlatform('shopee', shopee.getOrders, mapper.fromShopee, req.body);
    syncLog.push(entry);
    res.json(entry);
  } catch (e) {
    const entry = { platform: 'shopee', at: new Date().toISOString(), error: e.message };
    syncLog.push(entry);
    res.status(500).json(entry);
  }
});

app.post('/api/sync/tiktok', async (req, res) => {
  try {
    const entry = await syncPlatform('tiktok', tiktok.getOrders, mapper.fromTikTok, req.body);
    syncLog.push(entry);
    res.json(entry);
  } catch (e) {
    const entry = { platform: 'tiktok', at: new Date().toISOString(), error: e.message };
    syncLog.push(entry);
    res.status(500).json(entry);
  }
});

app.post('/api/sync/shopify', async (req, res) => {
  try {
    const entry = await syncPlatform('shopify', shopify.getOrders, mapper.fromShopify, req.body);
    syncLog.push(entry);
    res.json(entry);
  } catch (e) {
    const entry = { platform: 'shopify', at: new Date().toISOString(), error: e.message };
    syncLog.push(entry);
    res.status(500).json(entry);
  }
});

// Sync all connected platforms at once
app.post('/api/sync/all', async (req, res) => {
  const results = await Promise.allSettled([
    syncPlatform('lazada', lazada.getOrders, mapper.fromLazada),
    syncPlatform('shopee', shopee.getOrders, mapper.fromShopee),
    syncPlatform('tiktok', tiktok.getOrders, mapper.fromTikTok),
    syncPlatform('shopify', shopify.getOrders, mapper.fromShopify),
  ]);
  const out = {};
  for (const [i, r] of results.entries()) {
    const p = PLATFORMS[i];
    const entry = r.status === 'fulfilled' ? r.value : { platform: p, at: new Date().toISOString(), error: r.reason.message };
    syncLog.push(entry);
    out[p] = entry;
  }
  res.json(out);
});

// ── Webhooks (for real-time push from Shopee / Lazada) ────────────────────────

app.post('/webhook/shopee', (req, res) => {
  // TODO: verify HMAC signature before processing
  const { code, data } = req.body || {};
  // code 3 = ORDER_STATUS_UPDATE, 15 = ORDER_TRACKING_NUMBER_UPDATE, etc.
  res.json({ ok: true });
});

app.post('/webhook/lazada', (req, res) => {
  res.json({ ok: true });
});

// ── OAuth result pages ────────────────────────────────────────────────────────

function okPage(platform) {
  return `<!DOCTYPE html><html><head><title>Connected!</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.12);max-width:400px;width:90%}.ico{font-size:52px;margin-bottom:16px}.ttl{font-size:22px;font-weight:800;color:#166534;margin-bottom:8px}.sub{color:#64748b;margin-bottom:24px;line-height:1.5}.btn{display:inline-block;padding:12px 28px;background:#166534;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px}</style>
</head><body><div class="box"><div class="ico">&#10003;</div><div class="ttl">${platform} Connected!</div><p class="sub">Your ${platform} store has been successfully linked to IdealOMS. You can now sync orders.</p><a href="/" class="btn">Open IdealOMS</a></div></body></html>`;
}

function errPage(platform, msg) {
  return `<!DOCTYPE html><html><head><title>Error</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#fff5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.12);max-width:400px;width:90%}.ico{font-size:52px;margin-bottom:16px}.ttl{font-size:22px;font-weight:800;color:#991b1b;margin-bottom:8px}.sub{color:#64748b;margin-bottom:8px;line-height:1.5}.err{font-size:12px;color:#991b1b;background:#fee2e2;border-radius:8px;padding:8px 12px;margin-bottom:24px;word-break:break-all}.btn{display:inline-block;padding:12px 28px;background:#991b1b;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px}</style>
</head><body><div class="box"><div class="ico">&#10007;</div><div class="ttl">Connection Failed</div><p class="sub">${platform}</p><div class="err">${msg}</div><a href="/" class="btn">Back to IdealOMS</a></div></body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  IdealOMS ready → ${url}\n`);
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd);
});
