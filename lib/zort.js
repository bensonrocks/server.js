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
// CONFIRMED against ZORT_Api_v4.0 (2026-01-01): the stock endpoints are the
// …StockList family, and `Product/AdjustInventory` — which the platform-gateway
// blueprint used and this client inherited — DOES NOT EXIST. It would have
// failed on every push.
//
// UpdateProductAvailableStockList sets the ABSOLUTE available figure, which is
// exactly what we push (on-hand − reserved). Body is a list, so it batches; we
// send one entry per outbox message and let the queue do the pacing.
const adjustInventory = (store, { sku, qty }) =>
  zortRequest(store, 'POST', 'Product/UpdateProductAvailableStockList', {
    query: store.warehouseCode ? { warehousecode: store.warehouseCode } : {},
    body: { stocks: [{ sku, stock: Number(qty) || 0 }] },
  });
// Push-based alternative to polling — exported for future use; not wired yet.
const registerWebhook = (store, { url, events }) =>
  zortRequest(store, 'POST', 'Webhook/UpdateWebhook', { body: { url, events } });

// ── Push a product (the item master row) INTO the store ─────────────────────
// IdealOne's item master, loaded at client onboarding, is the master record —
// the store needs the same catalogue so its channel listings carry the right
// code, name and barcode. Quantities are NOT sent here: stock is pushed
// separately by adjustInventory as an absolute available figure.
//
// Same caveat as the label call: the exact path is not confirmed against a live
// account, so `store.productPath` overrides it from the Connections screen with
// no redeploy.
// CONFIRMED: POST Product/AddProduct with
// {sku, name, sellprice, purchaseprice, unittext, weight, barcode}.
// Note the field names — `sku` (not code) and `unittext` (not unit). Undocumented
// fields are NOT sent: a field the API ignores today may mean something else
// tomorrow.
const DEFAULT_PRODUCT_PATH = 'Product/AddProduct';
const upsertProduct = (store, product) =>
  zortRequest(store, 'POST', String(store.productPath || DEFAULT_PRODUCT_PATH), { body: product });

// ── The carrier label for a synced order ────────────────────────────────────
// Returns the raw PDF bytes, or null when the store has no label for that order
// yet (which is normal — the label only exists once the channel has generated
// it). Deliberately NOT zortRequest: that parses JSON, and this is a binary
// document.
//
// THE PATH IS CONFIGURABLE, and that is the point. The label endpoint is the
// one call in this client not confirmed against a live account — the sandbox
// this was written in cannot reach zortout.com. `store.labelPath` overrides it
// from the Connections screen with no redeploy, exactly as `store.endpoint`
// already overrides the base URL. `{id}` and `{tracking}` are substituted.
// If the first production call 404s, correct the path there; nothing else
// needs to change.
// CONFIRMED: GET Order/GetShipmentLabelFile?id=1234, with `number` accepted
// when the id is blank — which suits us, since we always hold the order number.
const DEFAULT_LABEL_PATH = 'Order/GetShipmentLabelFile?id={id}';
async function getShippingLabel(store, { id, number, tracking }) {
  const base = String(store.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const tpl  = String(store.labelPath || DEFAULT_LABEL_PATH);
  // The spec accepts `number` when the id is blank, so an order we only know by
  // number is still fetchable.
  const tplUsed = (!id && /\{id\}/.test(tpl) && number)
    ? tpl.replace(/id=\{id\}/, 'number={number}') : tpl;
  const path = tplUsed.replace(/\{id\}/g, encodeURIComponent(id || ''))
                      .replace(/\{number\}/g, encodeURIComponent(number || ''))
                      .replace(/\{tracking\}/g, encodeURIComponent(tracking || ''));
  const res = await fetch(`${base}/${path.replace(/^\/+/, '')}`, {
    method: 'GET', headers: authHeaders(store), signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) return null;               // no label for this order yet
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`Zort label fetch failed: HTTP ${res.status} ${String(t).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Some stores answer 200 with a JSON "not ready" body rather than a 404.
  // A label we cannot read is not a label — treat it as absent, not as a fault
  // to retry forever.
  if (buf.slice(0, 4).toString() !== '%PDF') return null;
  return buf;
}

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
  getShippingLabel,
  DEFAULT_LABEL_PATH,
  upsertProduct,
  DEFAULT_PRODUCT_PATH,
};
