'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.LIAGIRE_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const dbPath = path.join(DATA_DIR, 'liagire.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS job_code_seq (
  day TEXT PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  job_code TEXT UNIQUE NOT NULL,
  client_name TEXT NOT NULL,
  client_contact TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'quote_requested',
  client_token TEXT UNIQUE NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  quote_amount REAL,
  quote_currency TEXT DEFAULT 'SGD',
  quote_doc_path TEXT,
  quote_sent_at TEXT,
  quote_notes TEXT,

  accepted_at TEXT,
  accepted_by TEXT,
  acceptance_proof_path TEXT,
  acceptance_notes TEXT,

  collected_at TEXT,
  collected_by TEXT,
  pickup_location TEXT,
  collection_notes TEXT,

  carrier TEXT,
  tracking_number TEXT,
  shipped_at TEXT,
  tracking_notes TEXT,

  delivered_at TEXT,
  received_by TEXT,
  delivery_notes TEXT,

  invoice_number TEXT,
  invoice_amount REAL,
  invoice_currency TEXT DEFAULT 'SGD',
  invoice_due_at TEXT,
  invoice_sent_at TEXT,
  invoice_doc_path TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  paid_amount REAL NOT NULL DEFAULT 0,
  paid_at TEXT,

  cancelled INTEGER NOT NULL DEFAULT 0,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT
);

CREATE TABLE IF NOT EXISTS job_photos (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  stage TEXT NOT NULL,
  file_path TEXT NOT NULL,
  caption TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_photos_job ON job_photos(job_id);

CREATE TABLE IF NOT EXISTS job_payments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  amount REAL NOT NULL,
  note TEXT,
  proof_path TEXT,
  recorded_by TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_payments_job ON job_payments(job_id);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  type TEXT NOT NULL,
  note TEXT,
  actor TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);

CREATE TABLE IF NOT EXISTS vendor_costs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  vendor_name TEXT NOT NULL,
  description TEXT,
  invoice_number TEXT,
  invoice_amount REAL NOT NULL,
  currency TEXT DEFAULT 'SGD',
  invoice_doc_path TEXT,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'unpaid',
  paid_amount REAL NOT NULL DEFAULT 0,
  paid_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendor_costs_job ON vendor_costs(job_id);

CREATE TABLE IF NOT EXISTS vendor_cost_payments (
  id TEXT PRIMARY KEY,
  vendor_cost_id TEXT NOT NULL REFERENCES vendor_costs(id),
  amount REAL NOT NULL,
  note TEXT,
  proof_path TEXT,
  recorded_by TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vc_payments_vc ON vendor_cost_payments(vendor_cost_id);
`);

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

// SGT calendar day string, same discipline as the IDEALONE codebase: day-bucketing
// must never drift with the server's own host timezone.
function sgDateStr(d) {
  return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

function nextJobCode() {
  const day = sgDateStr().replace(/-/g, '').slice(2); // YYMMDD
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT seq FROM job_code_seq WHERE day = ?').get(day);
    const seq = (row ? row.seq : 0) + 1;
    db.prepare(
      'INSERT INTO job_code_seq (day, seq) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET seq = ?'
    ).run(day, seq, seq);
    return seq;
  });
  const seq = tx();
  return `LQ-${day}-${String(seq).padStart(2, '0')}`;
}

module.exports = { db, uuid, nowIso, sgDateStr, nextJobCode, DATA_DIR };
