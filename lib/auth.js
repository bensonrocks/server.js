'use strict';

const crypto  = require('crypto');
const mainDb  = require('./db/main');

const DEFAULT_PW = process.env.IDEAL_ADMIN_PASSWORD || 'Ideal@2024';
const TOKEN_TTL  = 8 * 60 * 60 * 1000; // 8 hours

function sha256(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function getPasswordHash(tenantDb) {
  const row = tenantDb.prepare("SELECT value FROM settings WHERE key='password_hash'").get();
  if (row) return row.value;
  const hash = sha256(DEFAULT_PW);
  tenantDb.prepare("INSERT INTO settings (key, value) VALUES ('password_hash', ?)").run(hash);
  return hash;
}

function checkPassword(tenantDb, plain) {
  return sha256(plain) === getPasswordHash(tenantDb);
}

function generateToken(tenantId) {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL;
  mainDb.prepare('INSERT INTO sessions (token, tenant_id, expires_at) VALUES (?, ?, ?)').run(token, tenantId, expiresAt);
  mainDb.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return token;
}

// Returns { tenantId } or null
function validateToken(token) {
  if (!token) return null;
  const row = mainDb.prepare('SELECT tenant_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    mainDb.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { tenantId: row.tenant_id };
}

function revokeToken(token) {
  if (token) mainDb.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function changePassword(tenantDb, newPlain) {
  const hash = sha256(newPlain);
  tenantDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('password_hash', ?)").run(hash);
}

function revokeAllTenantSessions(tenantId) {
  mainDb.prepare('DELETE FROM sessions WHERE tenant_id = ?').run(tenantId);
}

module.exports = { checkPassword, generateToken, validateToken, revokeToken, changePassword, revokeAllTenantSessions };
