'use strict';

const crypto = require('crypto');

// ── API base ──────────────────────────────────────────────────────────────────

const BASE = 'https://partner.shopeemobile.com';

// ── Signing — HMAC-SHA256 per Shopee Open Platform v2 spec ───────────────────

function sign(partnerKey, partnerId, path, ts, accessToken = '', shopId = '') {
  const msg = `${partnerId}${path}${ts}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(msg).digest('hex');
}

// ── Status map ────────────────────────────────────────────────────────────────

const STATUS = {
  UNPAID: 'pending', READY_TO_SHIP: 'confirmed', PROCESSED: 'processing',
  SHIPPED: 'shipped', COMPLETED: 'delivered', CANCELLED: 'cancelled', IN_CANCEL: 'cancelled',
};

// ── Connector interface ───────────────────────────────────────────────────────

const meta = {
  id:               'shopee',
  name:             'Shopee',
  type:             'ecommerce',
  authType:         'oauth',
  defaultStoreName: 'Shopee Store',
  requiredForOAuth: ['partnerId'],
};

function buildAuthUrl(creds, callbackUrl) {
  const ts   = Math.floor(Date.now() / 1000);
  const path = '/api/v2/shop/auth_partner';
  const sig  = sign(creds.partnerKey, creds.partnerId, path, ts);
  const p    = new URLSearchParams({ partner_id: creds.partnerId, timestamp: ts, sign: sig, redirect: callbackUrl });
  return `${BASE}${path}?${p}`;
}

async function exchangeCode(creds, query) {
  const { partnerId, partnerKey } = creds;
  const { code, shop_id } = query;
  const ts   = Math.floor(Date.now() / 1000);
  const path = '/api/v2/auth/token/get';
  const sig  = sign(partnerKey, partnerId, path, ts);
  const res  = await fetch(`${BASE}${path}?partner_id=${partnerId}&timestamp=${ts}&sign=${sig}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, shop_id: Number(shop_id), partner_id: Number(partnerId) }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.message || 'Shopee token exchange failed');
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expire_in, shopId: shop_id };
}

async function fetchOrders(creds, opts = {}) {
  const { partnerId, partnerKey, accessToken, shopId } = creds;
  const ts   = Math.floor(Date.now() / 1000);
  const path = '/api/v2/order/get_order_list';
  const sig  = sign(partnerKey, partnerId, path, ts, accessToken, shopId);
  const p    = new URLSearchParams({
    partner_id: partnerId, timestamp: ts, sign: sig, access_token: accessToken, shop_id: shopId,
    time_range_field: 'create_time',
    time_from:  Math.floor((Date.now() - 7 * 86400000) / 1000),
    time_to:    ts,
    page_size:  opts.pageSize || 50,
    order_status: opts.status || 'READY_TO_SHIP',
  });
  const res = await fetch(`${BASE}${path}?${p}`);
  const j   = await res.json();
  if (j.error) throw new Error(j.message || 'Shopee API error');
  return j.response?.order_list || [];
}

function mapOrder(order, storeName) {
  const addr  = order.recipient_address || {};
  const items = (order.item_list || []).map(i => ({
    sku:       i.item_sku  || '',
    name:      i.item_name || 'Item',
    qty:       Number(i.model_quantity_purchased) || 1,
    unitPrice: Number(i.model_original_price)     || 0,
  }));
  const clientId = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return {
    id:         `SHOP-${order.order_sn}`,
    clientId, clientName: storeName, channel: 'shopee',
    orderDate:  order.create_time ? new Date(Number(order.create_time) * 1000).toISOString() : new Date().toISOString(),
    status:     STATUS[order.order_status] || 'pending',
    currency:   'MYR', notes: order.message_to_seller || '', items,
    shipping: {
      recipient:    addr.name         || '',
      addressLine1: addr.full_address || '', addressLine2: '',
      city:         addr.city         || '', state: addr.state   || '',
      zip:          addr.zipcode      || '', country: addr.region || '',
    },
    subtotal: Number(order.total_amount || 0), shippingCost: 0, tax: 0, total: Number(order.total_amount || 0),
    source: { type: 'shopee', externalId: order.order_sn, ingestedAt: new Date().toISOString() },
  };
}

module.exports = { meta, buildAuthUrl, exchangeCode, fetchOrders, mapOrder };
