'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '../data/users.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return []; }
}

function write(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

module.exports = {
  findByEmail(email) {
    return read().find(u => u.email === email.toLowerCase().trim()) || null;
  },
  findById(id) {
    return read().find(u => u.id === id) || null;
  },
  findByStripeCustomer(customerId) {
    return read().find(u => u.stripeCustomerId === customerId) || null;
  },
  create(data) {
    const list = read();
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
    write(list);
    return user;
  },
  update(id, patch) {
    const list = read();
    const i = list.findIndex(u => u.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch };
    write(list);
    return list[i];
  },
};
