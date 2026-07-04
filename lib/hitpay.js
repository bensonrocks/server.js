'use strict';

const crypto = require('crypto');

const BASE = process.env.HITPAY_SANDBOX === 'true'
  ? 'https://api.sandbox.hit-pay.com/v1'
  : 'https://api.hit-pay.com/v1';

const API_KEY = process.env.HITPAY_API_KEY;
const SALT    = process.env.HITPAY_SALT;

async function createRecurringBilling({ userId, name, email, redirectUrl, webhookUrl }) {
  const body = new URLSearchParams({
    customer_email: email,
    customer_name:  name,
    redirect_url:   redirectUrl,
    webhook:        webhookUrl,
    reference:      userId,
    amount:         '3.99',
    currency:       'USD',
    cycle:          'monthly',
    name:           'VaultSignals Monthly',
  });

  const res = await fetch(`${BASE}/recurring-billing`, {
    method:  'POST',
    headers: {
      'X-BUSINESS-API-KEY': API_KEY,
      'X-Requested-With':   'XMLHttpRequest',
      'Content-Type':       'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HitPay error ${res.status}: ${text}`);
  }

  return res.json(); // { id, url, status }
}

// HitPay signs webhooks: HMAC-SHA256(salt, sorted param values concatenated)
function verifyWebhook(params, receivedHmac) {
  if (!SALT) return false;
  const data = { ...params };
  delete data.hmac;
  const message = Object.keys(data).sort().map(k => data[k]).join('');
  const expected = crypto.createHmac('sha256', SALT).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(receivedHmac, 'hex'));
  } catch {
    return false;
  }
}

async function cancelBilling(billingId) {
  const res = await fetch(`${BASE}/recurring-billing/${billingId}`, {
    method: 'DELETE',
    headers: {
      'X-BUSINESS-API-KEY': API_KEY,
      'X-Requested-With':   'XMLHttpRequest',
    },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`HitPay cancel error ${res.status}: ${text}`);
  }
  return true;
}

module.exports = {
  configured: !!API_KEY,
  createRecurringBilling,
  cancelBilling,
  verifyWebhook,
};
