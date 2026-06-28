'use strict';

const crypto = require('crypto');

const BASE = 'https://partner.shopeemobile.com';

// HMAC-SHA256 signing per Shopee Open Platform v2 spec
function sign(partnerKey, partnerId, path, ts, accessToken = '', shopId = '') {
  const msg = `${partnerId}${path}${ts}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(msg).digest('hex');
}

function buildAuthUrl(partnerId, partnerKey, redirectUri) {
  const ts   = Math.floor(Date.now() / 1000);
  const path = '/api/v2/shop/auth_partner';
  const sig  = sign(partnerKey, partnerId, path, ts);
  const p    = new URLSearchParams({ partner_id: partnerId, timestamp: ts, sign: sig, redirect: redirectUri });
  return `${BASE}${path}?${p}`;
}

async function exchangeCode(partnerId, partnerKey, code, shopId) {
  const ts   = Math.floor(Date.now() / 1000);
  const path = '/api/v2/auth/token/get';
  const sig  = sign(partnerKey, partnerId, path, ts);
  const res  = await fetch(`${BASE}${path}?partner_id=${partnerId}&timestamp=${ts}&sign=${sig}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(partnerId) }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.message || 'Shopee token exchange failed');
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expire_in, shopId };
}

async function getOrders(creds, options = {}) {
  const { partnerId, partnerKey, accessToken, shopId } = creds;
  const ts   = Math.floor(Date.now() / 1000);
  const path = '/api/v2/order/get_order_list';
  const sig  = sign(partnerKey, partnerId, path, ts, accessToken, shopId);
  const p    = new URLSearchParams({
    partner_id: partnerId, timestamp: ts, sign: sig, access_token: accessToken, shop_id: shopId,
    time_range_field: 'create_time',
    time_from: Math.floor((Date.now() - 7 * 86400000) / 1000),
    time_to: ts,
    page_size: options.pageSize || 50,
    order_status: options.status || 'READY_TO_SHIP',
  });
  const res = await fetch(`${BASE}${path}?${p}`);
  const j   = await res.json();
  if (j.error) throw new Error(j.message || 'Shopee API error');
  return j.response?.order_list || [];
}

module.exports = { buildAuthUrl, exchangeCode, getOrders };
