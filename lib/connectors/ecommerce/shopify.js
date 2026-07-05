'use strict';

const API_VER = '2025-01';

// financial_status → internal status
const STATUS = {
  paid: 'processing', authorized: 'confirmed', pending: 'pending',
  voided: 'cancelled', refunded: 'cancelled',
};

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

function headers(creds) {
  return { 'X-Shopify-Access-Token': creds.accessToken, 'Content-Type': 'application/json' };
}

async function shopifyGet(creds, path) {
  const shop = shopHost(creds.shopDomain || '');
  if (!shop) throw new Error('Shopify shop domain not configured');
  const res = await fetch(`https://${shop}/admin/api/${API_VER}${path}`, { headers: headers(creds) });
  const j = await res.json();
  if (j.errors) throw new Error(typeof j.errors === 'string' ? j.errors : JSON.stringify(j.errors));
  return j;
}

async function shopifyPost(creds, path, body) {
  const shop = shopHost(creds.shopDomain || '');
  if (!shop) throw new Error('Shopify shop domain not configured');
  const res = await fetch(`https://${shop}/admin/api/${API_VER}${path}`, {
    method: 'POST', headers: headers(creds), body: JSON.stringify(body),
  });
  const j = await res.json();
  if (j.errors) throw new Error(typeof j.errors === 'string' ? j.errors : JSON.stringify(j.errors));
  return j;
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

function buildAuthUrl(creds, callbackUrl) {
  const p = new URLSearchParams({
    client_id:    creds.apiKey,
    scope:        'read_orders,write_orders,read_customers,read_fulfillments,write_fulfillments',
    redirect_uri: callbackUrl,
    state:        'idealoms',
  });
  return `https://${shopHost(creds.shopDomain)}/admin/oauth/authorize?${p}`;
}

async function exchangeCode(creds, query) {
  const shop = shopHost(query.shop || creds.shopDomain);
  const res  = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ client_id: creds.apiKey, client_secret: creds.apiSecret, code: query.code }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(j.error_description || 'Shopify token exchange failed');
  return { accessToken: j.access_token };
}

// ── Fetch orders ──────────────────────────────────────────────────────────────

async function fetchOrders(creds, opts = {}) {
  const since = opts.since
    ? new Date(opts.since).toISOString()
    : new Date(Date.now() - 7 * 86400000).toISOString();
  const params = new URLSearchParams({ status: 'any', limit: opts.pageSize || 50, created_at_min: since });
  const j = await shopifyGet(creds, `/orders.json?${params}`);
  return j.orders || [];
}

// ── Map Shopify order → internal schema ───────────────────────────────────────

function mapOrder(order, storeName) {
  const addr  = order.shipping_address || order.billing_address || {};
  const items = (order.line_items || []).map(i => ({
    sku:       i.sku   || '',
    name:      i.name  || 'Item',
    qty:       Number(i.quantity) || 1,
    unitPrice: Number(i.price)    || 0,
  }));

  let status = STATUS[order.financial_status] || 'pending';
  if (order.fulfillment_status === 'fulfilled') status = 'delivered';
  else if (order.fulfillment_status === 'partial') status = 'processing';

  const clientId = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const recipient = addr.name || [addr.first_name, addr.last_name].filter(Boolean).join(' ');

  return {
    id:         `SHP-${order.id}`,
    clientId,
    clientName: storeName,
    channel:    'shopify',
    orderDate:  order.created_at || new Date().toISOString(),
    status,
    currency:   order.currency || 'USD',
    notes:      order.note || '',
    items,
    shipping: {
      recipient,
      name:         recipient,
      addressLine1: addr.address1      || '',
      addressLine2: addr.address2      || '',
      city:         addr.city          || '',
      state:        addr.province_code || addr.province || '',
      zip:          addr.zip           || '',
      country:      addr.country_code  || addr.country || '',
      phone:        addr.phone         || '',
    },
    subtotal:     Number(order.subtotal_price || 0),
    shippingCost: Number(order.total_shipping_price_set?.shop_money?.amount || 0),
    tax:          Number(order.total_tax   || 0),
    total:        Number(order.total_price || 0),
    source: {
      type:         'shopify',
      externalId:   String(order.id),
      orderName:    order.name || '',
      shippingName: recipient,
      ingestedAt:   new Date().toISOString(),
    },
  };
}

// ── Fetch waybill (tracking URL from existing Shopify fulfillment) ─────────────

async function fetchWaybill(creds, externalId) {
  const j = await shopifyGet(creds, `/orders/${externalId}/fulfillments.json`);
  const fulfillment = (j.fulfillments || []).find(f => f.status === 'success') || (j.fulfillments || [])[0];
  if (!fulfillment) throw new Error('No fulfillments found on this Shopify order yet');
  return {
    url:            fulfillment.tracking_url    || null,
    trackingNumber: fulfillment.tracking_number || null,
    carrier:        fulfillment.tracking_company|| null,
  };
}

// ── Push fulfillment to Shopify (Fulfillment Orders API, 2022-07+) ────────────

async function pushStatus(creds, externalId, status) {
  if (status !== 'shipped') return { skipped: true };

  // Step 1: get open fulfillment orders for this order
  const foRes = await shopifyGet(creds, `/orders/${externalId}/fulfillment_orders.json`);
  const openFO = (foRes.fulfillment_orders || []).filter(fo => fo.status === 'open');
  if (!openFO.length) return { skipped: true, reason: 'no open fulfillment orders' };

  // Step 2: create fulfillment referencing all open fulfillment orders
  const body = {
    fulfillment: {
      message:            'Shipped via IdealOne OMS',
      notify_customer:    true,
      line_items_by_fulfillment_order: openFO.map(fo => ({
        fulfillment_order_id: fo.id,
      })),
    },
  };
  await shopifyPost(creds, '/fulfillments.json', body);
  return { ok: true };
}

module.exports = { meta, buildAuthUrl, exchangeCode, fetchOrders, mapOrder, fetchWaybill, pushStatus };
