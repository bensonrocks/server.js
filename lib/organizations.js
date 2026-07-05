'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { pool, hasDb } = require('./db');

// ── JSON fallback (no DATABASE_URL) ────────────────────────────────────
const FILE = path.join(__dirname, '../data/organizations.json');

function jsonRead() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function jsonWrite(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

const json = {
  create(name) {
    const list = jsonRead();
    const org = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
    list.push(org);
    jsonWrite(list);
    return org;
  },
  findById(id) {
    return jsonRead().find(o => o.id === id) || null;
  },
  update(id, patch) {
    const list = jsonRead();
    const i = list.findIndex(o => o.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch };
    jsonWrite(list);
    return list[i];
  },
};

// ── PostgreSQL backend ──────────────────────────────────────────────────
function rowToOrg(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, createdAt: r.created_at };
}

const pg = {
  async create(name) {
    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      'INSERT INTO organizations (id, name) VALUES ($1, $2) RETURNING *',
      [id, name]
    );
    return rowToOrg(rows[0]);
  },
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM organizations WHERE id = $1', [id]);
    return rowToOrg(rows[0]) || null;
  },
  async update(id, patch) {
    const keys = Object.keys(patch).filter(k => k === 'name');
    if (!keys.length) return null;
    const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE organizations SET ${setClauses} WHERE id = $1 RETURNING *`,
      [id, ...keys.map(k => patch[k])]
    );
    return rowToOrg(rows[0]) || null;
  },
};

module.exports = hasDb ? pg : json;
