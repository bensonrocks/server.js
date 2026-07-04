'use strict';

const crypto = require('crypto');
const { pool } = require('./db');

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

module.exports = {
  async findByEmail(email) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    return rowToUser(rows[0]) || null;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rowToUser(rows[0]) || null;
  },

  async findByStripeCustomer(customerId) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE stripe_customer_id = $1',
      [customerId]
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
    const values = keys.map(k => patch[k]);
    const { rows } = await pool.query(
      `UPDATE users SET ${setClauses} WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    return rowToUser(rows[0]) || null;
  },
};
