'use strict';

const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const { pool, hasDb } = require('./db');

// ── JSON fallback (no DATABASE_URL) ───────────────────────────────────
const FILE = path.join(__dirname, '../data/users.json');

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
  findByStripeCustomer(customerId) {
    return jsonRead().find(u => u.stripeCustomerId === customerId) || null;
  },
  create(data) {
    const list = jsonRead();
    const user = {
      id: crypto.randomUUID(),
      name: data.name,
      email: data.email.toLowerCase().trim(),
      passwordHash: data.passwordHash,
      subscriptionStatus: data.subscriptionStatus || 'pending',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date().toISOString(),
    };
    list.push(user);
    jsonWrite(list);
    return user;
  },
  update(id, patch) {
    const list = jsonRead();
    const i = list.findIndex(u => u.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch };
    jsonWrite(list);
    return list[i];
  },
};

// ── PostgreSQL backend ─────────────────────────────────────────────────
function rowToUser(r) {
  if (!r) return null;
  return {
    id:                   r.id,
    name:                 r.name,
    email:                r.email,
    passwordHash:         r.password_hash,
    subscriptionStatus:   r.subscription_status,
    stripeCustomerId:     r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    createdAt:            r.created_at,
  };
}

const pg = {
  async findByEmail(email) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]
    );
    return rowToUser(rows[0]) || null;
  },
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rowToUser(rows[0]) || null;
  },
  async findByStripeCustomer(customerId) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE stripe_customer_id = $1', [customerId]
    );
    return rowToUser(rows[0]) || null;
  },
  async create(data) {
    const id = crypto.randomUUID();
    const status = data.subscriptionStatus || 'pending';
    const { rows } = await pool.query(
      `INSERT INTO users (id, name, email, password_hash, subscription_status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, data.name, data.email.toLowerCase().trim(), data.passwordHash, status]
    );
    return rowToUser(rows[0]);
  },
  async update(id, patch) {
    const map = {
      subscriptionStatus:   'subscription_status',
      stripeCustomerId:     'stripe_customer_id',
      stripeSubscriptionId: 'stripe_subscription_id',
    };
    const keys = Object.keys(patch).filter(k => map[k]);
    if (!keys.length) return null;
    const setClauses = keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE users SET ${setClauses} WHERE id = $1 RETURNING *`,
      [id, ...keys.map(k => patch[k])]
    );
    return rowToUser(rows[0]) || null;
  },
};

// Export whichever backend is available
module.exports = hasDb ? pg : json;
