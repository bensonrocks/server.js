'use strict';

const crypto = require('crypto');

const CLIENT_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours

const DEFAULT_CLIENT_USERS = [
  { id: 'betime-marketing', name: 'Betime Marketing', username: 'betime',    password: 'Betime@01' },
  { id: 'smilefam',         name: 'SmileFam',         username: 'smilefam',  password: 'SmileFam@01' },
  { id: 'athena-scents',    name: 'Athena Scents',    username: 'athena',    password: 'Athena@01' },
  { id: 'simplytoy',        name: 'SimplyToy',         username: 'simplytoy', password: 'SimplyToy@01' },
  { id: 'lz8',              name: 'LZ8',              username: 'lz8',       password: 'LZ8@01' },
  { id: 'almighty',         name: 'Almighty',         username: 'almighty',  password: 'Almighty@01' },
  { id: 'chalgo',           name: 'Chalgo',           username: 'chalgo',    password: 'Chalgo@01' },
];

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function createClientAuth(db) {
  const getUser = username =>
    db.prepare('SELECT * FROM client_users WHERE username = ? AND active = 1').get(username);

  const checkPassword = (username, password) => {
    const u = getUser(username);
    if (!u) return null;
    return sha256(password) === u.password_hash ? u : null;
  };

  const generateToken = (clientId, clientName, username) => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + CLIENT_TOKEN_TTL;
    db.prepare('INSERT INTO client_sessions (token, client_id, client_name, username, expires_at) VALUES (?, ?, ?, ?, ?)').run(token, clientId, clientName, username, expiresAt);
    db.prepare('DELETE FROM client_sessions WHERE expires_at < ?').run(Date.now());
    return token;
  };

  const validateToken = token => {
    if (!token) return null;
    const row = db.prepare('SELECT client_id, client_name, username, expires_at FROM client_sessions WHERE token = ?').get(token);
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      db.prepare('DELETE FROM client_sessions WHERE token = ?').run(token);
      return null;
    }
    return { clientId: row.client_id, clientName: row.client_name, username: row.username };
  };

  const revokeToken = token => {
    if (token) db.prepare('DELETE FROM client_sessions WHERE token = ?').run(token);
  };

  const listUsers = () =>
    db.prepare('SELECT id, name, username, active, logo_url, show_logo, created_at FROM client_users ORDER BY name').all();

  const createUser = (id, name, username, password) => {
    db.prepare('INSERT INTO client_users (id, name, username, password_hash) VALUES (?, ?, ?, ?)').run(id, name, username, sha256(password));
    return { id, name, username, active: 1, logoUrl: '', showLogo: false };
  };

  const setBranding = (id, { logoUrl, showLogo } = {}) => {
    const existing = db.prepare('SELECT * FROM client_users WHERE id = ?').get(id);
    if (!existing) throw new Error('Client user not found');
    db.prepare('UPDATE client_users SET logo_url = ?, show_logo = ? WHERE id = ?').run(
      logoUrl !== undefined ? logoUrl : existing.logo_url,
      showLogo !== undefined ? (showLogo ? 1 : 0) : existing.show_logo,
      id,
    );
  };

  const setPassword = (id, newPassword) => {
    const rows = db.prepare('UPDATE client_users SET password_hash = ? WHERE id = ?').run(sha256(newPassword), id);
    if (rows.changes === 0) throw new Error('Client user not found');
  };

  const setActive = (id, active) => {
    db.prepare('UPDATE client_users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    if (!active) db.prepare('DELETE FROM client_sessions WHERE client_id = ?').run(id);
  };

  const deleteUser = id => {
    db.prepare('DELETE FROM client_sessions WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM client_users WHERE id = ?').run(id);
  };

  return { checkPassword, generateToken, validateToken, revokeToken, listUsers, createUser, setPassword, setActive, setBranding, deleteUser };
}

function seedDefaultUsers(db) {
  const stmt = db.prepare('INSERT OR IGNORE INTO client_users (id, name, username, password_hash) VALUES (?, ?, ?, ?)');
  for (const u of DEFAULT_CLIENT_USERS) {
    stmt.run(u.id, u.name, u.username, sha256(u.password));
  }
}

module.exports = { createClientAuth, seedDefaultUsers, DEFAULT_CLIENT_USERS };
