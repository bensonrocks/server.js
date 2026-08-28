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

// ── HOW MANY CALLS ARE WE MAKING? ───────────────────────────────────────────
// ZORT meters us at 50,000 requests/day and, when it stops answering, says so
// in a notice that carries no order — which is how a whole morning's parcels
// sat un-shipped. "Are we near the limit?" was unanswerable from anything we
// held, so it was a guess. It is counted here, at the ONE place every call goes
// through, per SGT day and per endpoint; the server reads and displays it.
// Counting only — it never blocks a call, because a meter that can refuse work
// is a second failure mode.
const callStats = { day: '', total: 0, byPath: Object.create(null) };
function _sgDay(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}
function countCall(apiPath) {
  const day = _sgDay();
  if (callStats.day !== day) { callStats.day = day; callStats.total = 0; callStats.byPath = Object.create(null); }
  callStats.total += 1;
  callStats.byPath[apiPath] = (callStats.byPath[apiPath] || 0) + 1;
}
function getCallStats() {
  if (callStats.day !== _sgDay()) return { day: _sgDay(), total: 0, byPath: {} };
  return { day: callStats.day, total: callStats.total, byPath: { ...callStats.byPath } };
}

async function zortRequest(store, method, apiPath, { query, body, headers } = {}) {
  countCall(apiPath);
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
  if (!want) return { found: null, scanned: 0, pages: 0, exhausted: true, shape: '' };
  const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString().slice(0, 10);
  const fields = o => [
    o.number, o.reference, o.uniquenumber, o.trackingno, o.tracking_no, o.trackingnumber,
    o.integrationCustomerId, o.id,
  ].map(v => String(v ?? '').trim().toLowerCase()).filter(Boolean);

  // MORE THAN ONE QUERY SHAPE, because one of them came back EMPTY on a store
  // that pulls orders every day. Reported live: the scan said "45 days, 0
  // order(s)" — it had not looked at anything, and an absence proved by a
  // search that returned nothing is not an absence at all.
  //
  // The daily pull uses a ~1-day `updatedafter` and works; a 45-day one
  // returned nothing, so the long window is the suspect. Try the plain paged
  // list first (no date filter), then the window, and REPORT which shape
  // actually produced rows.
  const shapes = [
    { name: 'recent orders (no date filter)', base: { limit: 100 } },
    { name: `updated in the last ${days} days`, base: { limit: 100, updatedafter: since } },
  ];
  let scanned = 0, lastError = '';
  for (const shape of shapes) {
    let sawAny = false;
    for (let page = 1; page <= maxPages; page++) {
      let list = [];
      try {
        const d = await zortRequest(store, 'GET', 'Order/GetOrders', { query: { ...shape.base, page } });
        list = d.list || d.orders || d.data || [];
      } catch (e) { lastError = e.message; break; }
      if (!list.length) break;
      sawAny = true; scanned += list.length;
      for (const o of list) {
        const f = fields(o);
        // EXACT FIRST. Then a contained match, but only in ONE direction and
        // only for a needle long enough to mean something.
        //
        // The other direction is a trap the test caught: `want.includes(v)` let
        // ZORT's numeric id "1" match the needle "169982235496068", pointing at
        // a completely unrelated order. In a warehouse that is the wrong order
        // picked, so a loose match here is worse than no match at all.
        if (f.includes(want)) {
          return { found: o, matchedOn: 'exact', scanned, exhausted: false, days, shape: shape.name };
        }
        if (want.length >= MIN_PARTIAL && f.some(v => v.length >= MIN_PARTIAL && v.includes(want))) {
          return { found: o, matchedOn: 'partial', scanned, exhausted: false, days, shape: shape.name };
        }
      }
      if (list.length < 100) break;
    }
    // A shape that returned rows and did not match is a real answer; one that
    // returned nothing tells us about the QUERY, not about the order.
    if (sawAny) return { found: null, scanned, exhausted: true, days, shape: shape.name, lastError };
  }
  // NOTHING came back from any shape. Say so as a failure to look, never as a
  // finding — "we searched and it is not there" would be a claim the search
  // cannot support.
  return { found: null, scanned: 0, exhausted: false, couldNotLook: true, days, shape: '', lastError };
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
// VOID — telling the hub we are not fulfilling an order. `Order/VoidOrder` IS
// on the v4 docs page (unlike PackOrder, which never was). Destructive and not
// reversible from our side, which is why the caller gates it behind a per-store
// switch that is off by default.
const voidOrder = (store, { id, number, remark }) =>
  zortRequest(store, 'POST', 'Order/VoidOrder', { query: { id, number, remark } });

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
  countCall('Shipment/GetShipmentTransactions');   // raw fetch — meter it like the label endpoints
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
  // COUNTED HERE TOO. This goes out through a raw fetch because it answers
  // with PDF bytes rather than JSON, so it bypassed the meter entirely — and
  // the label wait loop was the single biggest consumer we had.
  countCall('Order/GetShipmentLabelFile');
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
  return _asPdf(buf);
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
// WHERE THE ROWS LIVE IS NOT OURS TO ASSUME — the tracking-number lesson
// (six spellings, we read one) applied to labels. First ARRAY under any
// plausible container key wins, one level deep as well; `rows: null` means
// NO container was found at all, which is a different fact from an empty one
// and is reported with the key names seen instead of being mistaken for
// "not generated yet" and waited on for ever.
const _LABEL_ARRAY_KEYS = new Set(['list', 'labels', 'shipmentlabels', 'shipmentlabellist', 'data', 'result', 'rows', 'items', 'detail']);
function _labelRows(d) {
  if (Array.isArray(d)) return { rows: d, topKeys: [] };
  if (!d || typeof d !== 'object') return { rows: null, topKeys: [] };
  const topKeys = Object.keys(d);
  for (const k of topKeys) if (_LABEL_ARRAY_KEYS.has(k.toLowerCase()) && Array.isArray(d[k])) return { rows: d[k], topKeys };
  for (const k of topKeys) {
    const v = d[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k2 of Object.keys(v)) if (_LABEL_ARRAY_KEYS.has(k2.toLowerCase()) && Array.isArray(v[k2])) return { rows: v[k2], topKeys };
    }
  }
  return { rows: null, topKeys };
}
async function _getShipmentLabelsRaw(store, { orderIds, numbers } = {}) {
  const base = String(store.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const headers = { ...authHeaders(store) };
  if (orderIds && orderIds.length) headers.orderidlist = orderIds.map(String).join(',');
  if (numbers && numbers.length)   headers.numberlist  = numbers.map(String).join(',');
  countCall('Order/GetShipmentLabels');
  const res = await fetch(`${base}/Order/GetShipmentLabels`, { method: 'GET', headers, signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  if (!res.ok) { const e = new Error(`Zort GetShipmentLabels failed: HTTP ${res.status}`); e.status = res.status; throw e; }
  let d; try { d = JSON.parse(text); } catch { return { rows: null, topKeys: ['(not JSON)'] }; }
  return _labelRows(d);
}
async function getShipmentLabels(store, opts = {}) {
  const { rows } = await _getShipmentLabelsRaw(store, opts);
  return rows || [];
}
// A PDF identifies itself. Lenient about junk BEFORE the magic (a BOM or a
// stray newline ahead of %PDF is a real generator quirk, not a different
// file), never about its absence.
function _asPdf(buf) {
  if (!buf || buf.length < 8) return null;
  const idx = buf.slice(0, 1024).indexOf('%PDF');
  return idx < 0 ? null : (idx === 0 ? buf : buf.slice(idx));
}
function _sameHost(url, base) {
  try { return new URL(url).host === new URL(base).host; } catch { return false; }
}

// FILES ATTACHED TO AN ORDER — from the updated v4 collection (2026-01-01).
// The hub's own UI fetches a marketplace AWB via an async "Lazada Label" task
// (Marketplace → Print shipping label (PDF)), and the collection carries
// AddOrderShipmentLabelFile — so label files demonstrably live on the order's
// file list. Read-only.
async function getOrderFiles(store, id) {
  const base = String(store.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  countCall('Order/GetOrderFiles');
  const res = await fetch(`${base}/Order/GetOrderFiles?id=${encodeURIComponent(id)}`,
    { method: 'GET', headers: authHeaders(store), signal: AbortSignal.timeout(25000) });
  if (!res.ok) { const e = new Error(`Zort GetOrderFiles failed: HTTP ${res.status}`); e.status = res.status; throw e; }
  let d; try { d = JSON.parse(await res.text()); } catch { return []; }
  return _labelRows(d).rows || [];
}
// One file's content. The response shape is UNVERIFIED (no sample in the
// collection), so both possibilities are handled: raw PDF bytes, or JSON
// carrying the file some other way (a URL, base64) — the caller scans it.
async function getOrderFileDetail(store, id, fileid) {
  const base = String(store.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  countCall('Order/GetOrderFileDetail');
  const res = await fetch(`${base}/Order/GetOrderFileDetail?id=${encodeURIComponent(id)}&fileid=${encodeURIComponent(fileid)}`,
    { method: 'GET', headers: authHeaders(store), signal: AbortSignal.timeout(30000) });
  if (!res.ok) { const e = new Error(`Zort GetOrderFileDetail failed: HTTP ${res.status}`); e.status = res.status; throw e; }
  const buf = Buffer.from(await res.arrayBuffer());
  const pdf = _asPdf(buf);
  if (pdf) return { pdf };
  let j; try { j = JSON.parse(buf.toString('utf8')); } catch { return {}; }
  return { json: j };
}
// Shipment-transaction ROWS by tracking number — a thin rows-shaped wrapper
// over the existing getShipmentTransactions (which returns the raw body).
async function getShipmentTransactionRows(store, { trackingNos } = {}) {
  const d = await getShipmentTransactions(store, {
    trackingNoList: (trackingNos || []).map(String).join(','), limit: 100,
  });
  return _labelRows(d).rows || [];
}

// One label as PDF bytes, however this store happens to expose it. Returns
// null when nothing is available YET (the caller treats that as "come back
// later", never as a failure).
async function fetchLabelPdf(store, { id, number, tracking, labelUrl, skipFileEndpoint } = {}) {
  // 0. A label URL the hub HANDED US — the ReadyToShip/Pack response returns
  //    `detail.link` per the v4 docs. When we hold one, it outranks every
  //    guessed endpoint: it is the hub telling us where THIS order's label is.
  if (labelUrl && /^https?:\/\//i.test(String(labelUrl))) {
    try {
      const r0 = await fetch(String(labelUrl), { signal: AbortSignal.timeout(30000) });
      if (r0.ok) {
        const buf = _asPdf(Buffer.from(await r0.arrayBuffer()));
        if (buf) return { pdf: buf, via: 'rts-link' };
      }
    } catch (e) { console.warn('[zort-label] rts link fetch:', e.message); }
  }
  // ── 1. THE DOCUMENTED ENDPOINT FIRST ────────────────────────────────────
  // `Order/GetShipmentLabels` is the ONLY label endpoint on the v4 docs page.
  // `GetShipmentLabelFile` appears nowhere on it — the same trap as
  // `Order/PackOrder`, which also came from the old Postman collection and
  // turned out not to exist.
  //
  // This order used to be the other way round, and the hub's own activity log
  // showed what that cost: GetShipmentLabels succeeding while every
  // GetShipmentLabelFile beside it came back `resCode 100 "Invalid ID."` or a
  // 500 timeout. Every label attempt was two calls where one would do, and the
  // first was the one that could not work — on an account metered at 50,000
  // requests a day, with 369,278 of them in a fortnight.
  let rows = null, topKeys = [];
  const offered = [];          // what the hub actually handed us, for the report
  const tried = [];            // every URL we fetched, and what came back
  const probe = [];            // url-ish fields that were NOT fetchable URLs
  let listError = '';
  try {
    const raw = await _getShipmentLabelsRaw(store, { orderIds: id ? [id] : [], numbers: number ? [number] : [] });
    rows = raw.rows; topKeys = raw.topKeys || [];
  } catch (e) { listError = e.message; console.warn('[zort-label] list endpoint:', e.message); rows = null; }
  const storeBase = String(store.endpoint || DEFAULT_ENDPOINT);
  // THE ROW'S FIELD NAMES ARE NOT OURS TO ASSUME either — reported live as
  // "still not attaching even after RTS", with the switch on, the quota
  // healthy and the PDF demonstrably downloadable by hand. So: the
  // documented spellings first, then ANY long string tried as base64 PDF
  // bytes and ANY http(s) string tried as a label URL — a candidate that is
  // not a PDF costs one decode or one fetch and identifies itself either way.
  // The store's own credentials go ONLY to the store's own host — a signed
  // carrier URL must never receive them.
  const _rowToPdf = async (r, via) => {
    // THE ROW IS NOT FLAT. Proven live (28 Aug 2026): the channel answers
    // `type: lazada, format: url` with row keys `linkurl, type, list, data,
    // format` — and `list` is a NESTED ARRAY the old reader never looked
    // inside, because it only took top-level scalars. Every string anywhere in
    // the row is now a candidate, two levels deep.
    const lc = {};
    (function collect(o, prefix, depth) {
      if (!o || depth > 3) return;
      if (Array.isArray(o)) { o.forEach((v, i) => collect(v, `${prefix}[${i}]`, depth + 1)); return; }
      if (typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string' || typeof v === 'number') lc[key.toLowerCase()] = String(v);
        else collect(v, key, depth + 1);
      }
    })(r, '', 0);
    const fmt = String(lc.format ?? lc.formattype ?? '').toLowerCase();
    offered.push(`${String(lc.type || 'label')}/${fmt || 'no-format'}`);
    const entries = Object.entries(lc);
    const b64Cands = [...new Set([lc.data, lc.file, lc.filedata, lc.pdf, lc.pdfdata,
      ...entries.map(([, v]) => v).filter(s => s.length > 500 && !/^https?:/i.test(s))].filter(Boolean))];
    for (const cand of b64Cands) {
      try { const buf = _asPdf(Buffer.from(cand, 'base64')); if (buf) return { pdf: buf, via: `${via}-data` }; } catch (_) {}
    }
    // Keep the FIELD NAME with each candidate — "linkurl was empty" and "the
    // link answered 403" are different faults and the operator has to be able
    // to tell them apart without another round trip.
    const seen = new Set();
    const urlCands = [];
    for (const [k, v] of entries) {
      const val = String(v || '').trim();
      if (!/^https?:\/\//i.test(val) || seen.has(val)) continue;
      seen.add(val); urlCands.push({ field: k, url: val });
    }
    // WHAT EACH URL-ISH FIELD ACTUALLY HELD, whether or not it was fetchable —
    // an empty `linkurl` and a `linkurl` we could not fetch look identical
    // from the outside, and that ambiguity cost a day.
    for (const k of ['linkurl', 'link', 'url', 'fileurl', 'pdfurl', 'labelurl', 'data']) {
      if (lc[k] === undefined) continue;
      const val = String(lc[k]).trim();
      if (/^https?:\/\//i.test(val)) continue;             // already a candidate
      probe.push({ field: k, len: val.length, head: val.slice(0, 60) });
    }
    for (const { field, url } of urlCands) {
      const d = { field, host: (() => { try { return new URL(url).host; } catch { return '?'; } })() };
      try {
        const r2 = await fetch(url, {
          headers: _sameHost(url, storeBase) ? authHeaders(store) : undefined,
          redirect: 'follow',
          signal: AbortSignal.timeout(30000),
        });
        d.status = r2.status;
        d.type = String(r2.headers.get('content-type') || '').split(';')[0];
        if (r2.ok) {
          const raw = Buffer.from(await r2.arrayBuffer());
          d.bytes = raw.length;
          const buf = _asPdf(raw);
          if (buf) { tried.push(d); return { pdf: buf, via: `${via}-url` }; }
          d.head = raw.slice(0, 24).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
          // ── THE LINK IS A PRINT PAGE, NOT THE PDF ──────────────────────────
          // Proven live (28 Aug 2026): linkurl → secure.zortout.com answers
          // 200 text/html — the hub's own print-viewer page, with the real
          // PDF one hop further in (an iframe/script/meta-refresh reference).
          // So the page is scanned for label-ish URLs and each is tried, ONE
          // hop only — never HTML into HTML into HTML. The page's cookies go
          // with a same-host hop (a viewer that sets a session then redirects
          // is a normal shape); the API credentials still go nowhere but the
          // store's own API host.
          if (/html/i.test(d.type) && raw.length < 1024 * 1024) {
            const body = raw.slice(0, 200 * 1024).toString('utf8');
            const found = new Set();
            for (const m of body.matchAll(/https?:\/\/[^"'\s<>\\)]+/g)) found.add(m[0]);
            for (const m of body.matchAll(/(?:href|src|data-url|content)\s*=\s*["']([^"']+)["']/gi)) {
              try { found.add(new URL(m[1], r2.url || url).toString()); } catch (_) {}
            }
            const mr = body.match(/http-equiv=["']refresh["'][^>]*url=([^"'>\s]+)/i);
            if (mr) { try { found.add(new URL(mr[1], r2.url || url).toString()); } catch (_) {} }
            const hops = [...found]
              .filter(u2 => u2 !== url && !/\.(css|js|png|jpe?g|gif|svg|ico|woff2?|ttf)(\?|$)/i.test(u2))
              .filter(u2 => /\.pdf(\?|$)|pdf|label|awb|print|download|file/i.test(u2))
              .slice(0, 6);
            d.htmlLinks = hops.length;
            let cookie = '';
            try { cookie = (r2.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; '); } catch (_) {}
            // EVERY HOP REPORTS ITSELF. "2 links inside" with no outcome per
            // link was the last blind spot — proven live, 28 Aug 2026.
            d.hops = [];
            for (const hop of hops) {
              const h = { url: hop.length > 70 ? '…' + hop.slice(-67) : hop };
              try {
                const sameAsPage = (() => { try { return new URL(hop).host === new URL(r2.url || url).host; } catch { return false; } })();
                const r3 = await fetch(hop, {
                  headers: {
                    ...(sameAsPage && cookie ? { cookie } : {}),
                    ...(_sameHost(hop, storeBase) ? authHeaders(store) : {}),
                    referer: r2.url || url,
                  },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(30000),
                });
                h.status = r3.status;
                h.type = String(r3.headers.get('content-type') || '').split(';')[0];
                if (r3.ok) {
                  const raw3 = Buffer.from(await r3.arrayBuffer());
                  h.bytes = raw3.length;
                  const pdf3 = _asPdf(raw3);
                  if (pdf3) { d.hop = hop.slice(0, 120); d.hops.push(h); tried.push(d); return { pdf: pdf3, via: `${via}-url-html` }; }
                  h.head = raw3.slice(0, 24).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
                }
              } catch (e) { h.error = String(e.message || e).slice(0, 60); }
              d.hops.push(h);
            }
            // A page for a BROWSER is the honest dead end, said in words —
            // whether it announces a sign-in form or is a script shell whose
            // PDF only loads inside a logged-in browser session.
            if (!hops.length && /login|sign\s?-?in|password/i.test(body)) {
              d.hint = 'the link opens a sign-in page — it needs a browser session, not an API call';
            } else if (hops.length && d.hops.every(h => !/pdf/i.test(h.type || ''))) {
              d.hint = 'the print page is a browser app — its PDF loads only inside a signed-in browser. If printing this label from ZORT\u2019s own screen first makes the next Get Labels succeed, keep that one click and IdealOne does the rest.';
            }
          }
        }
      } catch (e) { d.error = String(e.message || e).slice(0, 80); }
      tried.push(d);
      console.warn('[zort-label] link:', JSON.stringify(d));
    }
    return null;
  };
  for (const r of (rows || [])) {
    const hit = await _rowToPdf(r, 'list');
    if (hit) return hit;
  }
  // ── 1b. THE ORDER'S OWN FILES ────────────────────────────────────────────
  // The hub's UI fetches a marketplace AWB via an async "Lazada Label" task
  // (Marketplace → Print shipping label (PDF)) — and the updated collection's
  // AddOrderShipmentLabelFile shows label files live on the order's FILE
  // LIST. Only files whose name/type says label/awb/waybill/shipping are
  // fetched: an order's files also hold invoices and payment slips, and with
  // for-order attachment a wrong one-page PDF would go on a box.
  let fileNames = [];
  if (id) {
    try {
      const files = await getOrderFiles(store, id);
      fileNames = files.map(f => String(f.filename || f.fileName || f.name || '')).filter(Boolean).slice(0, 20);
      const labelish = files.filter(f =>
        /label|awb|waybill|shipping|airway/i.test(`${f.filename || f.fileName || f.name || ''} ${f.type || f.filetype || f.fileType || ''}`));
      for (const f of labelish.slice(0, 5)) {
        const fid = f.fileid ?? f.fileId ?? f.id;
        if (fid === undefined || fid === null) continue;
        try {
          const got2 = await getOrderFileDetail(store, id, fid);
          if (got2.pdf) return { pdf: got2.pdf, via: 'order-file' };
          if (got2.json && typeof got2.json === 'object') {
            // The detail's shape is unverified — scan it like a row, two
            // levels deep, for anything that resolves to a PDF.
            const flat = {};
            (function dig(o, depth) {
              if (!o || depth > 2) return;
              for (const [k, v] of Object.entries(o)) {
                if (typeof v === 'string' || typeof v === 'number') flat[`${k}${depth}`] = v;
                else if (v && typeof v === 'object') dig(v, depth + 1);
              }
            })(got2.json, 0);
            const hit = await _rowToPdf(flat, 'order-file');
            if (hit) return hit;
          }
        } catch (e) { console.warn('[zort-label] file detail:', e.message); }
      }
    } catch (e) { console.warn('[zort-label] order files:', e.message); }
  }
  // ── 1c. SHIPMENT TRANSACTIONS by tracking number — a namespace the
  // integration never read before the updated collection surfaced it; its
  // rows go through the same wide scan and identify themselves or not.
  if (tracking) {
    try {
      const tx = await getShipmentTransactionRows(store, { trackingNos: [tracking] });
      for (const r of tx.slice(0, 5)) {
        const hit = await _rowToPdf(r, 'shipment-tx');
        if (hit) return hit;
      }
    } catch (e) { console.warn('[zort-label] shipment tx:', e.message); }
  }
  // ── 2. THE UNDOCUMENTED FILE ENDPOINT, LAST AND NOT FOR EVER ─────────────
  // Kept because it does work on some stores, and dropping it would break them
  // for no gain. But it is tried only when the documented route gave nothing,
  // and a store that has refused it three times is never asked again: it is
  // undocumented, so a store where it does not work is a store where it never
  // will, and asking anyway just spends the request limit that is already the
  // problem. `labelFileFails` lives on the store record, so a restart does not
  // relearn this by burning more calls.
  // WHETHER TO TRY IT AT ALL IS THE CALLER'S TO DECIDE, and so is remembering
  // the answer: this module makes HTTP calls, it does not own persistent app
  // state. It reports `fileTried` / `fileWorked` and the caller records them on
  // the store inside the same write that updates the outbox entry.
  let fileError = '', fileTried = false;
  if (!skipFileEndpoint) {
    fileTried = true;
    try {
      const direct = await getShippingLabel(store, { id, number, tracking });
      if (direct) return { pdf: direct, via: 'file', fileTried, fileWorked: true };
    } catch (e) {
      fileError = e.message || '';
      if (e.status && e.status !== 404) console.warn('[zort-label] file endpoint:', e.message);
    }
  }
  // ── WHY THERE IS NO LABEL, NOT JUST THAT THERE ISN'T ONE ─────────────────
  // Reported from the floor: "GetShipmentLabels succeeds but I don't get the
  // labels in IdealOne." A bare null made every reason identical, and the
  // caller reported all of them as "not generated yet" — so a hub that HANDED
  // US something we cannot use was waited on for ever, at the cost of a retry
  // every few minutes.
  //
  // An EMPTY list really is "come back later" and stays that. Rows we could not
  // turn into a PDF are a different fact: `Format: Html` is documented and we
  // have no way to render it server-side, and a link we could not fetch will
  // not fetch itself. Those are named so somebody can act instead of waiting.
  if (!rows || !rows.length) {
    // NO CONTAINER AT ALL is not "not generated yet" — it is a reply shaped in
    // a way we do not read, and waiting on it forever is exactly how a label
    // that EXISTS goes unattached for weeks. The key names (names only — a
    // value could be personal data) are the evidence to fix the reader with.
    const envelope = new Set(['res', 'rescode', 'resdesc', 'resdesc2', 'resdesc3', 'detail',
      'message', 'success', 'count', 'totalamount', 'totalpaymentamount', 'error']);
    const dataKeys = (topKeys || []).filter(k => !envelope.has(String(k).toLowerCase()));
    if (rows === null && dataKeys.length) {
      return { pdf: null, why: 'unshaped', keysSeen: topKeys.slice(0, 20), fileTried, fileWorked: false,
               detail: `the label reply carried keys this reader does not know: ${topKeys.slice(0, 12).join(', ')}` };
    }
    // The file names on the order are evidence: a label-ish file we could not
    // use, or the absence of any, both say where to look next.
    return { pdf: null, why: 'empty', fileTried, fileWorked: false, filesSeen: fileNames,
             detail: (listError || 'the channel has not generated it yet')
               + (fileNames.length ? ` (files on the order: ${fileNames.join(', ')})` : '') };
  }
  const rowKeys = [...new Set(rows.flatMap(r => Object.keys(r)))].slice(0, 15);
  return {
    pdf: null, why: 'unusable', offered, keysSeen: rowKeys, tried, probe, filesSeen: fileNames, fileTried, fileWorked: false,
    detail: `the channel offered ${offered.join(', ')} (row keys: ${rowKeys.join(', ')}) — nothing we can import as a PDF`
      + (fileError ? ` (the file endpoint said: ${fileError})` : ''),
  };
}

module.exports = {
  DEFAULT_ENDPOINT,
  zortRequest,
  getCallStats,
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
  voidOrder,
  getProducts,
  adjustInventory,
  registerWebhook,
  getWebhook,
  getShipmentTransactions,
  getShipmentTransactionRows,
  getShippingLabel,
  getShipmentLabels,
  getOrderFiles,
  getOrderFileDetail,
  fetchLabelPdf,
  DEFAULT_LABEL_PATH,
  upsertProduct,
  updateProduct,
  DEFAULT_PRODUCT_PATH,
};
