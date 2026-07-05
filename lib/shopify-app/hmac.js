'use strict';
const crypto = require('crypto');

// Verify OAuth callback HMAC (all query params except `hmac`, sorted, joined as key=value&...)
function verifyOAuthHmac(queryObj, clientSecret) {
  const { hmac, ...rest } = queryObj;
  if (!hmac) return false;
  const message  = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const expected = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// Verify webhook X-Shopify-Hmac-Sha256 header (base64 of HMAC-SHA256 of raw body)
function verifyWebhookHmac(rawBody, hmacHeader, clientSecret) {
  if (!hmacHeader) return false;
  const expected = crypto.createHmac('sha256', clientSecret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { verifyOAuthHmac, verifyWebhookHmac };
