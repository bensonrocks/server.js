'use strict';

const crypto = require('crypto');

// ── Auth & API base URLs ──────────────────────────────────────────────────────

const AUTH_BASE = 'https://auth.lazada.com';
const API_BASE  = {
  MY: 'https://api.lazada.com.my', SG: 'https://api.lazada.sg',
  TH: 'https://api.lazada.co.th',  PH: 'https://api.lazada.com.ph',
  ID: 'https://api.lazada.co.id',  VN: 'https://api.lazada.vn',
};

// ── Signing ───────────────────────────────────────────────────────────────────

function sign(appSecret, apiPath, params) {
  const sorted = Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha256', appSecret).update(apiPath + sorted).digest('hex').toUpperCase();
}

// ── Status map ────────────────────────────────────────────────────────────────

const STATUS = {
  pending: 'pending', ready_to_ship: 'confirmed', shipped: 'shipped',
  delivered: 'delivered', canceled: 'cancelled',
};

// ── Connector interface ───────────────────────────────────────────────────────

const meta = {
  id:               'lazada',
  name:             'Lazada',
  type:             'ecommerce',
  authType:         'oauth',
  defaultStoreName: 'Lazada Store',
  regions:          ['MY', 'SG', 'TH', 'PH', 'ID', 'VN'],
  requiredForOAuth: ['appKey'],
};

function buildAuthUrl(creds, callbackUrl) {
  const p = new URLSearchParams({
    response_type: 'code', force_auth: 'true',
    redirect_uri: callbackUrl, client_id: creds.appKey,
  });
  return `${AUTH_BASE}/oauth/authorize?${p}`;
}

async function exchangeCode(creds, query) {
  const ts     = Date.now().toString();
  const params = { app_key: creds.appKey, timestamp: ts, sign_method: 'sha256', code: query.code };
  params.sign  = sign(creds.appSecret, '/auth/token/create', params);
  const res    = await fetch(`${AUTH_BASE}/rest/auth/token/create?${new URLSearchParams(params)}`, { method: 'POST' });
  const j      = await res.json();
  if (!j.access_token) throw new Error(j.message || 'Lazada token exchange failed');
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in };
}

async function fetchOrders(creds, opts = {}) {
  const { appKey, appSecret, accessToken, region = 'MY' } = creds;
  const base   = API_BASE[region] || API_BASE.MY;
  const ts     = Date.now().toString();
  const params = {
    app_key: appKey, timestamp: ts, sign_method: 'sha256', access_token: accessToken,
    created_after: opts.createdAfter || new Date(Date.now() - 7 * 86400000).toISOString(),
    status: opts.status || 'pending',
    limit:  String(opts.pageSize || 100),
    offset: String(opts.offset   || 0),
  };
  params.sign = sign(appSecret, '/orders/get', params);
  const res   = await fetch(`${base}/rest/orders/get?${new URLSearchParams(params)}`);
  const j     = await res.json();
  if (j.code !== '0') throw new Error(j.message || 'Lazada API error');
  return j.data?.orders || [];
}

function mapOrder(order, storeName) {
  const addr  = order.address_shipping || {};
  const items = (order.items || []).map(i => ({
    sku: i.sku || '', name: i.name || 'Item',
    qty: Number(i.item_count) || 1, unitPrice: Number(i.item_price) || 0,
  }));
  const clientId = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return {
    id:         `LAZ-${order.order_id}`,
    clientId, clientName: storeName, channel: 'lazada',
    orderDate:  order.created_at ? new Date(Number(order.created_at) * 1000).toISOString() : new Date().toISOString(),
    status:     STATUS[String(order.statuses?.[0]).toLowerCase()] || 'processing',
    currency:   'MYR', notes: order.remarks || '', items,
    shipping: {
      recipient:    [addr.first_name, addr.last_name].filter(Boolean).join(' '),
      addressLine1: addr.address   || '', addressLine2: addr.address2 || '',
      city:         addr.city      || '', state: addr.state || '',
      zip:          addr.post_code || '', country: addr.country || '',
    },
    subtotal: Number(order.price || 0), shippingCost: 0, tax: 0, total: Number(order.price || 0),
    source: { type: 'lazada', externalId: String(order.order_id), ingestedAt: new Date().toISOString() },
  };
}

module.exports = { meta, buildAuthUrl, exchangeCode, fetchOrders, mapOrder };
