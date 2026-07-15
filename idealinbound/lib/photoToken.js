'use strict';

// Short-lived signed tokens so `<img src="...?token=">` can load a photo
// without sending the session cookie — needed for print views and any
// context fetch() isn't driving.

const crypto = require('crypto');

const SECRET = process.env.IDEALINBOUND_SESSION_SECRET || 'dev-only-secret-set-IDEALINBOUND_SESSION_SECRET-in-prod';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function sign(userId) {
  const payload = `${userId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verify(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 3) return null;
    const [userId, ts, sig] = parts;
    const expected = crypto.createHmac('sha256', SECRET).update(`${userId}.${ts}`).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
    if (Date.now() - Number(ts) > TOKEN_TTL_MS) return null;
    return userId;
  } catch {
    return null;
  }
}

module.exports = { sign, verify };
