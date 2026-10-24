'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  MANIFEST — carrier handover manifests (SPX / TracX / Ninja Van …).
//
//  READ-ONLY against orders: the ready list is DERIVED from batches[].orderStates
//  (status 'done' = scan-completed). Nothing here writes to db.json, orderStates,
//  scan / complete statuses or anything the warehouse scan controls. "Handed
//  over" lives only in DATA_DIR/manifests.json and is derived on read.
//
//  Store shape: { manifests: [ { id, no, tenantId, carrier, client, status,
//    createdAt, createdBy, orders:[…frozen rows], token, signature?, ack?,
//    handedOverAt?, handedOverVia?, cancelledAt?, cancelledBy? } ], seq: {} }
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUSES = ['draft', 'handed_over', 'cancelled'];
const ACTIVE = new Set(['draft', 'handed_over']);

// Carrier name → one canonical tile. Unknown names pass through trimmed.
const CARRIER_RULES = [
  [/\b(spx|shopee\s*x?press|shopee\s*express|shopee)\b/i, 'SPX Express'],
  [/\b(tracx|lex|lazada|lel)\b/i, 'TracX (Lazada)'],
  [/\bninja/i, 'Ninja Van'],
  [/\bj\s*&?\s*t\b|j&t/i, 'J&T Express'],
  [/\bflash/i, 'Flash Express'],
  [/\bqxpress|qx\b/i, 'Qxpress'],
  [/\bdhl/i, 'DHL'],
  [/\bsingpost|speedpost/i, 'SingPost'],
  [/\btiktok|tts\b/i, 'TikTok Shipping'],
];
function normalizeCarrier(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Unassigned';
  for (const [re, name] of CARRIER_RULES) if (re.test(s)) return name;
  return s.slice(0, 60);
}

function sgtParts(d) {
  const t = new Date(d.getTime() + 8 * 3600e3);
  const p = n => String(n).padStart(2, '0');
  return { yymmdd: p(t.getUTCFullYear() % 100) + p(t.getUTCMonth() + 1) + p(t.getUTCDate()) };
}

function init(dataDir) {
  const file = path.join(dataDir, 'manifests.json');
  let cache = null;
  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cache = {}; }
    if (!Array.isArray(cache.manifests)) cache.manifests = [];
    if (!cache.seq || typeof cache.seq !== 'object') cache.seq = {};
    return cache;
  }
  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  }
  const forTenant = t => load().manifests.filter(m => m.tenantId === t);

  // order_number → active manifest (draft or handed over) for this tenant
  function activeIndex(tenantId) {
    const idx = new Map();
    for (const m of forTenant(tenantId)) if (ACTIVE.has(m.status)) for (const o of m.orders) idx.set(o.order, m);
    return idx;
  }

  function nextNo(tenantId, now) {
    const s = load(); const day = sgtParts(now).yymmdd; const k = tenantId + ':' + day;
    s.seq[k] = (s.seq[k] || 0) + 1;
    return `MF-${day}-${String(s.seq[k]).padStart(3, '0')}`;
  }

  function create(tenantId, { carrier, client, rows, createdBy, scan, now = new Date() }) {
    const idx = activeIndex(tenantId);
    const clash = rows.filter(r => idx.has(r.order));
    if (clash.length) {
      const e = new Error('Already on another manifest: ' + clash.map(r => `${r.order} (${idx.get(r.order).no})`).join(', '));
      e.status = 409; e.clash = clash.map(r => ({ order: r.order, manifest: idx.get(r.order).no })); throw e;
    }
    const m = {
      id: crypto.randomUUID(), no: nextNo(tenantId, now), tenantId, carrier, client: client || '',
      status: 'draft', createdAt: now.toISOString(), createdBy: createdBy || '',
      orders: rows, totals: totalsOf(rows), scan: scan || null,
      token: crypto.randomBytes(24).toString('base64url'),
    };
    load().manifests.push(m); save();
    return m;
  }
  function totalsOf(rows) {
    return { orders: rows.length, parcels: rows.reduce((s, r) => s + (r.parcels || 1), 0), qty: rows.reduce((s, r) => s + (r.qty || 0), 0) };
  }
  const get = (tenantId, id) => forTenant(tenantId).find(m => m.id === id || m.no === id) || null;
  function byToken(token) {
    const t = String(token || '');
    if (!/^[A-Za-z0-9_-]{32}$/.test(t)) return null;
    const tb = Buffer.from(t);
    // constant-time compare per candidate — no early exit on a prefix match
    let hit = null;
    for (const m of load().manifests) {
      const mb = Buffer.from(String(m.token || ''));
      if (mb.length === tb.length && crypto.timingSafeEqual(mb, tb)) hit = m;
    }
    return hit;
  }
  function lockedErr(m) {
    const e = new Error(m.status === 'cancelled' ? 'Manifest was cancelled' : 'Manifest already handed over'); e.status = m.status === 'cancelled' ? 410 : 409; return e;
  }
  function sign(m, { driverName, idLast4, plate, signature, by, now = new Date() }) {
    if (m.status !== 'draft') throw lockedErr(m);
    m.signature = { driverName, idLast4: idLast4 || '', plate: plate || '', image: signature, at: now.toISOString(), recordedBy: by || '' };
    m.status = 'handed_over'; m.handedOverAt = now.toISOString(); m.handedOverVia = 'signature';
    save(); return m;
  }
  function acknowledge(m, { name, plate, ip, ua, geo, now = new Date() }) {
    if (m.status !== 'draft') throw lockedErr(m);
    m.ack = { name, plate: plate || '', at: now.toISOString(), ip: ip || '', ua: ua || '', geo: geo || null };
    m.status = 'handed_over'; m.handedOverAt = now.toISOString(); m.handedOverVia = 'qr';
    save(); return m;
  }
  function cancel(m, { by, reason, now = new Date() }) {
    if (m.status !== 'draft') throw lockedErr(m);
    m.status = 'cancelled'; m.cancelledAt = now.toISOString(); m.cancelledBy = by || ''; m.cancelReason = reason || '';
    save(); return m;
  }
  function search(tenantId, q) {
    const Q = String(q || '').trim().toUpperCase();
    const list = forTenant(tenantId).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!Q) return list;
    return list.filter(m => m.no.toUpperCase().includes(Q) || m.carrier.toUpperCase().includes(Q) ||
      m.orders.some(o => String(o.order).toUpperCase().includes(Q) || (o.waybills || []).some(w => String(w).toUpperCase().includes(Q))));
  }
  return { load, save, create, get, byToken, sign, acknowledge, cancel, search, activeIndex, file, _reset: () => { cache = null; } };
}

// Staff view: everything except the token-free signature blob is fine to show;
// the public view is deliberately minimal (no clients, orders, rates).
function publicView(m) {
  return { no: m.no, carrier: m.carrier, parcels: m.totals.parcels, orders: m.totals.orders, createdAt: m.createdAt,
    status: m.status, acknowledged: m.status === 'handed_over',
    ackName: m.ack ? m.ack.name : (m.signature ? m.signature.driverName : ''), ackAt: m.handedOverAt || null };
}
function summaryView(m) {
  const { token, signature, orders, ...rest } = m;
  return { ...rest, orderCount: orders.length, signed: !!signature,
    ackBy: m.ack ? m.ack.name : (signature ? signature.driverName : ''), ackAt: m.handedOverAt || null };
}

module.exports = { init, normalizeCarrier, publicView, summaryView, STATUSES };
