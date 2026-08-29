'use strict';

const { requestJson } = require('./http');

// OAuth2 client-credentials tokens, cached in memory until shortly before expiry.
const tokens = new Map(); // cacheKey → { value, expiresAt }

const SKEW_MS = 60 * 1000; // refresh a minute early rather than race the expiry

async function clientCredentialsToken({ cacheKey, tokenUrl, clientId, clientSecret, scope }) {
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + SKEW_MS) return cached.value;

  const body = { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret };
  if (scope) body.scope = scope;

  const json = await requestJson(tokenUrl, { method: 'POST', body, form: true });
  const value = json && (json.access_token || json.accessToken);
  if (!value) throw new Error('token endpoint returned no access_token');

  const ttlSeconds = parseInt(json.expires_in || json.expiresIn || 3600, 10);
  tokens.set(cacheKey, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  return value;
}

function clearTokens() {
  tokens.clear();
}

module.exports = { clientCredentialsToken, clearTokens };
