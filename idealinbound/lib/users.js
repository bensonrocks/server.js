'use strict';

// Staff accounts for IdealInbound — independent of VaultSignals users.
// Roles: 'warehouse' (scan/receive only) or 'admin' (upload, delete requests,
// reports, staff management). The very first account created becomes admin
// so there's always someone who can promote others.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { pool, hasDb } = require('./db');

// ── JSON fallback (no IDEALINBOUND_DATABASE_URL) ───────────────────────
const FILE = path.join(__dirname, '../data/staff-users.json');

function jsonRead() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function jsonWrite(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
function safeRow(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}

const json = {
  findByEmail(email) {
    return jsonRead().find(u => u.email === email.toLowerCase().trim()) || null;
  },
  findById(id) {
    return jsonRead().find(u => u.id === id) || null;
  },
  create(data) {
    const list = jsonRead();
    const user = {
      id: crypto.randomUUID(),
      name: data.name,
      email: data.email.toLowerCase().trim(),
      passwordHash: data.passwordHash,
      role: list.length === 0 ? 'admin' : 'warehouse',
      createdAt: new Date().toISOString(),
    };
    list.push(user);
    jsonWrite(list);
    return user;
  },
  listAll() {
    return jsonRead().map(safeRow).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  },
  updateRole(id, role) {
    const list = jsonRead();
    const u = list.find(x => x.id === id);
    if (!u) return null;
    u.role = role;
    jsonWrite(list);
    return safeRow(u);
  },
};

// ── PostgreSQL backend ─────────────────────────────────────────────────
function rowToUser(r) {
  if (!r) return null;
  return {
    id:           r.id,
    name:         r.name,
    email:        r.email,
    passwordHash: r.password_hash,
    role:         r.role,
    createdAt:    r.created_at,
  };
}

const pg = {
  async findByEmail(email) {
    const { rows } = await pool.query(
      'SELECT * FROM staff_users WHERE email = $1', [email.toLowerCase().trim()]
    );
    return rowToUser(rows[0]) || null;
  },
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM staff_users WHERE id = $1', [id]);
    return rowToUser(rows[0]) || null;
  },
  async create(data) {
    const id = crypto.randomUUID();
    const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS n FROM staff_users');
    const role = countRows[0].n === 0 ? 'admin' : 'warehouse';
    const { rows } = await pool.query(
      `INSERT INTO staff_users (id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, data.name, data.email.toLowerCase().trim(), data.passwordHash, role]
    );
    return rowToUser(rows[0]);
  },
  async listAll() {
    const { rows } = await pool.query('SELECT * FROM staff_users ORDER BY created_at ASC');
    return rows.map(r => ({ id: r.id, name: r.name, email: r.email, role: r.role, createdAt: r.created_at }));
  },
  async updateRole(id, role) {
    const { rows } = await pool.query(
      'UPDATE staff_users SET role = $1 WHERE id = $2 RETURNING *', [role, id]
    );
    return rows[0] ? { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role, createdAt: rows[0].created_at } : null;
  },
};

module.exports = hasDb ? pg : json;
