'use strict';

// Staff accounts for IdealInbound — independent of VaultSignals users.

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
      createdAt: new Date().toISOString(),
    };
    list.push(user);
    jsonWrite(list);
    return user;
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
    const { rows } = await pool.query(
      `INSERT INTO staff_users (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, data.name, data.email.toLowerCase().trim(), data.passwordHash]
    );
    return rowToUser(rows[0]);
  },
};

module.exports = hasDb ? pg : json;
