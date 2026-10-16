'use strict';
// ── WEB PUSH (PWA) ─────────────────────────────────────────────────────────
// OFF unless BOTH VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set. The
// `web-push` module is required LAZILY on the first real send, so nothing is
// loaded at startup and a missing module can never stop the server booting.
//
// Subscriptions live in the tenant db as db.push_subscriptions:
//   { id, surface: 'portal'|'main', client?, userId, endpoint, keys, alerts, created_at }
// One row per browser endpoint (re-subscribing replaces it).
//
// ALERT REGISTRY: an alert is { type, surface, title, defaultOn }. Senders call
// sendToSubscribers(db, filter, alertType, payload). Adding "goods received" or
// "order collected" later = registerAlert(...) + a call at the event site.
const crypto = require('crypto');

const ALERTS = new Map();
function registerAlert(def) { ALERTS.set(def.type, { defaultOn: true, ...def }); }
registerAlert({ type: 'low_stock', surface: 'portal', title: 'Daily low-stock alert' });
// Reserved for later — not sent yet:
// registerAlert({ type: 'goods_received', surface: 'portal', title: 'Goods received' });
// registerAlert({ type: 'order_collected', surface: 'portal', title: 'Order collected' });

function vapid() {
  const pub = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!pub || !priv) return null;
  return { pub, priv, subject: String(process.env.VAPID_SUBJECT || 'mailto:admin@idealone.tech').trim() };
}
function enabled() { return !!vapid(); }
function publicKey() { const v = vapid(); return v ? v.pub : null; }

let _wp = null, _wpErr = null;
function lib() {
  if (_wp || _wpErr) return _wp;
  const v = vapid();
  if (!v) return null;
  try { _wp = require('web-push'); _wp.setVapidDetails(v.subject, v.pub, v.priv); }
  catch (e) { _wpErr = e; console.error('[push] web-push unavailable:', e.message); }
  return _wp;
}

function list(db) { if (!Array.isArray(db.push_subscriptions)) db.push_subscriptions = []; return db.push_subscriptions; }

// Validates a browser PushSubscription JSON. Returns a clean object or null.
function cleanSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = String(sub.endpoint || '');
  if (!/^https:\/\/[^\s]{8,2000}$/.test(endpoint)) return null;
  const k = sub.keys || {};
  const p256dh = String(k.p256dh || ''), auth = String(k.auth || '');
  if (!/^[A-Za-z0-9_\-=]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_\-=]{8,100}$/.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function upsert(db, { surface, client, userId, subscription, alerts }) {
  const s = cleanSubscription(subscription);
  if (!s) return null;
  const rows = list(db);
  const i = rows.findIndex(r => r.endpoint === s.endpoint);
  const defAlerts = {};
  for (const a of ALERTS.values()) if (a.surface === surface) defAlerts[a.type] = a.defaultOn;
  const row = {
    id: i >= 0 ? rows[i].id : crypto.randomUUID(),
    surface, client: client || null, userId: String(userId || ''),
    endpoint: s.endpoint, keys: s.keys,
    alerts: { ...defAlerts, ...(alerts && typeof alerts === 'object' ? sanitizeAlerts(alerts, surface) : {}) },
    created_at: i >= 0 ? rows[i].created_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (i >= 0) rows[i] = row; else rows.push(row);
  return row;
}
function sanitizeAlerts(a, surface) {
  const o = {};
  for (const [k, v] of Object.entries(a)) { const d = ALERTS.get(k); if (d && d.surface === surface) o[k] = v === true; }
  return o;
}
function remove(db, endpoint, userId) {
  const rows = list(db);
  const before = rows.length;
  db.push_subscriptions = rows.filter(r => !(r.endpoint === endpoint && (!userId || r.userId === String(userId))));
  return before !== db.push_subscriptions.length;
}
function forUser(db, surface, userId, client) {
  return list(db).filter(r => r.surface === surface && r.userId === String(userId)
    && (surface !== 'portal' || String(r.client || '').toLowerCase() === String(client || '').toLowerCase()));
}

// Sends to every subscription matching filter(row) that has alertType on.
// Returns { sent, failed, gone: [endpoints] } — caller removes `gone` (404/410).
async function sendToSubscribers(rows, alertType, payload) {
  const out = { sent: 0, failed: 0, gone: [] };
  const wp = lib();
  if (!wp) return out;
  const body = JSON.stringify({ type: alertType, ...payload });
  for (const r of rows) {
    if (!r.alerts || r.alerts[alertType] !== true) continue;
    try { await wp.sendNotification({ endpoint: r.endpoint, keys: r.keys }, body, { TTL: 12 * 3600 }); out.sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) out.gone.push(r.endpoint); else out.failed++; }
  }
  return out;
}

module.exports = { enabled, publicKey, registerAlert, ALERTS, cleanSubscription, upsert, remove, forUser, list, sendToSubscribers };
