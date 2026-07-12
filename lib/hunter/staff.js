'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db     = require('./db');

// Staff accounts (org-scoped) + presence trail for the Hunter CRM.
const COL_STAFF  = 'staff';
const COL_EVENTS = 'events';

// A heartbeat arrives every 60s while the page is open; a gap longer than
// this closes the presence session.
const GAP_MS = 5 * 60 * 1000;

// ── Accounts ───────────────────────────────────────────────────────────
async function ensureSeed(ownerOrgId) {
  const list = await db.list(COL_STAFF);
  if (list.length) return;
  const email    = process.env.HUNTER_STAFF_EMAIL || 'admin@idealone.local';
  const password = process.env.HUNTER_STAFF_PASSWORD || 'hunter123';
  if (!process.env.HUNTER_STAFF_PASSWORD) {
    console.warn('WARNING: HUNTER_STAFF_PASSWORD not set — seeded CRM owner uses the default password. Set it in env vars.');
  }
  const id = crypto.randomUUID();
  await db.put(COL_STAFF, id, {
    id, org_id: ownerOrgId,
    name: 'Owner',
    email: email.toLowerCase(),
    passwordHash: bcrypt.hashSync(password, 12),
    isAdmin: true,
    createdAt: new Date().toISOString(),
  });
}

async function findById(id) {
  return id ? db.get(COL_STAFF, id) : null;
}

async function verify(email, password) {
  const list = await db.list(COL_STAFF);
  const staff = list.find(s => s.email === String(email || '').toLowerCase().trim());
  if (!staff || !bcrypt.compareSync(password || '', staff.passwordHash)) return null;
  return staff;
}

async function create({ org_id, name, email, password, isAdmin }) {
  email = String(email || '').toLowerCase().trim();
  if (!name || !email || !password) return { error: 'name, email and password required' };
  if (password.length < 8) return { error: 'Password must be at least 8 characters' };
  const list = await db.list(COL_STAFF);
  if (list.some(s => s.email === email)) return { error: 'Email already registered' };
  const staff = {
    id: crypto.randomUUID(), org_id, name, email,
    passwordHash: bcrypt.hashSync(password, 12),
    isAdmin: !!isAdmin,
    createdAt: new Date().toISOString(),
  };
  await db.put(COL_STAFF, staff.id, staff);
  return { staff };
}

async function listSafe(orgId) {
  return (await db.list(COL_STAFF))
    .filter(s => s.org_id === orgId)
    .map(s => ({ id: s.id, name: s.name, email: s.email, isAdmin: s.isAdmin, createdAt: s.createdAt }));
}

function safe(s) {
  return s ? { id: s.id, org_id: s.org_id, name: s.name, email: s.email, isAdmin: s.isAdmin } : null;
}

// ── Presence trail ─────────────────────────────────────────────────────
// Events: login | heartbeat | leave | logout
async function logEvent(orgId, staffId, event) {
  const id = crypto.randomUUID();
  await db.put(COL_EVENTS, id, { id, org_id: orgId, staffId, event, at: new Date().toISOString() });
}

// Fold the raw event stream into per-staff presence sessions for one org.
async function sessions(orgId, limit = 50) {
  const events = (await db.list(COL_EVENTS)).filter(e => e.org_id === orgId);
  const staffList = await db.list(COL_STAFF);
  const names = Object.fromEntries(staffList.map(s => [s.id, s.name]));

  const byStaff = {};
  for (const e of events) (byStaff[e.staffId] = byStaff[e.staffId] || []).push(e);

  const out = [];
  const now = Date.now();
  for (const [staffId, evs] of Object.entries(byStaff)) {
    evs.sort((a, b) => a.at.localeCompare(b.at));
    let cur = null;
    for (const e of evs) {
      const t = Date.parse(e.at);
      if (cur && (t - cur.lastMs > GAP_MS)) { out.push(finish(cur)); cur = null; }
      if (e.event === 'login' || !cur) {
        if (cur) out.push(finish(cur));
        cur = { staffId, name: names[staffId] || 'Unknown', startMs: t, lastMs: t };
      }
      cur.lastMs = t;
      if (e.event === 'logout' || e.event === 'leave') {
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
