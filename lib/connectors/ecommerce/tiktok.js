'use strict';

const crypto = require('crypto');

// ── API base ──────────────────────────────────────────────────────────────────

const API_BASE = 'https://open-api.tiktokglobalshop.com';
const AUTH_URL = 'https://services.tiktok-us.com/oauth/authorize';

// ── Signing — HMAC-SHA256 per TikTok Shop Open Platform spec ─────────────────

function sign(appSecret, params, body = '') {
  const exclude = new Set(['sign', 'access_token']);
  const paramStr = Object.keys(params)
    .filter(k => !exclude.has(k))
    .sort()
    .map(k => `${k}${params[k]}`)
    .join('');
  return crypto.createHmac('sha256', appSecret).update(appSecret + paramStr + body + appSecret).digest('hex');
}

// ── Status map ────────────────────────────────────────────────────────────────

const STATUS = {
  UNPAID: 'pending', ON_HOLD: 'pending', AWAITING_SHIPMENT: 'confirmed',
  PARTIALLY_SHIPPING: 'processing', AWAITING_COLLECTION: 'processing',
  IN_TRANSIT: 'shipped', DELIVERED: 'delivered', COMPLETED: 'delivered', CANCELLED: 'cancelled',
};

// ── Connector interface ───────────────────────────────────────────────────────

const meta = {
  id:               'tiktok',
  name:             'TikTok Shop',
  type:             'ecommerce',
  authType:         'oauth',
  defaultStoreName: 'TikTok Shop',
  requiredForOAuth: ['appKey'],
};

function buildAuthUrl(creds, callbackUrl) {
  const p = new URLSearchParams({ app_key: creds.appKey, state: 'idealoms', redirect_uri: callbackUrl });
  return `${AUTH_URL}?${p}`;
}

async function exchangeCode(creds, query) {
  const ts     = Math.floor(Date.now() / 1000);
  const params = { app_key: creds.appKey, auth_code: query.code, grant_type: 'authorized_code', timestamp: ts };
  params.sign  = sign(creds.appSecret, params);
  const res    = await fetch(`${API_BASE}/api/v2/token/get?${new URLSearchParams(params)}`);
  const j      = await res.json();
  if (j.code !== 0) throw new Error(j.message || 'TikTok token exchange failed');
  return {
    accessToken:  j.data?.access_token,
    refreshToken: j.data?.refresh_token,
    expiresIn:    j.data?.access_token_expire_in,
  };
}

async function fetchOrders(creds, opts = {}) {
  const { appKey, appSecret, accessToken } = creds;
  const ts     = Math.floor(Date.now() / 1000);
  const params = { app_key: appKey, timestamp: ts, version: '202309' };
  const body   = JSON.stringify({
    create_time_ge: Math.floor((Date.now() - 7 * 86400000) / 1000),
    create_time_lt: ts,
    page_size:      opts.pageSize || 50,
    status:         opts.status   || 'AWAITING_SHIPMENT',
  });
  params.sign = sign(appSecret, params, body);
  const res   = await fetch(`${API_BASE}/api/orders/202309/orders/search?${new URLSearchParams(params)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
    body,
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(j.message || 'TikTok API error');
  return j.data?.orders || [];
}

function mapOrder(order, storeName) {
  const addr    = order.recipient_address || {};
  const payment = order.payment           || {};
  const items   = (order.line_items || []).map(i => ({
    sku:       i.seller_sku   || '',
    name:      i.product_name || 'Item',
    qty:       Number(i.quantity)   || 1,
    unitPrice: Number(i.sale_price) || 0,
  }));
  const clientId = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return {
    id:         `TTK-${order.id}`,
    clientId, clientName: storeName, channel: 'tiktok',
    orderDate:  order.create_time ? new Date(Number(order.create_time) * 1000).toISOString() : new Date().toISOString(),
    status:     STATUS[order.status] || 'pending',
    currency:   order.currency || 'USD', notes: order.buyer_message || '', items,
    shipping: {
      recipient:    addr.name          || '',
      addressLine1: addr.address_line1 || '', addressLine2: addr.address_line2 || '',
      city:         addr.city          || '', state: addr.state || '',
      zip:          addr.zipcode       || '', country: addr.country_code || '',
    },
    subtotal:     Number(payment.subtotal     || 0),
    shippingCost: Number(payment.shipping_fee || 0),
    tax:          Number(payment.tax          || 0),
    total:        Number(payment.total_amount || 0),
    source: { type: 'tiktok', externalId: order.id, ingestedAt: new Date().toISOString() },
  };
}

module.exports = { meta, buildAuthUrl, exchangeCode, fetchOrders, mapOrder };
