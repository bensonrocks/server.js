'use strict';

const crypto = require('crypto');
const mainDb = require('./db/main');

const STAFF_TOKEN_TTL = 8 * 60 * 60 * 1000; // 8 hours

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function checkPassword(username, password) {
  const u = mainDb.prepare('SELECT * FROM staff_users WHERE username = ? AND active = 1').get(username);
  if (!u) return null;
  return sha256(password) === u.password_hash ? u : null;
}

function generateToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + STAFF_TOKEN_TTL;
  mainDb.prepare('INSERT INTO staff_sessions (token, username, expires_at) VALUES (?, ?, ?)').run(token, username, expiresAt);
  mainDb.prepare('DELETE FROM staff_sessions WHERE expires_at < ?').run(Date.now());
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const row = mainDb.prepare(
    `SELECT s.username, s.expires_at, u.role
     FROM staff_sessions s JOIN staff_users u ON u.username = s.username
     WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    mainDb.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token);
    return null;
  }
  return { username: row.username, role: row.role || 'warehouse' };
}

function revokeToken(token) {
  if (token) mainDb.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token);
}

function changePassword(username, newPassword) {
  mainDb.prepare('UPDATE staff_users SET password_hash = ? WHERE username = ?').run(sha256(newPassword), username);
}

function listStaff() {
  return mainDb.prepare('SELECT username, role, active, created_at FROM staff_users ORDER BY username').all();
}

function createUser(username, password, role) {
  mainDb.prepare("INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)").run(username, sha256(password), role || 'warehouse');
}

function setRole(username, role) {
  mainDb.prepare("UPDATE staff_users SET role = ? WHERE username = ?").run(role, username);
}

function setActive(username, active) {
  mainDb.prepare("UPDATE staff_users SET active = ? WHERE username = ?").run(active ? 1 : 0, username);
}

module.exports = { checkPassword, generateToken, validateToken, revokeToken, changePassword, listStaff, createUser, setRole, setActive };
