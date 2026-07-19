'use strict';

const crypto = require('crypto');
const db     = require('./db');
const { sha256 } = require('./auth');

const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours

function checkPassword(username, password) {
  const v = db.prepare('SELECT * FROM nt_vendors WHERE username = ? AND active = 1').get(username);
  if (!v) return null;
  return sha256(password) === v.password_hash ? v : null;
}

function generateToken(vendor) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL;
  db.prepare('INSERT INTO nt_vendor_sessions (token, vendor_id, username, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, vendor.id, vendor.username, expiresAt);
  db.prepare('DELETE FROM nt_vendor_sessions WHERE expires_at < ?').run(Date.now());
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT vendor_id, username, expires_at FROM nt_vendor_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM nt_vendor_sessions WHERE token = ?').run(token);
    return null;
  }
  return { vendorId: row.vendor_id, username: row.username };
}

function revokeToken(token) {
  if (token) db.prepare('DELETE FROM nt_vendor_sessions WHERE token = ?').run(token);
}

module.exports = { checkPassword, generateToken, validateToken, revokeToken };
