'use strict';

const crypto = require('crypto');

// Regional API base URLs
const API_BASE = {
  MY: 'https://api.lazada.com.my',
  SG: 'https://api.lazada.sg',
  TH: 'https://api.lazada.co.th',
  PH: 'https://api.lazada.com.ph',
  ID: 'https://api.lazada.co.id',
  VN: 'https://api.lazada.vn',
};
const AUTH_BASE = 'https://auth.lazada.com';

// HMAC-SHA256 signing per Lazada Open Platform spec
function sign(appSecret, apiPath, params) {
  const sorted = Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha256', appSecret).update(apiPath + sorted).digest('hex').toUpperCase();
}

function buildAuthUrl(appKey, redirectUri) {
  const p = new URLSearchParams({ response_type: 'code', force_auth: 'true', redirect_uri: redirectUri, client_id: appKey });
  return `${AUTH_BASE}/oauth/authorize?${p}`;
}

async function exchangeCode(appKey, appSecret, code) {
  const ts  = Date.now().toString();
  const params = { app_key: appKey, timestamp: ts, sign_method: 'sha256', code };
  params.sign  = sign(appSecret, '/auth/token/create', params);
  const res = await fetch(`${AUTH_BASE}/rest/auth/token/create?${new URLSearchParams(params)}`, { method: 'POST' });
  const j   = await res.json();
  if (!j.access_token) throw new Error(j.message || 'Lazada token exchange failed');
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in };
}

async function getOrders(creds, options = {}) {
  const { appKey, appSecret, accessToken, region = 'MY' } = creds;
  const base   = API_BASE[region] || API_BASE.MY;
  const ts     = Date.now().toString();
  const params = {
    app_key: appKey, timestamp: ts, sign_method: 'sha256', access_token: accessToken,
    created_after: options.createdAfter || new Date(Date.now() - 7 * 86400000).toISOString(),
    status: options.status || 'pending',
    limit: String(options.pageSize || 100),
    offset: String(options.offset || 0),
  };
  params.sign = sign(appSecret, '/orders/get', params);
  const res = await fetch(`${base}/rest/orders/get?${new URLSearchParams(params)}`);
  const j   = await res.json();
  if (j.code !== '0') throw new Error(j.message || 'Lazada API error');
  return j.data?.orders || [];
}

module.exports = { buildAuthUrl, exchangeCode, getOrders };
