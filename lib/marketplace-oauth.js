'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Marketplace seller OAuth — Lazada & Shopee.
//
//  The flow: the 3PL operator generates an authorization LINK for one client,
//  sends it to that client, the client logs into their own Lazada/Shopee
//  account and grants IdealOne access. The marketplace redirects back to our
//  callback with a short-lived `code`, which we exchange for an access +
//  refresh token stored against that client.
//
//  CLIENT ATTRIBUTION rides in `state` (Lazada passes it back; for Shopee we
//  bake it into the redirect URL), so the callback knows WHOSE tokens these are.
//
//  HONEST CAVEAT, same as the ZORT client: the token-exchange endpoints and
//  their signing are implemented to the published specs but the sandbox cannot
//  reach lazada.com / shopeemobile.com, so the exchange is UNVERIFIED against a
//  live account. Every function takes an `endpointBase` override (used by the
//  tests and available as an escape hatch to correct a base URL without a
//  redeploy). The auth-URL builders and the signing are unit-tested with known
//  inputs; the live swap must be confirmed on the first real authorization.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

// ── Lazada ──────────────────────────────────────────────────────────────────
const LAZADA_AUTH_BASE = 'https://auth.lazada.com';
const LAZADA_API_BASE  = 'https://auth.lazada.com/rest';

function lazadaAuthUrl({ appKey, redirectUri, state, authBase, forceAuth }) {
  const p = new URLSearchParams({
    response_type: 'code',
    redirect_uri: redirectUri,
    client_id: String(appKey || ''),
  });
  // force_auth=true makes Lazada demand a fresh password login even when the
  // seller already has a session — which breaks sandbox loaned test accounts
  // (they authenticate via the "Login" link, not a password you can type). Omit
  // it by default so an existing Seller Center session flows straight to the
  // consent screen; pass forceAuth:true explicitly if a re-login is ever wanted.
  if (forceAuth) p.set('force_auth', 'true');
  if (state) p.set('state', state);
  return `${(authBase || LAZADA_AUTH_BASE).replace(/\/+$/, '')}/oauth/authorize?${p.toString()}`;
}

// Lazada signature: apiPath + each sorted key immediately followed by its value,
// HMAC-SHA256 with the app secret, hex UPPERCASE. (System params: app_key,
// sign_method, timestamp, plus the API's own params — here `code`.)
function lazadaSign(apiPath, params, appSecret) {
  const base = apiPath + Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha256', appSecret).update(base).digest('hex').toUpperCase();
}

async function lazadaExchangeToken({ appKey, appSecret, code, endpointBase, now }) {
  const apiPath = '/auth/token/create';
  const params = {
    app_key: String(appKey || ''),
    code: String(code || ''),
    sign_method: 'sha256',
    timestamp: String(now || Date.now()),
  };
  params.sign = lazadaSign(apiPath, params, appSecret);
  const url = `${(endpointBase || LAZADA_API_BASE).replace(/\/+$/, '')}${apiPath}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  let d; try { d = JSON.parse(text); } catch { d = { raw: text }; }
  if (d && d.access_token) {
    return {
      ok: true,
      access_token: d.access_token,
      refresh_token: d.refresh_token || '',
      expires_in: Number(d.expires_in) || 0,
      refresh_expires_in: Number(d.refresh_expires_in) || 0,
      account: d.account || d.country_user_info?.[0]?.short_code || '',
      raw: d,
    };
  }
  return { ok: false, error: (d && (d.message || d.error_description || d.raw)) || `HTTP ${res.status}`, raw: d };
}

// Refresh a Lazada token pair. Lazada access tokens are SHORT (the app console
// shows 1 day, refresh 5 days), so a scheduler must call this well inside every
// 24h window or every client authorization silently dies. Same signing as the
// create call; returns the same shape (a refresh issues a NEW pair — store both).
async function lazadaRefreshToken({ appKey, appSecret, refreshToken, endpointBase, now }) {
  const apiPath = '/auth/token/refresh';
  const params = {
    app_key: String(appKey || ''),
    refresh_token: String(refreshToken || ''),
    sign_method: 'sha256',
    timestamp: String(now || Date.now()),
  };
  params.sign = lazadaSign(apiPath, params, appSecret);
  const url = `${(endpointBase || LAZADA_API_BASE).replace(/\/+$/, '')}${apiPath}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(25000) });
  const text = await res.text();
  let d; try { d = JSON.parse(text); } catch { d = { raw: text }; }
  if (d && d.access_token) {
    return {
      ok: true,
      access_token: d.access_token,
      refresh_token: d.refresh_token || '',
      expires_in: Number(d.expires_in) || 0,
      refresh_expires_in: Number(d.refresh_expires_in) || 0,
      account: d.account || '',
      raw: d,
    };
  }
  return { ok: false, error: (d && (d.message || d.error_description || d.raw)) || `HTTP ${res.status}`, raw: d };
}

// ── Shopee ──────────────────────────────────────────────────────────────────
const SHOPEE_BASE = 'https://partner.shopeemobile.com';

// Shopee signature for a public path: HMAC-SHA256(partner_id + path + timestamp,
// partner_key), hex lowercase.
function shopeeSign(partnerId, path, timestamp, partnerKey) {
  return crypto.createHmac('sha256', partnerKey)
    .update(`${partnerId}${path}${timestamp}`).digest('hex');
}

function shopeeAuthUrl({ partnerId, partnerKey, redirectUri, apiBase, now }) {
  const path = '/api/v2/shop/auth_partner';
  const ts = Math.floor((now || Date.now()) / 1000);
  const sign = shopeeSign(partnerId, path, ts, partnerKey);
  const p = new URLSearchParams({
    partner_id: String(partnerId || ''),
    timestamp: String(ts),
    sign,
    redirect: redirectUri,        // client attribution is a ?state= already on this URL
  });
  return `${(apiBase || SHOPEE_BASE).replace(/\/+$/, '')}${path}?${p.toString()}`;
}

async function shopeeExchangeToken({ partnerId, partnerKey, code, shopId, apiBase, now }) {
  const path = '/api/v2/auth/token/get';
  const ts = Math.floor((now || Date.now()) / 1000);
  const sign = shopeeSign(partnerId, path, ts, partnerKey);
  const url = `${(apiBase || SHOPEE_BASE).replace(/\/+$/, '')}${path}?${new URLSearchParams({
    partner_id: String(partnerId || ''), timestamp: String(ts), sign,
  })}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: String(code || ''), shop_id: Number(shopId) || undefined, partner_id: Number(partnerId) || undefined }),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let d; try { d = JSON.parse(text); } catch { d = { raw: text }; }
  if (d && d.access_token) {
    return {
      ok: true,
      access_token: d.access_token,
      refresh_token: d.refresh_token || '',
      expires_in: Number(d.expire_in) || 0,
      shop_id: shopId || d.shop_id || '',
      raw: d,
    };
  }
  return { ok: false, error: (d && (d.message || d.error || d.raw)) || `HTTP ${res.status}`, raw: d };
}

// Refresh a Shopee token pair — /api/v2/auth/access_token/get, public-path
// signature (partner_id + path + timestamp). Shopee also rotates the refresh
// token on every call, so both values must be stored back.
async function shopeeRefreshToken({ partnerId, partnerKey, refreshToken, shopId, apiBase, now }) {
  const path = '/api/v2/auth/access_token/get';
  const ts = Math.floor((now || Date.now()) / 1000);
  const sign = shopeeSign(partnerId, path, ts, partnerKey);
  const url = `${(apiBase || SHOPEE_BASE).replace(/\/+$/, '')}${path}?${new URLSearchParams({
    partner_id: String(partnerId || ''), timestamp: String(ts), sign,
  })}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: String(refreshToken || ''), partner_id: Number(partnerId) || undefined, shop_id: Number(shopId) || undefined }),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let d; try { d = JSON.parse(text); } catch { d = { raw: text }; }
  if (d && d.access_token) {
    return {
      ok: true,
      access_token: d.access_token,
      refresh_token: d.refresh_token || '',
      expires_in: Number(d.expire_in) || 0,
      shop_id: shopId || d.shop_id || '',
      raw: d,
    };
  }
  return { ok: false, error: (d && (d.message || d.error || d.raw)) || `HTTP ${res.status}`, raw: d };
}

module.exports = {
  lazadaAuthUrl, lazadaSign, lazadaExchangeToken, lazadaRefreshToken,
  shopeeAuthUrl, shopeeSign, shopeeExchangeToken, shopeeRefreshToken,
};
