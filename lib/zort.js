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

async function zortRequest(store, method, apiPath, { query, body, headers } = {}) {
  const base = String(store.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const url  = new URL(`${base}/${apiPath}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: { ...authHeaders(store), ...(headers || {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
  // A 200 IS NOT A SUCCESS. ZORT reports business failures INSIDE the body
  // ("resCode" ≠ 200 — order not in a packable state, missing shipment
  // channel, already ready-to-ship, …) while the HTTP status stays 200.
  // Found live: an RTS that never happened was recorded as done — the outbox
  // entry was dropped, the order stamped "↗ Channel told", ZORT's status
  // unchanged and no label ever arrived, with nothing anywhere saying why.
  // Silence about a failed push is worse than the failure.
  const bodyErr = zortBodyError(data);
  if (bodyErr) {
    const err = new Error(`Zort ${apiPath} refused: ${bodyErr}`);
    err.zortBody = true;
    err.status = 200;
    throw err;
  }
  return data;
}

// The failure message inside an otherwise-200 response, or '' when the body
// carries no verdict (plain data responses — GetOrders and friends — say
// nothing, and silence there means success, which is the long-standing
// behaviour and must not change).
// A RESPONSE THAT CARRIES DATA HAS SUCCEEDED. ZORT attaches a routine notice
// to read endpoints — `resCode: 100, resDesc: "API Request Limits (50000
// requests/day)"` rides along with the orders on every GetOrders — so judging
// by the code alone declared every successful read a failure and stopped the
// pull dead. The verdict only decides when there is nothing else in the body,
// which is exactly the shape the action endpoints (Pack / ReadyToShip /
// UpdateOrderStatus) answer with.
const _DATA_KEYS = ['list', 'orders', 'order', 'detail', 'Detail', 'data', 'count', 'total', 'products', 'items'];
// Codes that are NOT failures: explicit successes, plus 100 — ZORT's quota
// notice, which is information about the plan, not a refusal.
const _OK_CODES = new Set(['200', '100', 'success', 'ok', 'true']);

function zortBodyError(data) {
  if (!data || typeof data !== 'object') return '';
  if (_DATA_KEYS.some(k => data[k] !== undefined && data[k] !== null)) return '';
  const envelopes = [data, data.res, data.Res, data.result, data.Result].filter(x => x && typeof x === 'object');
  for (const env of envelopes) {
    const code = env.resCode ?? env.rescode ?? env.ResCode ?? env.code ?? env.Code;
    const okFlag = env.success ?? env.isSuccess ?? env.IsSuccess ?? env.Success;
    const desc = String(env.resDesc ?? env.resdesc ?? env.ResDesc ?? env.message ?? env.Message ?? env.error ?? '').trim();
    if (okFlag === false) return desc || 'the hub reported failure';
    if (code === undefined || code === null || code === '') continue;
    if (_OK_CODES.has(String(code).trim().toLowerCase())) continue;
    return `${code}${desc ? ` — ${desc}` : ''}`;
  }
  return '';
}

// ── Endpoints used by IDEALONE ───────────────────────────────────────────────
const validateApi    = store => zortRequest(store, 'GET', 'Merchant/ValidateApi');
const getApiInfo     = store => zortRequest(store, 'GET', 'Merchant/GetApiInfo');
const getOrders      = (store, query) => zortRequest(store, 'GET', 'Order/GetOrders', { query });
// Targeted fetch of SPECIFIC orders — `numberlist` rides in a HEADER per the
// v4 collection (comma-separated order numbers). Used by the cross-check tool.
const getOrdersByNumbers = (store, numbers) =>
  zortRequest(store, 'GET', 'Order/GetOrders', {
    query: { limit: 100 },
    headers: { numberlist: (numbers || []).map(String).join(',') },
  });
// ── LOOK HARDER BEFORE BLAMING THE HUB ──────────────────────────────────────
// GetOrders' `numberlist` header is an EXACT match on ZORT's OWN order number.
// A number read off their screen is often the MARKETPLACE's order id, or sits in
// `reference` / `uniquenumber` / the tracking number instead — and a single
// exact-match miss was being reported as "the hub API does not return this
// order, it can never sync", which is a very final thing to say about a search
// we only tried one way.
//
// So: page the hub's own recent order list and match the needle against every
// identifier an order actually carries. Bounded by `days` and `maxPages` — this
// is a human pressing a button, not a sweep, and it says when it stopped early
// rather than implying it looked everywhere.
const MIN_PARTIAL = 6;   // below this a "contained" match is coincidence
async function findOrderAnywhere(store, needle, { days = 45, maxPages = 12 } = {}) {
  const want = String(needle || '').trim().toLowerCase();
  if (!want) return { found: null, scanned: 0, pages: 0, exhausted: true };
  const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString().slice(0, 10);
  const fields = o => [
    o.number, o.reference, o.uniquenumber, o.trackingno, o.tracking_no, o.trackingnumber,
    o.integrationCustomerId, o.id,
  ].map(v => String(v ?? '').trim().toLowerCase()).filter(Boolean);
  let scanned = 0, page = 1, exhausted = false;
  for (; page <= maxPages; page++) {
    let list = [];
    try {
      const d = await zortRequest(store, 'GET', 'Order/GetOrders',
        { query: { limit: 100, page, updatedafter: since } });
      list = d.list || d.orders || d.data || [];
    } catch (e) { break; }
    if (!list.length) { exhausted = true; break; }
    scanned += list.length;
    for (const o of list) {
      const f = fields(o);
      // EXACT FIRST. Then a contained match, but only in ONE direction and only
      // for a needle long enough to mean something.
      //
      // The other direction is a trap the test caught: `want.includes(v)` let
      // ZORT's numeric id "1" match the needle "169982235496068", pointing at a
      // completely unrelated order. In a warehouse that is the wrong order
      // picked, so a loose match here is worse than no match at all.
      if (f.includes(want)) {
        return { found: o, matchedOn: 'exact', scanned, pages: page, exhausted: false, days };
      }
      if (want.length >= MIN_PARTIAL && f.some(v => v.length >= MIN_PARTIAL && v.includes(want))) {
        return { found: o, matchedOn: 'partial', scanned, pages: page, exhausted: false, days };
      }
    }
    if (list.length < 100) { exhausted = true; break; }
  }
  return { found: null, scanned, pages: Math.min(page, maxPages), exhausted, days };
}

const getOrderDetail = (store, id)    => zortRequest(store, 'GET', 'Order/GetOrderDetail', { query: { id } });
const getSalesChannels = store => zortRequest(store, 'GET', 'Merchant/GetSalesChannels');

// Fulfillment push-back options (which one fires is a per-store setting):
const updateOrderStatus = (store, { id, status, actionDate }) =>
  zortRequest(store, 'POST', 'Order/UpdateOrderStatus', { query: { id, status, actionDate } });
// Per the v4 collection (2026-01-01): both take id OR number; `trackingno` is
// "not required if shipment by marketplace"; and for a marketplace order the
// spec says to SPECIFY the marketplace shipment channel — so callers should
// pass `shipment` whenever they know it (the drainer resolves it from
// GetOrderDetail). Empty/undefined params are stripped by zortRequest, so
// omitting any of these sends exactly what the old call sent.
// ── THERE IS NO Order/PackOrder ─────────────────────────────────────────────
// It is in the old Postman collection and NOT in the v4 API. Confirmed against
// developers.zortout.com/api-reference/order (read 2026-08-17 via the docs MCP):
// the Order page lists every POST it has — AddOrder, UpdateOrderStatus,
// UpdateOrderPayment, VerifySlip, UpdatePartialOrder, EditOrderInfo, EditOrder,
// VoidOrder, VoidOrderPayment, ReadyToShip, BookOrderShipment, … — and PackOrder
// appears nowhere on it.
//
// This is why fourteen consecutive "Asked the channel to PACK it" calls came
// back looking fine and the order never moved: the gateway answers 200 for a
// route it does not implement, so there was nothing to detect at the HTTP layer
// OR in the body.
//
// PACKED IS STATUS 5, SET THROUGH UpdateOrderStatus — that is the documented
// way, and the only one. Note what it does NOT do: UpdateOrderStatus is ZORT's
// own bookkeeping and never touches the marketplace. Only ReadyToShip says it
// "will try to update order in marketplace", and only ReadyToShip returns
// detail.trackingno + detail.link. So marking an order Packed makes the hub's
// status correct; it does not mint an AWB.
const ZORT_STATUS_PACKED = 5;
const packOrder = (store, { id, number, warehousecode }) =>
  zortRequest(store, 'POST', 'Order/UpdateOrderStatus',
    { query: { id, number, status: ZORT_STATUS_PACKED, warehousecode } });
const readyToShip = (store, { id, number, trackingno, shipment, warehousecode, address }) =>
  zortRequest(store, 'POST', 'Order/ReadyToShip', { query: { id, number, trackingno, shipment, warehousecode, address } });

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
// CONFIRMED body shape (v4 collection 2026-01-01): one URL PER EVENT, not a
// {url, events} pair — {key1..key3, addproducturl, updateproducturl,
// deleteproducturl, updatepriceurl, updatequantityurl, addorderurl,
// updateorderurl, updateordertrackingurl}. Pass the map straight through.
const registerWebhook = (store, urls) =>
  zortRequest(store, 'POST', 'Webhook/UpdateWebhook', { body: urls || {} });
const getWebhook = store => zortRequest(store, 'GET', 'Webhook/GetWebhook');

// Shipment status by tracking number (Shipment/GetShipmentTransactions) — the
// future source for "has the courier actually delivered it"; not yet wired.
// `trackingNoList` rides in a HEADER (like GetOrders' numberlist), not a query.
const getShipmentTransactions = (store, { trackingNoList, ...query } = {}) => {
  const base = String(store.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const url  = new URL(`${base}/Shipment/GetShipmentTransactions`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { ...authHeaders(store) };
  if (trackingNoList) headers.trackingNoList = String(trackingNoList);
  return fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(25000) })
    .then(async res => {
      const text = await res.text();
      let d; try { d = JSON.parse(text); } catch { d = { raw: text }; }
      if (!res.ok) { const e = new Error(`Zort GetShipmentTransactions failed: HTTP ${res.status}`); e.status = res.status; throw e; }
      return d;
    });
};

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
// UPDATE takes the store's OWN product id in the query and only the fields to
// change in the body — confirmed: POST Product/UpdateProduct?id=1234.
const updateProduct = (store, id, fields) =>
  zortRequest(store, 'POST', 'Product/UpdateProduct', { query: { id }, body: fields });

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

// ── THE SECOND WAY TO GET A LABEL ───────────────────────────────────────────
// GetShipmentLabelFile returns the raw file for ONE order and nothing else, so
// when it comes back empty there is no way to tell "no label exists" from "not
// this endpoint". Order/GetShipmentLabels answers properly: per order it gives
// `linkurl`, a `type` (lazada, shopee, flashexpress…), a `Format` (Pdf, Html,
// Url) and `Data` in that format. So a label can arrive three ways — a URL to
// fetch, base64 PDF bytes inline, or a URL in Data — and only if ALL of them
// are absent is the label genuinely not there yet.
// Confirmed against the v4 docs; the list ids ride in HEADERS like GetOrders'
// numberlist, not as query params.
async function getShipmentLabels(store, { orderIds, numbers } = {}) {
  const base = String(store.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const headers = { ...authHeaders(store) };
  if (orderIds && orderIds.length) headers.orderidlist = orderIds.map(String).join(',');
  if (numbers && numbers.length)   headers.numberlist  = numbers.map(String).join(',');
  const res = await fetch(`${base}/Order/GetShipmentLabels`, { method: 'GET', headers, signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`Zort GetShipmentLabels failed: HTTP ${res.status}`); e.status = res.status; throw e; }
  let d; try { d = JSON.parse(text); } catch { return []; }
  const list = d.list || d.labels || d.shipmentLabels || (Array.isArray(d) ? d : []);
  return Array.isArray(list) ? list : [];
}

// One label as PDF bytes, however this store happens to expose it. Returns
// null when nothing is available YET (the caller treats that as "come back
// later", never as a failure).
async function fetchLabelPdf(store, { id, number, tracking, labelUrl } = {}) {
  // 0. A label URL the hub HANDED US — the ReadyToShip/Pack response returns
  //    `detail.link` per the v4 docs. When we hold one, it outranks every
  //    guessed endpoint: it is the hub telling us where THIS order's label is.
  if (labelUrl && /^https?:\/\//i.test(String(labelUrl))) {
    try {
      const r0 = await fetch(String(labelUrl), { signal: AbortSignal.timeout(30000) });
      if (r0.ok) {
        const buf = Buffer.from(await r0.arrayBuffer());
        if (buf.slice(0, 4).toString() === '%PDF') return { pdf: buf, via: 'rts-link' };
      }
    } catch (e) { console.warn('[zort-label] rts link fetch:', e.message); }
  }
  // 1. The direct file endpoint — one call, and enough on a store that
  //    supports it. Unchanged behaviour for anyone it already works for.
  try {
    const direct = await getShippingLabel(store, { id, number, tracking });
    if (direct) return { pdf: direct, via: 'file' };
  } catch (e) {
    // A hard error here is worth remembering but must not stop us trying the
    // documented alternative — that is the whole point of having one.
    if (e.status && e.status !== 404) console.warn('[zort-label] file endpoint:', e.message);
  }
  // 2. The list endpoint, which says HOW this store serves labels.
  let rows = [];
  try {
    rows = await getShipmentLabels(store, { orderIds: id ? [id] : [], numbers: number ? [number] : [] });
  } catch (e) { console.warn('[zort-label] list endpoint:', e.message); return null; }
  for (const r of rows) {
    const fmt = String(r.Format || r.format || '').toLowerCase();
    const data = r.Data || r.data || '';
    // Inline PDF bytes, base64.
    if (fmt === 'pdf' && data) {
      try {
        const buf = Buffer.from(String(data), 'base64');
        if (buf.slice(0, 4).toString() === '%PDF') return { pdf: buf, via: 'list-data' };
      } catch (_) {}
    }
    // A URL, either in linkurl or as Data when Format says Url.
    const url = String(r.linkurl || r.linkUrl || (fmt === 'url' ? data : '') || '').trim();
    if (/^https?:\/\//i.test(url)) {
      try {
        const r2 = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (r2.ok) {
          const buf = Buffer.from(await r2.arrayBuffer());
          if (buf.slice(0, 4).toString() === '%PDF') return { pdf: buf, via: 'list-url' };
        }
      } catch (e) { console.warn('[zort-label] link fetch:', e.message); }
    }
  }
  return null;
}

module.exports = {
  DEFAULT_ENDPOINT,
  zortRequest,
  zortBodyError,
  validateApi,
  getApiInfo,
  getOrders,
  getOrdersByNumbers,
  findOrderAnywhere,
  getOrderDetail,
  getSalesChannels,
  updateOrderStatus,
  packOrder,
  readyToShip,
  getProducts,
  adjustInventory,
  registerWebhook,
  getWebhook,
  getShipmentTransactions,
  getShippingLabel,
  getShipmentLabels,
  fetchLabelPdf,
  DEFAULT_LABEL_PATH,
  upsertProduct,
  updateProduct,
  DEFAULT_PRODUCT_PATH,
};
