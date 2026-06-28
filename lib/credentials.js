'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'credentials.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}

function persist(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const getAll = () => load();
const get    = p => load()[p] || null;

const set = (p, fields) => {
  const all = load();
  all[p] = { ...all[p], ...fields, updatedAt: new Date().toISOString() };
  persist(all);
  return all[p];
};

const remove = p => {
  const all = load();
  delete all[p];
  persist(all);
};

module.exports = { getAll, get, set, remove };
