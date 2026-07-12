'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Staff accounts + presence trail for the IdealOne.Hunter CRM.
// JSON file stores, same fallback pattern as lib/users.js.
const STAFF_FILE  = path.join(__dirname, '../../data/hunter-staff.json');
const EVENTS_FILE = path.join(__dirname, '../../data/hunter-activity.json');

// A heartbeat arrives every 60s while the page is open; a gap longer than
// this closes the presence session.
const GAP_MS = 5 * 60 * 1000;

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function write(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

// ── Accounts ───────────────────────────────────────────────────────────
function ensureSeed() {
  const list = read(STAFF_FILE);
  if (list.length) return;
  const email    = process.env.HUNTER_STAFF_EMAIL || 'admin@idealone.local';
  const password = process.env.HUNTER_STAFF_PASSWORD || 'hunter123';
  if (!process.env.HUNTER_STAFF_PASSWORD) {
    console.warn('WARNING: HUNTER_STAFF_PASSWORD not set — seeded CRM admin uses the default password. Set it in env vars.');
  }
  write(STAFF_FILE, [{
    id: crypto.randomUUID(),
    name: 'Admin',
    email: email.toLowerCase(),
    passwordHash: bcrypt.hashSync(password, 12),
    isAdmin: true,
    createdAt: new Date().toISOString(),
  }]);
}

function findById(id) {
  return read(STAFF_FILE).find(s => s.id === id) || null;
}

function verify(email, password) {
  const staff = read(STAFF_FILE).find(s => s.email === String(email || '').toLowerCase().trim());
  if (!staff || !bcrypt.compareSync(password || '', staff.passwordHash)) return null;
  return staff;
}

function create({ name, email, password, isAdmin }) {
  const list = read(STAFF_FILE);
  email = String(email || '').toLowerCase().trim();
  if (!name || !email || !password) return { error: 'name, email and password required' };
  if (password.length < 8) return { error: 'Password must be at least 8 characters' };
  if (list.some(s => s.email === email)) return { error: 'Email already registered' };
  const staff = {
    id: crypto.randomUUID(), name, email,
    passwordHash: bcrypt.hashSync(password, 12),
    isAdmin: !!isAdmin,
    createdAt: new Date().toISOString(),
  };
  list.push(staff);
  write(STAFF_FILE, list);
  return { staff };
}

function listSafe() {
  return read(STAFF_FILE).map(s => ({
    id: s.id, name: s.name, email: s.email, isAdmin: s.isAdmin, createdAt: s.createdAt,
  }));
}

function safe(s) {
  return s ? { id: s.id, name: s.name, email: s.email, isAdmin: s.isAdmin } : null;
}

// ── Presence trail ─────────────────────────────────────────────────────
// Events: login | heartbeat | leave | logout
function logEvent(staffId, event) {
  const list = read(EVENTS_FILE);
  list.push({ staffId, event, at: new Date().toISOString() });
  write(EVENTS_FILE, list);
}

// Fold the raw event stream into per-staff presence sessions:
// a session opens on login (or a heartbeat after a gap) and closes on
// logout/leave or when heartbeats stop for GAP_MS.
function sessions(limit = 50) {
  const events = read(EVENTS_FILE);
  const byStaff = {};
  for (const e of events) (byStaff[e.staffId] = byStaff[e.staffId] || []).push(e);

  const out = [];
  const now = Date.now();
  for (const [staffId, evs] of Object.entries(byStaff)) {
    evs.sort((a, b) => a.at.localeCompare(b.at));
    const who = findById(staffId);
    let cur = null;
    for (const e of evs) {
      const t = Date.parse(e.at);
      if (cur && (t - cur.lastMs > GAP_MS)) { out.push(finish(cur)); cur = null; }
      if (e.event === 'login' || !cur) {
        if (cur) out.push(finish(cur));
        cur = { staffId, name: who ? who.name : 'Unknown', startMs: t, lastMs: t, closed: false };
      }
      cur.lastMs = t;
      if (e.event === 'logout' || e.event === 'leave') {
        cur.closed = true;
        out.push(finish(cur));
        cur = null;
      }
    }
    if (cur) {
      cur.active = (now - cur.lastMs) <= GAP_MS;
      out.push(finish(cur));
    }
  }
  out.sort((a, b) => b.start.localeCompare(a.start));
  return out.slice(0, limit);

  function finish(c) {
    return {
      staffId: c.staffId,
      name: c.name,
      start: new Date(c.startMs).toISOString(),
      end: c.active ? null : new Date(c.lastMs).toISOString(),
      minutes: Math.max(1, Math.round((c.lastMs - c.startMs) / 60000)),
      active: !!c.active,
    };
  }
}

module.exports = { ensureSeed, findById, verify, create, listSafe, safe, logEvent, sessions };
