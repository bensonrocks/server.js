'use strict';

const BASE_VER = '2024-01';

function buildAuthUrl(shopDomain, apiKey, redirectUri) {
  const shop = shopDomain.replace(/https?:\/\//, '').replace(/\/$/, '');
  const p = new URLSearchParams({ client_id: apiKey, scope: 'read_orders,read_customers', redirect_uri: redirectUri, state: 'idealoms' });
  return `https://${shop}/admin/oauth/authorize?${p}`;
}

async function exchangeCode(shopDomain, apiKey, apiSecret, code) {
  const shop = shopDomain.replace(/https?:\/\//, '').replace(/\/$/, '');
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(j.error_description || 'Shopify token exchange failed');
  return { accessToken: j.access_token };
}

async function getOrders(creds, options = {}) {
  const shop = (creds.shopDomain || '').replace(/https?:\/\//, '').replace(/\/$/, '');
  if (!shop) throw new Error('Shopify shop domain not configured');
  const params = new URLSearchParams({
    status: 'any',
    limit: options.pageSize || 50,
    created_at_min: new Date(Date.now() - 7 * 86400000).toISOString(),
  });
  const res = await fetch(`https://${shop}/admin/api/${BASE_VER}/orders.json?${params}`, {
    headers: { 'X-Shopify-Access-Token': creds.accessToken, 'Content-Type': 'application/json' },
  });
  const j = await res.json();
  if (j.errors) throw new Error(typeof j.errors === 'string' ? j.errors : JSON.stringify(j.errors));
  return j.orders || [];
}

async function getWaybill(creds, orderId) {
  const shop = (creds.shopDomain || '').replace(/https?:\/\//, '').replace(/\/$/, '');
  // Get fulfillment orders to find the label URL
  const res = await fetch(`https://${shop}/admin/api/${BASE_VER}/orders/${orderId}/fulfillment_orders.json`, {
    headers: { 'X-Shopify-Access-Token': creds.accessToken },
  });
  const j = await res.json();
  if (j.errors) throw new Error(typeof j.errors === 'string' ? j.errors : 'Shopify waybill fetch failed');
  // Return the packing slip URL as the printable document
  const fo = j.fulfillment_orders?.[0];
  if (!fo) throw new Error('No fulfillment order found for Shopify order ' + orderId);
  const labelUrl = `https://${shop}/admin/api/${BASE_VER}/fulfillment_orders/${fo.id}/fulfillments.json`;
  return { url: `https://${shop}/admin/orders/${orderId}/packing_slip.pdf`, fulfillmentOrderId: fo.id };
}

async function pushStatus(creds, externalId, status, trackingNo) {
  if (status !== 'shipped') return { ok: true, skipped: true };
  const shop = (creds.shopDomain || '').replace(/https?:\/\//, '').replace(/\/$/, '');
  const body = {
    fulfillment: {
      tracking_number: trackingNo || null,
      notify_customer: true,
    },
  };
  if (creds.locationId) body.fulfillment.location_id = creds.locationId;
  const res = await fetch(`https://${shop}/admin/api/${BASE_VER}/orders/${externalId}/fulfillments.json`, {
    method:  'POST',
    headers: { 'X-Shopify-Access-Token': creds.accessToken, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const j = await res.json();
  if (j.errors) throw new Error(typeof j.errors === 'string' ? j.errors : JSON.stringify(j.errors));
  return { ok: true };
}

module.exports = { buildAuthUrl, exchangeCode, getOrders, getWaybill, pushStatus };
