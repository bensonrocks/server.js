'use strict';

// Human-readable cross-reference IDs for inbound jobs: IB-YYMMDD-NN.
// Independent per-day counter — never collides with or depends on anything else.

const fs   = require('fs');
const path = require('path');
const { pool, hasDb } = require('./db');

function todayKey() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

const FILE = path.join(__dirname, '../data/serial-counters.json');
function jsonRead() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function jsonWrite(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
}

async function initSerials() {
  if (!hasDb) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbound_serial_counters (
      day TEXT PRIMARY KEY,
      seq INTEGER NOT NULL DEFAULT 0
    )
  `);
}

async function nextInboundSerial() {
  const day = todayKey();
  let seq;
  if (hasDb) {
    const { rows } = await pool.query(
      `INSERT INTO inbound_serial_counters (day, seq) VALUES ($1, 1)
       ON CONFLICT (day) DO UPDATE SET seq = inbound_serial_counters.seq + 1
       RETURNING seq`,
      [day]
    );
    seq = rows[0].seq;
  } else {
    const counters = jsonRead();
    seq = (counters[day] || 0) + 1;
    counters[day] = seq;
    jsonWrite(counters);
  }
  return `IB-${day}-${String(seq).padStart(2, '0')}`;
}

module.exports = { initSerials, nextInboundSerial };
