'use strict';
const crypto = require('crypto');

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const attempt = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function newClientToken() {
  return crypto.randomBytes(16).toString('hex');
}

// In-memory session store: token -> { userId, username, name, role, createdAt }
const sessions = new Map();
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000; // 12h

function createSession(user) {
  const token = newToken();
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    at: Date.now(),
  });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_IDLE_MS) {
    sessions.delete(token);
    return null;
  }
  s.at = Date.now();
  return s;
}

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || (req.query && req.query.token);
  const session = token ? getSession(token) : null;
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getSession,
  requireAuth,
  requireAdmin,
  newClientToken,
};
