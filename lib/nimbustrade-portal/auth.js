'use strict';

const crypto = require('crypto');
const db     = require('./db');

const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function checkPassword(username, password) {
  const u = db.prepare('SELECT * FROM nt_users WHERE username = ? AND active = 1').get(username);
  if (!u) return null;
  return sha256(password) === u.password_hash ? u : null;
}

function generateToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL;
  db.prepare('INSERT INTO nt_sessions (token, user_id, client_id, username, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, user.id, user.client_id, user.username, expiresAt);
  db.prepare('DELETE FROM nt_sessions WHERE expires_at < ?').run(Date.now());
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT user_id, client_id, username, expires_at FROM nt_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM nt_sessions WHERE token = ?').run(token);
    return null;
  }
  return { userId: row.user_id, clientId: row.client_id, username: row.username };
}

function revokeToken(token) {
  if (token) db.prepare('DELETE FROM nt_sessions WHERE token = ?').run(token);
}

module.exports = { sha256, checkPassword, generateToken, validateToken, revokeToken };
