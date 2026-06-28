'use strict';

// ── API version ───────────────────────────────────────────────────────────────

const API_VER = '2024-01';

// ── Status map ────────────────────────────────────────────────────────────────

const STATUS = {
  paid: 'processing', authorized: 'confirmed', pending: 'pending',
  voided: 'cancelled', refunded: 'cancelled',
};

// ── Connector interface ───────────────────────────────────────────────────────

const meta = {
  id:               'shopify',
  name:             'Shopify',
  type:             'ecommerce',
  authType:         'oauth',
  defaultStoreName: 'Shopify Store',
  requiredForOAuth: ['shopDomain', 'apiKey'],
};

function shopHost(domain) {
  return domain.replace(/https?:\/\//, '').replace(/\/$/, '');
}

function buildAuthUrl(creds, callbackUrl) {
  const p = new URLSearchParams({
    client_id: creds.apiKey,
    scope: 'read_orders,read_customers',
    redirect_uri: callbackUrl,
    state: 'idealoms',
  });
  return `https://${shopHost(creds.shopDomain)}/admin/oauth/authorize?${p}`;
}

async function exchangeCode(creds, query) {
  const shop = shopHost(query.shop || creds.shopDomain);
  const res  = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: creds.apiKey, client_secret: creds.apiSecret, code: query.code }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(j.error_description || 'Shopify token exchange failed');
  return { accessToken: j.access_token };
}

async function fetchOrders(creds, opts = {}) {
  const shop   = shopHost(creds.shopDomain || '');
  if (!shop) throw new Error('Shopify shop domain not configured');
  const params = new URLSearchParams({
    status: 'any', limit: opts.pageSize || 50,
    created_at_min: new Date(Date.now() - 7 * 86400000).toISOString(),
  });
  const res = await fetch(`https://${shop}/admin/api/${API_VER}/orders.json?${params}`, {
    headers: { 'X-Shopify-Access-Token': creds.accessToken, 'Content-Type': 'application/json' },
  });
  const j = await res.json();
  if (j.errors) throw new Error(typeof j.errors === 'string' ? j.errors : JSON.stringify(j.errors));
  return j.orders || [];
}

function mapOrder(order, storeName) {
  const addr  = order.shipping_address || order.billing_address || {};
  const items = (order.line_items || []).map(i => ({
    sku:       i.sku       || '',
    name:      i.name      || 'Item',
    qty:       Number(i.quantity) || 1,
    unitPrice: Number(i.price)    || 0,
  }));
  let status = STATUS[order.financial_status] || 'pending';
  if (order.fulfillment_status === 'fulfilled') status = 'delivered';
  else if (order.fulfillment_status === 'partial') status = 'processing';
  const clientId = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return {
    id:         `SHP-${order.id}`,
    clientId, clientName: storeName, channel: 'shopify',
    orderDate:  order.created_at || new Date().toISOString(),
    status, currency: order.currency || 'USD', notes: order.note || '', items,
    shipping: {
      recipient:    addr.name || [addr.first_name, addr.last_name].filter(Boolean).join(' '),
      addressLine1: addr.address1 || '', addressLine2: addr.address2 || '',
      city:         addr.city     || '', state: addr.province_code || addr.province || '',
      zip:          addr.zip      || '', country: addr.country_code || addr.country || '',
    },
    subtotal:     Number(order.subtotal_price || 0),
    shippingCost: Number(order.total_shipping_price_set?.shop_money?.amount || 0),
    tax:          Number(order.total_tax || 0),
    total:        Number(order.total_price || 0),
    source: { type: 'shopify', externalId: String(order.id), ingestedAt: new Date().toISOString() },
  };
}

module.exports = { meta, buildAuthUrl, exchangeCode, fetchOrders, mapOrder };
