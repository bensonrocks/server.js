// ── Shopify Admin API client (DIRECT connection, per client store) ──────────
//
// The standing model routes marketplaces via the ZORT hub; this module is the
// deliberate exception, per the user: a client's Shopify store connected
// STRAIGHT to IdealOne, for clients who are not on ZORT at all. The double-
// import rule still stands — a store connected here must NOT also be a ZORT
// sales channel, or the same orders arrive twice (said in the UI, enforced by
// order-number dedup as the belt).
//
// AUTH: a per-store CUSTOM APP made in the client's own Shopify admin
// (Settings → Apps → Develop apps). It hands over an Admin API access token
// (shpat_…) with the scopes we ask for — no OAuth dance, no app review, and
// the credentials live only in db.json like the ZORT secrets.
//
// API: Admin **GraphQL** only. Shopify declared the REST Admin API legacy —
// new apps must use GraphQL — so this is built on it from day one, version
// pinned below. Two lessons carried over from the ZORT client:
//   • A 200 IS NOT A SUCCESS — GraphQL errors ride in `errors[]` and business
//     refusals in each mutation's `userErrors[]`. Both are inspected; a
//     response carrying either THROWS with the platform's own words.
//   • The base URL is overridable (store.endpoint / SHOPIFY_BASE) because the
//     sandbox cannot reach *.myshopify.com — tests run against a mock, and the
//     first production pull is the live verification, exactly as ZORT was.

const crypto = require('crypto');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-07';

// The outbound URL is built from stored admin configuration, so it is
// CONSTRAINED STRUCTURALLY rather than trusted: the domain must be a bare
// hostname (no scheme, path, port, or userinfo — an "@" or "/" smuggled into
// the field cannot redirect the request), and the endpoint override must parse
// as a plain http(s) URL. Master-gated input is still input.
function _base(store) {
  if (process.env.SHOPIFY_BASE) return process.env.SHOPIFY_BASE.replace(/\/+$/, '');
  if (store.endpoint) {
    const u = new URL(String(store.endpoint));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Store endpoint must be http(s)');
    if (u.username || u.password) throw new Error('Store endpoint must not carry credentials');
    return u.toString().replace(/\/+$/, '');
  }
  const d = String(store.domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (!/^[a-z0-9][a-z0-9.-]{2,253}$/.test(d)) {
    throw new Error('Store domain is not a valid hostname (expected something.myshopify.com)');
  }
  return 'https://' + d;
}

async function shopifyGql(store, query, variables = {}) {
  const url = `${_base(store)}/admin/api/${API_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': String(store.accessToken || ''),
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await resp.text();
  let json = {};
  try { json = JSON.parse(text); } catch (_) {
    throw new Error(`Shopify answered ${resp.status} with a non-JSON body (${text.slice(0, 120)})`);
  }
  if (!resp.ok) {
    throw new Error(`Shopify HTTP ${resp.status}: ${JSON.stringify(json.errors || json).slice(0, 300)}`);
  }
  // Top-level errors (auth, throttle, bad query) — the platform's own words.
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error('Shopify: ' + json.errors.map(e => e.message || JSON.stringify(e)).join('; ').slice(0, 300));
  }
  return json.data || {};
}

// The user-facing test: can this token see this shop at all?
async function testConnection(store) {
  const d = await shopifyGql(store, `{ shop { name myshopifyDomain } }`);
  if (!d.shop) throw new Error('Shopify answered but returned no shop — check the token and its scopes');
  return { name: d.shop.name, domain: d.shop.myshopifyDomain };
}

const ORDERS_QUERY = `
query Orders($first: Int!, $after: String, $q: String) {
  orders(first: $first, after: $after, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      cancelledAt
      displayFulfillmentStatus
      phone
      customer { displayName }
      shippingAddress { name address1 address2 city zip country phone }
      lineItems(first: 100) { nodes { sku title quantity variant { barcode } } }
      fulfillments { trackingInfo { number company } }
    }
  }
}`;

// Recent orders, paged. `updatedAfter` is an ISO date — mirrors the ZORT
// pull's day-granular lookback; overlap is deduped by order number anyway.
async function getRecentOrders(store, { updatedAfter, maxPages = 10, pageSize = 50 } = {}) {
  const out = [];
  const q = updatedAfter ? `updated_at:>=${String(updatedAfter).slice(0, 10)}` : null;
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const d = await shopifyGql(store, ORDERS_QUERY, { first: pageSize, after, q });
    const conn = d.orders || {};
    for (const n of conn.nodes || []) out.push(n);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// One Shopify order node → flat line rows + the meta the intake needs.
// Order number: Shopify's `name` ("#1001") minus the "#" — that is what prints
// on their packing docs and what a barcode scan will carry.
function mapOrder(node) {
  const num = String(node.name || '').replace(/^#/, '').trim() || String(node.id || '').split('/').pop();
  const ship = node.shippingAddress || {};
  const addr = [ship.address1, ship.address2, ship.city, ship.zip, ship.country]
    .map(s => String(s || '').trim()).filter(Boolean).join(', ');
  const tracking = ((node.fulfillments || [])
    .flatMap(f => (f.trackingInfo || []).map(t => t.number))
    .find(n => String(n || '').trim())) || '';
  const rows = (node.lineItems?.nodes || []).map(li => ({
    order_number: num,
    sku: String(li.sku || '').trim(),
    description: String(li.title || '').trim(),
    qty: Number(li.quantity) || 0,
    barcode: String(li.variant?.barcode || '').trim(),
    customer_name: String(node.customer?.displayName || ship.name || '').trim(),
    delivery_address: addr,
    tel: String(ship.phone || node.phone || '').trim(),
    waybill_number: tracking,
  }));
  return {
    order_number: num,
    rows,
    meta: {
      shopify_id: String(node.id || ''),
      cancelled: !!node.cancelledAt,
      cancelled_at: node.cancelledAt || null,
      fulfilled: String(node.displayFulfillmentStatus || '').toUpperCase() === 'FULFILLED',
      tracking,
      placed_at: node.createdAt || null,
    },
  };
}

// ── Completion push-back: mark the order FULFILLED with our tracking ───────
// Two steps by API design: fulfillment orders first, then fulfillmentCreateV2
// naming them. userErrors is the verdict — a clean 200 carrying userErrors is
// a REFUSAL and throws with Shopify's own words (the PackOrder lesson).
async function getOpenFulfillmentOrders(store, orderId) {
  const d = await shopifyGql(store, `
    query FO($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 10) { nodes { id status } }
      }
    }`, { id: orderId });
  return (d.order?.fulfillmentOrders?.nodes || [])
    .filter(fo => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(String(fo.status || '').toUpperCase()));
}

async function createFulfillment(store, fulfillmentOrderIds, tracking = '', notify = true) {
  const fulfillment = {
    lineItemsByFulfillmentOrder: fulfillmentOrderIds.map(id => ({ fulfillmentOrderId: id })),
    notifyCustomer: !!notify,
  };
  if (String(tracking || '').trim()) fulfillment.trackingInfo = { number: String(tracking).trim() };
  const d = await shopifyGql(store, `
    mutation Fulfill($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`, { fulfillment });
  const r = d.fulfillmentCreate || {};
  if (Array.isArray(r.userErrors) && r.userErrors.length) {
    throw new Error('Shopify refused the fulfillment: ' + r.userErrors.map(e => e.message).join('; ').slice(0, 300));
  }
  if (!r.fulfillment) throw new Error('Shopify returned no fulfillment and no error — not recorded as done');
  return r.fulfillment;
}

// Webhook HMAC (phase 2 receiver; the helper ships now so the verify rule is
// settled): X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(raw body, api secret)).
function verifyWebhookHmac(secret, rawBody, headerValue) {
  if (!secret || !headerValue) return false;
  const digest = crypto.createHmac('sha256', String(secret)).update(rawBody).digest('base64');
  const a = Buffer.from(digest); const b = Buffer.from(String(headerValue));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  API_VERSION, shopifyGql, testConnection, getRecentOrders, mapOrder,
  getOpenFulfillmentOrders, createFulfillment, verifyWebhookHmac,
};
