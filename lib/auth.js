'use strict';

const crypto = require('crypto');
const db     = require('./db');

const DEFAULT_PW = process.env.IDEAL_ADMIN_PASSWORD || 'Ideal@2024';
const TOKEN_TTL  = 8 * 60 * 60 * 1000; // 8 hours

function sha256(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function getPasswordHash() {
  const row = db.prepare("SELECT value FROM settings WHERE key='password_hash'").get();
  if (row) return row.value;
  const hash = sha256(DEFAULT_PW);
  db.prepare("INSERT INTO settings (key, value) VALUES ('password_hash', ?)").run(hash);
  return hash;
}

function checkPassword(plain) {
  return sha256(plain) === getPasswordHash();
}

function generateToken() {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL;
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return token;
}

function validateToken(token) {
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

function revokeToken(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function changePassword(newPlain) {
  const hash = sha256(newPlain);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('password_hash', ?)").run(hash);
  db.prepare('DELETE FROM sessions').run();
}

module.exports = { checkPassword, generateToken, validateToken, revokeToken, changePassword };
