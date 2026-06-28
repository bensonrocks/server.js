'use strict';

const crypto = require('crypto');

const BASE     = 'https://open-api.tiktokglobalshop.com';
const AUTH_URL = 'https://services.tiktok-us.com/oauth/authorize';

// HMAC-SHA256 signing per TikTok Shop Open Platform spec
function sign(appSecret, params, body = '') {
  const exclude = new Set(['sign', 'access_token']);
  const paramStr = Object.keys(params)
    .filter(k => !exclude.has(k))
    .sort()
    .map(k => `${k}${params[k]}`)
    .join('');
  const input = appSecret + paramStr + body + appSecret;
  return crypto.createHmac('sha256', appSecret).update(input).digest('hex');
}

function buildAuthUrl(appKey, redirectUri) {
  const p = new URLSearchParams({ app_key: appKey, state: 'idealoms', redirect_uri: redirectUri });
  return `${AUTH_URL}?${p}`;
}

async function exchangeCode(appKey, appSecret, authCode) {
  const ts     = Math.floor(Date.now() / 1000);
  const params = { app_key: appKey, auth_code: authCode, grant_type: 'authorized_code', timestamp: ts };
  params.sign  = sign(appSecret, params);
  const res    = await fetch(`${BASE}/api/v2/token/get?${new URLSearchParams(params)}`);
  const j      = await res.json();
  if (j.code !== 0) throw new Error(j.message || 'TikTok token exchange failed');
  return {
    accessToken:  j.data?.access_token,
    refreshToken: j.data?.refresh_token,
    expiresIn:    j.data?.access_token_expire_in,
  };
}

async function getOrders(creds, options = {}) {
  const { appKey, appSecret, accessToken } = creds;
  const ts     = Math.floor(Date.now() / 1000);
  const params = { app_key: appKey, timestamp: ts, version: '202309' };
  const body   = JSON.stringify({
    create_time_ge:  Math.floor((Date.now() - 7 * 86400000) / 1000),
    create_time_lt:  ts,
    page_size:       options.pageSize || 50,
    status:          options.status   || 'AWAITING_SHIPMENT',
  });
  params.sign  = sign(appSecret, params, body);
  const res    = await fetch(`${BASE}/api/orders/202309/orders/search?${new URLSearchParams(params)}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
    body,
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(j.message || 'TikTok API error');
  return j.data?.orders || [];
}

async function getWaybill(creds, packageId) {
  const { appKey, appSecret, accessToken } = creds;
  const ts     = Math.floor(Date.now() / 1000);
  const params = { app_key: appKey, timestamp: ts, version: '202309' };
  const body   = JSON.stringify({ package_ids: [packageId] });
  params.sign  = sign(appSecret, params, body);
  const res = await fetch(`${BASE}/api/fulfillment/202309/packages/waybill?${new URLSearchParams(params)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
    body,
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(j.message || 'TikTok waybill fetch failed');
  const waybill = j.data?.waybill_list?.[0];
  return { url: waybill?.waybill_url || null };
}

async function pushStatus(creds, externalId, status, trackingNo) {
  if (status !== 'shipped') return { ok: true, skipped: true };
  const { appKey, appSecret, accessToken } = creds;
  const ts     = Math.floor(Date.now() / 1000);
  const params = { app_key: appKey, timestamp: ts, version: '202309' };
  const body   = JSON.stringify({ order_id: externalId, tracking_number: trackingNo || '' });
  params.sign  = sign(appSecret, params, body);
  const res = await fetch(`${BASE}/api/fulfillment/202309/packages/ship?${new URLSearchParams(params)}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken },
    body,
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(j.message || 'TikTok ship failed');
  return { ok: true };
}

module.exports = { buildAuthUrl, exchangeCode, getOrders, getWaybill, pushStatus };
