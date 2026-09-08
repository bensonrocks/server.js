// ── OneCart API v2 client (DIRECT connection, one company = one client) ─────
//
// OneCart (getonecart.com) is a multi-channel OMS: a merchant links their
// Shopee / Lazada / TikTok / Shopify shops into ONE OneCart company, and this
// module is the window through which that company's orders reach IdealOne.
// It follows lib/shopify.js, not lib/zort.js, on purpose: one connected
// company belongs to ONE client, so there is no hub attribution to guess at
// and no refile tool needed — every order files under the store's client.
//
// Spec source: the OneCart API v2 Swagger document the user supplied
// (51 endpoints, base https://app.getonecart.com/api/v2). Read in full before
// a line of this was written — the ZORT lesson (`Order/PackOrder`, invented
// from an old Postman collection, answered 200 and did nothing).
//
// WHAT THE SPEC SAYS, and what this client leans on:
//   • Auth: `Authorization: <api key>` — a bare key, no "Bearer". A read-only
//     key gets 403 on any write.
//   • Envelope: success is `{data, meta, links, errors:[], warnings:[]}`;
//     failure is `{error:{code, message, details, request_id}}`. HTTP status
//     codes ARE status codes here (unlike ZORT's resCode-inside-a-200), and a
//     `request_id` rides on every failure for their support.
//   • Rate limit: 300 requests / 60s per key, with X-RateLimit-* headers and a
//     429 + Retry-After. Surfaced, never silently retried into.
//   • Pagination: `page` / `per_page` (max 100), `meta.has_next_page`.
//   • NO WEBHOOKS in v2 — the word does not appear in the spec. Pull only.
//   • `GET /delivery_orders` is a purpose-built picking queue: unshipped,
//     paid orders with customer, address and line items, bundle components
//     already expanded. It does NOT carry the tracking number — that lives on
//     `GET /orders` (`tracking_no`, null until shipped), so the pull reads both.
//   • `PUT /orders/{id}` `mark_as_shipped` fulfils on the channel, and the
//     spec warns fulfilment "runs in the background, so the returned status
//     may not reflect the change straight away". So a 200 is NOT a ship — the
//     caller reads the order back (the sync_rts_not_taking lesson).
//   • `POST /orders/print_awbs` generates shipping labels: "Lazada returns a
//     download URL, Shopee returns Base64-encoded PDF data, TikTok returns a
//     download URL per package". The inner shape of `print_jobs` is typed only
//     as `object` ("one entry per shop"), so the reader here walks it for
//     anything label-shaped rather than trusting a field name — the zortTracking
//     lesson applied before it is needed.
//
// HONEST CAVEAT: the sandbox cannot reach app.getonecart.com, so this is
// verified against a mock built to the spec; the first production Test + Pull
// is the live verification, exactly as ZORT and Shopify were. `ONECART_BASE` /
// `store.endpoint` override the host for that reason.

const DEFAULT_BASE = 'https://app.getonecart.com/api/v2';

class OnecartError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'OnecartError';
    Object.assign(this, extra);
  }
}

// The outbound URL is built from stored admin configuration, so it is
// constrained structurally rather than trusted (same rule as lib/shopify.js).
function _base(store) {
  if (process.env.ONECART_BASE) return process.env.ONECART_BASE.replace(/\/+$/, '');
  if (store && store.endpoint) {
    const u = new URL(String(store.endpoint));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new OnecartError('Store endpoint must be http(s)');
    if (u.username || u.password) throw new OnecartError('Store endpoint must not carry credentials');
    return u.toString().replace(/\/+$/, '');
  }
  return DEFAULT_BASE;
}

async function request(store, method, path, { query, body } = {}) {
  const url = new URL(_base(store) + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const headers = { Authorization: String(store.apiKey || ''), Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  const rate = {
    limit: Number(resp.headers.get('x-ratelimit-limit')) || null,
    remaining: resp.headers.get('x-ratelimit-remaining') === null ? null : Number(resp.headers.get('x-ratelimit-remaining')),
    reset: Number(resp.headers.get('x-ratelimit-reset')) || null,
  };
  const requestId = (json && json.error && json.error.request_id) || resp.headers.get('x-request-id') || '';
  if (resp.status === 429) {
    throw new OnecartError(`OneCart rate limit (300/min) — ${(json && json.error && json.error.message) || 'try again shortly'}`, {
      status: 429, code: 'RATE_LIMITED', retryAfter: Number(resp.headers.get('retry-after')) || 60, requestId, rate,
    });
  }
  if (!resp.ok) {
    const e = (json && json.error) || {};
    throw new OnecartError(`OneCart ${resp.status}${e.code ? ' ' + e.code : ''}: ${e.message || text.slice(0, 200) || resp.statusText}`, {
      status: resp.status, code: e.code || '', requestId, details: e.details || [], rate,
    });
  }
  if (json === null) throw new OnecartError(`OneCart answered ${resp.status} with a non-JSON body (${text.slice(0, 120)})`, { status: resp.status, rate });
  // Belt: an error object riding inside a 2xx is still an error.
  if (json.error && json.error.code) {
    throw new OnecartError(`OneCart ${json.error.code}: ${json.error.message || ''}`, { status: resp.status, code: json.error.code, requestId, rate });
  }
  return { json, rate, status: resp.status };
}

// ── Reads ───────────────────────────────────────────────────────────────────

// GET /zapier — "Confirms your API key is valid and returns the connected
// company name, the name of the key you authenticated with, and the email of
// the user who owns it."
async function testConnection(store) {
  const { json, rate } = await request(store, 'GET', '/zapier');
  const d = json.data && typeof json.data === 'object' ? json.data : json;
  const company = String(d.hi || d.company || d.company_name || '').trim();
  if (!company && !d.using) throw new OnecartError('OneCart answered but named no company — check the key');
  return { company, key: String(d.using || ''), createdBy: String(d.created_by || ''), rate };
}

// Page through a list endpoint until has_next_page is false or the cap.
async function listAll(store, path, query = {}, { maxPages = 20, perPage = 100 } = {}) {
  const rows = [];
  let pages = 0, rate = null, total = null, truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const r = await request(store, 'GET', path, { query: { ...query, page, per_page: perPage } });
    pages++; rate = r.rate;
    const data = Array.isArray(r.json.data) ? r.json.data : [];
    rows.push(...data);
    const meta = r.json.meta || {};
    if (typeof meta.total_items === 'number') total = meta.total_items;
    const more = meta.has_next_page === true || (r.json.links && r.json.links.next);
    if (!more || !data.length) break;
    if (page === maxPages) truncated = true;
  }
  return { rows, pages, rate, total, truncated };
}

// The picking queue: unshipped, paid, with lines and address.
function getDeliveryOrders(store, opts = {}) {
  return listAll(store, '/delivery_orders', {}, opts);
}

// Orders changed since a moment (Unix SECONDS per the spec) — used to fill
// tracking numbers on orders we already hold and to notice cancellations.
// `_fields` narrows the payload to what the sweep actually reads.
const ORDER_SWEEP_FIELDS = 'id,order_no,platform,status,tracking_no,shop_id,shop_name,shipping_provider_name,cancel_reason_text,updated_at,order_date';
function getOrdersUpdatedSince(store, sinceUnixSeconds, opts = {}) {
  return listAll(store, '/orders', { updated_start: Math.floor(sinceUnixSeconds), _fields: ORDER_SWEEP_FIELDS }, opts);
}

function getCancelledOrders(store, opts = {}) {
  return listAll(store, '/orders/cancelled', { _fields: 'id,order_no,platform,status,cancel_reason_text,updated_at' }, { maxPages: 3, ...opts });
}

async function getOrder(store, id, fields = 'id,order_no,platform,status,tracking_no,shop_name,shipping_provider_name') {
  const { json } = await request(store, 'GET', `/orders/${encodeURIComponent(id)}`, { query: { _fields: fields } });
  return json.data && typeof json.data === 'object' ? json.data : json;
}

// ── Writes ──────────────────────────────────────────────────────────────────

// PUT /orders/{id} mark_as_shipped — fulfils on the channel. Async on their
// side; the CALLER confirms by reading the order back.
async function markShipped(store, id) {
  const { json } = await request(store, 'PUT', `/orders/${encodeURIComponent(id)}`, { body: { mark_as_shipped: true } });
  return json.data && typeof json.data === 'object' ? json.data : json;
}

// POST /orders/print_awbs — generate shipping labels for a batch.
async function printAwbs(store, orderIds, { withSkuList = false, documentType } = {}) {
  const body = { order_ids: orderIds.map(n => Number(n)) };
  if (withSkuList) body.with_sku_list = true;
  if (documentType) body.document_type = documentType;
  const { json } = await request(store, 'POST', '/orders/print_awbs', { body });
  return json.data && typeof json.data === 'object' ? json.data : json;
}

// ── Status words ────────────────────────────────────────────────────────────
// The spec: "Common values include pending, ready_to_ship, shipped, completed,
// and cancelled; the exact values vary by sales channel." Matched loosely and
// the WORD SEEN is recorded by the caller, the same discipline as
// ZORT_MP_CANCEL_PAT.
const CANCEL_PAT = /cancel/i;
const SHIPPED_PAT = /ship(?!.*ready)|complet|deliver/i;   // "shipped", "completed", "delivered" — NOT "ready_to_ship"
function isCancelledStatus(s) { return CANCEL_PAT.test(String(s || '')); }
function isShippedStatus(s) {
  const w = String(s || '').toLowerCase();
  if (/ready/.test(w)) return false;
  return SHIPPED_PAT.test(w);
}

// ── Mapping ─────────────────────────────────────────────────────────────────

// One /delivery_orders row → flat line rows + the meta the intake needs.
// `sweep` is the matching /orders row (tracking, carrier), when the pull has it.
function mapDeliveryOrder(d, sweep = null) {
  const num = String(d.order_no || '').trim() || String(d.id || '');
  const name = [d.first_name, d.last_name].map(s => String(s || '').trim()).filter(Boolean).join(' ');
  const addr = [String(d.shipping_address || '').trim(), String(d.shipping_postal_code || '').trim()].filter(Boolean).join(' ');
  const tracking = String((sweep && sweep.tracking_no) || d.tracking_no || '').trim();
  const carrier  = String((sweep && sweep.shipping_provider_name) || d.shipping_provider_name || '').trim();
  const platform = String(d.platform || (sweep && sweep.platform) || '').trim();
  const shopName = String(d.shop_name || (sweep && sweep.shop_name) || '').trim();
  // The order's OWN date, as a calendar day — the same `date` attribute a
  // hand-uploaded order carries, which the portal's day table, the orders
  // export's Date column and the KPI's "received by 12:00" band all read.
  const placedRaw = d.order_date || (sweep && sweep.order_date) || '';
  const placed = placedRaw ? new Date(placedRaw) : null;
  const date = placed && !isNaN(placed.getTime()) ? placed.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }) : '';

  // BUNDLES: the queue arrives "with bundle components expanded". Components
  // carry `is_bundle_component: true` + `bundle_sku` naming the parent. If the
  // parent is ALSO listed as its own row, picking it would double-count the
  // pieces its components already are — so a row whose sku is named as some
  // component's `bundle_sku` is dropped in favour of its components.
  const items = Array.isArray(d.line_items) ? d.line_items : [];
  const parents = new Set(items.filter(li => li && li.is_bundle_component && li.bundle_sku).map(li => String(li.bundle_sku).trim()));
  const rows = [];
  for (const li of items) {
    if (!li) continue;
    const sku = String(li.sku || '').trim();
    if (!sku) continue;
    if (!li.is_bundle_component && parents.has(sku)) continue;     // the parent — its components are the pick
    rows.push({
      order_number: num,
      sku,
      description: String(li.name || '').trim(),
      qty: Math.floor(Number(li.quantity)) || 0,
      customer_name: name,
      delivery_address: addr,
      tel: String(d.shipping_phone_number || '').trim(),
      waybill_number: tracking,
      carrier,
      platform,
      shop_name: shopName,
      date,
      // Not carried by OneCart's Order entity — left honestly blank rather
      // than invented: issue_no (the GI is a WMS concept), pick_ticket,
      // po_number, batch_number, expiry_date, location.
      issue_no: '', pick_ticket: '', po_number: '',
      batch_number: '', expiry_date: '', location: '',
    });
  }
  return {
    order_number: num,
    rows,
    meta: {
      onecart_id: String(d.id || ''),
      platform, carrier, tracking, date,
      shop_id: d.shop_id != null ? String(d.shop_id) : '',
      shop_name: shopName,
      status: String(d.status || ''),
      placed_at: d.order_date || null,
    },
  };
}

// ── Label candidates out of print_jobs ──────────────────────────────────────
// `print_jobs` is typed as a bare object, "one entry per shop". Rather than
// bet on a field name that was never documented, walk the whole thing (depth-
// bounded) and pick out anything that could be a label: an http(s) URL, or a
// long base64 string. Each candidate carries the nearest order id / order no /
// tracking number seen on the way down, so a single label can be attached to
// THAT order rather than text-matched. A wrong candidate costs one fetch or
// one decode and identifies itself (the %PDF check is the caller's).
const ID_KEYS   = ['order_id', 'orderid', 'onecart_order_id', 'id'];
const NO_KEYS   = ['order_no', 'order_number', 'orderno'];
const TRK_KEYS  = ['tracking_no', 'tracking_number', 'trackingno', 'tracking'];
// Depth bound is generous on purpose: TikTok's per-package URL already sits at
// depth 7 (print_jobs → shop → labels[] → label → packages[] → package → url),
// and a bound of 6 silently lost it — caught by the e2e, not by reading.
function extractLabelCandidates(obj, ctx = {}, depth = 0, out = []) {
  if (obj === null || obj === undefined || depth > 12) return out;
  if (typeof obj === 'string') {
    const s = obj.trim();
    if (/^https?:\/\/\S+$/i.test(s)) out.push({ kind: 'url', value: s, ...ctx });
    else if (s.length >= 400 && /^[A-Za-z0-9+/=\s]+$/.test(s)) out.push({ kind: 'base64', value: s.replace(/\s+/g, ''), ...ctx });
    else if (/^data:application\/pdf;base64,/i.test(s)) out.push({ kind: 'base64', value: s.replace(/^data:[^,]*,/, ''), ...ctx });
    return out;
  }
  if (Array.isArray(obj)) { for (const v of obj) extractLabelCandidates(v, ctx, depth + 1, out); return out; }
  if (typeof obj === 'object') {
    const next = { ...ctx };
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (ID_KEYS.includes(lk) && (typeof v === 'number' || /^\d+$/.test(String(v)))) next.orderId = String(v);
      else if (NO_KEYS.includes(lk) && (typeof v === 'string' || typeof v === 'number')) next.orderNo = String(v);
      else if (TRK_KEYS.includes(lk) && typeof v === 'string') next.tracking = v.trim();
      else if (lk === 'platform' && typeof v === 'string') next.platform = v;
    }
    // A shop-keyed top level: the key itself is the shop name.
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && (ID_KEYS.includes(k.toLowerCase()) || NO_KEYS.includes(k.toLowerCase()) || TRK_KEYS.includes(k.toLowerCase()) || k.toLowerCase() === 'platform')) continue;
      extractLabelCandidates(v, depth === 0 ? { ...next, shop: k } : next, depth + 1, out);
    }
  }
  return out;
}

module.exports = {
  DEFAULT_BASE, OnecartError, request, testConnection, listAll,
  getDeliveryOrders, getOrdersUpdatedSince, getCancelledOrders, getOrder,
  markShipped, printAwbs,
  isCancelledStatus, isShippedStatus, mapDeliveryOrder, extractLabelCandidates,
  ORDER_SWEEP_FIELDS,
};
