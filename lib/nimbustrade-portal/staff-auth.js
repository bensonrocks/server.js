'use strict';

const crypto = require('crypto');
const db     = require('./db');
const { sha256 } = require('./auth');

const TOKEN_TTL = 8 * 60 * 60 * 1000; // 8 hours — shorter than client/vendor sessions

function checkPassword(username, password) {
  const s = db.prepare('SELECT * FROM nt_staff_users WHERE username = ? AND active = 1').get(username);
  if (!s) return null;
  return sha256(password) === s.password_hash ? s : null;
}

function generateToken(staff) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL;
  db.prepare('INSERT INTO nt_staff_sessions (token, staff_id, username, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, staff.id, staff.username, expiresAt);
  db.prepare('DELETE FROM nt_staff_sessions WHERE expires_at < ?').run(Date.now());
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT staff_id, username, expires_at FROM nt_staff_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM nt_staff_sessions WHERE token = ?').run(token);
    return null;
  }
  return { staffId: row.staff_id, username: row.username };
}

function revokeToken(token) {
  if (token) db.prepare('DELETE FROM nt_staff_sessions WHERE token = ?').run(token);
}

function seedDefaultStaff() {
  const exists = db.prepare('SELECT id FROM nt_staff_users LIMIT 1').get();
  if (exists) return;
  db.prepare('INSERT INTO nt_staff_users (id, name, username, password_hash) VALUES (?, ?, ?, ?)')
    .run('staff-admin', 'NimbusTrade Ops', 'ntstaff', sha256('NimbusStaff@2026'));
}

module.exports = { checkPassword, generateToken, validateToken, revokeToken, seedDefaultStaff };
