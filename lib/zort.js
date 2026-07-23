'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// ZORT Open API v4 client (https://open-api.zortout.com/v4)
//
// Auth is three plain headers on every request: storename / apikey / apisecret
// (per-STORE credentials — each merchant client connects their own Zort store,
// so every call takes a `store` config object, never globals).
// Spec source: ZORT_Api_v4.0.postman_collection.json (2026-01-01).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINT = 'https://open-api.zortout.com/v4';

function authHeaders(store) {
  return {
    storename: String(store.storename || ''),
    apikey:    String(store.apikey    || ''),
    apisecret: String(store.apisecret || ''),
  };
}

async function zortRequest(store, method, apiPath, { query, body } = {}) {
  const base = String(store.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const url  = new URL(`${base}/${apiPath}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: { ...authHeaders(store), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Zort ${apiPath} failed: HTTP ${res.status} ${String(text).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── Endpoints used by IDEALONE ───────────────────────────────────────────────
const validateApi    = store => zortRequest(store, 'GET', 'Merchant/ValidateApi');
const getApiInfo     = store => zortRequest(store, 'GET', 'Merchant/GetApiInfo');
const getOrders      = (store, query) => zortRequest(store, 'GET', 'Order/GetOrders', { query });
const getOrderDetail = (store, id)    => zortRequest(store, 'GET', 'Order/GetOrderDetail', { query: { id } });
const getSalesChannels = store => zortRequest(store, 'GET', 'Merchant/GetSalesChannels');

// Fulfillment push-back options (which one fires is a per-store setting):
const updateOrderStatus = (store, { id, status, actionDate }) =>
  zortRequest(store, 'POST', 'Order/UpdateOrderStatus', { query: { id, status, actionDate } });
const packOrder = (store, { id, trackingno, shipment }) =>
  zortRequest(store, 'POST', 'Order/PackOrder', { query: { id, trackingno, shipment } });
const readyToShip = (store, { id, trackingno }) =>
  zortRequest(store, 'POST', 'Order/ReadyToShip', { query: { id, trackingno } });

// ── Product / inventory (bidirectional stock sync) ──────────────────────────
// Ported from the in-repo platform-gateway ZORT adapter blueprint
// (packages/platform-gateway/src/adapters/zort). IMPORTANT: verify these exact
// endpoint paths + the base URL on the FIRST production call — the blueprint
// uses base `open.zortout.com` while this live client defaults to
// `open-api.zortout.com/v4`. The per-store `endpoint` override (see zortRequest
// above) lets you correct the base URL from the Connections UI without a
// redeploy, and also points the client at a local mock for testing.
const getProducts = (store, query) => zortRequest(store, 'GET', 'Product/GetProducts', { query });
// Set a SKU's ABSOLUTE available quantity in ZORT (not a delta). We push
// available = on-hand − reserved so ZORT's channel listings reflect what can
// still be sold without double-counting units ZORT already decremented on sale.
const adjustInventory = (store, { sku, qty }) =>
  zortRequest(store, 'POST', 'Product/AdjustInventory', { query: { sku, qty } });
// Push-based alternative to polling — exported for future use; not wired yet.
const registerWebhook = (store, { url, events }) =>
  zortRequest(store, 'POST', 'Webhook/UpdateWebhook', { body: { url, events } });

module.exports = {
  DEFAULT_ENDPOINT,
  zortRequest,
  validateApi,
  getApiInfo,
  getOrders,
  getOrderDetail,
  getSalesChannels,
  updateOrderStatus,
  packOrder,
  readyToShip,
  getProducts,
  adjustInventory,
  registerWebhook,
};
