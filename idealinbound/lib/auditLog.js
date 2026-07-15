'use strict';

// Every state-changing action gets an audit trail entry. Entries older than
// AUDIT_ARCHIVE_AFTER_DAYS are moved out of the live table/file so it never
// grows unbounded, while still being fully retained for compliance lookups.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { pool, hasDb } = require('./db');

const AUDIT_ARCHIVE_AFTER_DAYS = 180;

const FILE        = path.join(__dirname, '../data/audit-log.json');
const ARCHIVE_DIR = path.join(__dirname, '../data/archive');

function jsonRead() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function jsonWrite(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

async function initAuditLog() {
  if (!hasDb) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbound_audit_log (
      id          TEXT PRIMARY KEY,
      inbound_id  TEXT,
      type        TEXT NOT NULL,
      actor       TEXT,
      data        JSONB NOT NULL DEFAULT '{}'::jsonb,
      at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbound_audit_log_archive (
      LIKE inbound_audit_log INCLUDING ALL
    )
  `);
}

// data is spread BEFORE type/at so a stray data.type or data.at can never
// silently overwrite the real event metadata.
async function logAudit(type, { inboundId = null, actor = null, ...data } = {}) {
  const entry = { ...data, id: crypto.randomUUID(), inboundId, type, actor, at: new Date().toISOString() };
  if (hasDb) {
    await pool.query(
      `INSERT INTO inbound_audit_log (id, inbound_id, type, actor, data, at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.id, inboundId, type, actor, JSON.stringify(data), entry.at]
    );
  } else {
    const list = jsonRead();
    list.push(entry);
    jsonWrite(list);
  }
  return entry;
}

async function listAuditLog({ from, to, inboundId, limit = 500 } = {}) {
  if (hasDb) {
    const clauses = [];
    const params = [];
    if (from) { params.push(from); clauses.push(`at >= $${params.length}`); }
    if (to) { params.push(to); clauses.push(`at <= $${params.length}`); }
    if (inboundId) { params.push(inboundId); clauses.push(`inbound_id = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM inbound_audit_log ${where} ORDER BY at DESC LIMIT $${params.length}`,
      params
    );
    return rows.map(r => ({ id: r.id, inboundId: r.inbound_id, type: r.type, actor: r.actor, ...r.data, at: r.at }));
  }
  let list = jsonRead();
  if (from) list = list.filter(e => e.at >= from);
  if (to) list = list.filter(e => e.at <= to);
  if (inboundId) list = list.filter(e => e.inboundId === inboundId);
  return list.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}

// Housekeeping — safe to call repeatedly (e.g. once at server boot).
async function runAuditArchive() {
  const cutoff = new Date(Date.now() - AUDIT_ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  if (hasDb) {
    const { rows } = await pool.query('SELECT * FROM inbound_audit_log WHERE at < $1', [cutoff]);
    if (!rows.length) return { archived: 0 };
    await pool.query('INSERT INTO inbound_audit_log_archive SELECT * FROM inbound_audit_log WHERE at < $1', [cutoff]);
    await pool.query('DELETE FROM inbound_audit_log WHERE at < $1', [cutoff]);
    return { archived: rows.length };
  }
  const list = jsonRead();
  const keep = [];
  const byMonth = {};
  for (const entry of list) {
    if (entry.at < cutoff) {
      const month = entry.at.slice(0, 7);
      (byMonth[month] ||= []).push(entry);
    } else {
      keep.push(entry);
    }
  }
  const months = Object.keys(byMonth);
  if (!months.length) return { archived: 0 };
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  let archived = 0;
  for (const month of months) {
    const file = path.join(ARCHIVE_DIR, `audit-archive-${month}.json`);
    const existing = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } })();
    fs.writeFileSync(file, JSON.stringify(existing.concat(byMonth[month]), null, 2));
    archived += byMonth[month].length;
  }
  jsonWrite(keep);
  return { archived };
}

module.exports = { initAuditLog, logAudit, listAuditLog, runAuditArchive, AUDIT_ARCHIVE_AFTER_DAYS };
