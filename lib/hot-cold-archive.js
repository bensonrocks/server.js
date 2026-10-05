'use strict';
// Hot/cold order archive.
//
// writeDb rewrites the whole tenant db.json on every scan. Settled history
// that nobody is picking does not belong in that stringify. This module moves
// a batch, as a whole, into DATA_DIR/archive/cold/batches-YYYY-MM.json once
// it is settled AND older than the window (default 28 days). Cold files are
// written here and by the PII walks — never by writeDb.
//
// Default mode is off. "on" only PERMITS an explicit run; nothing moves at
// boot. Reads ("read" or "on") answer history search, an old completion
// slip, and a waybill lookup with a read-only archived row.
//
// Work batches always use the window. A reference_only batch (Betime Online
// and the other channel ledgers) uses it too, unless the run asks for
// HOT_COLD_ARCHIVE_REFERENCE=all_settled or passes reference=all_settled.
// That rule still leaves a reference hot when any order is open/processing
// or any line has a scanned quantity.

const fs = require('fs');
const path = require('path');

const WINDOW_DAYS_DEFAULT = 28;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MODES = new Set(['off', 'read', 'on']);
const REFERENCE_POLICIES = new Set(['window', 'all_settled']);
const GI_SCAN_SHAPE = /^gi-?\d{4,}$/i;

function modeFromEnv(env) {
  const raw = String((env && env.HOT_COLD_ARCHIVE) || '').trim().toLowerCase();
  return MODES.has(raw) ? raw : 'off';
}
function windowDaysFromEnv(env) {
  const n = parseInt(String((env && env.HOT_COLD_WINDOW_DAYS) || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : WINDOW_DAYS_DEFAULT;
}
function readsEnabled(mode) { return mode === 'read' || mode === 'on'; }
function movePermitted(mode) { return mode === 'on'; }
function coldDir(dataDir) { return path.join(dataDir, 'archive', 'cold'); }

// Absent, blank, or any other value stays on the window. all_settled is the
// only widening, and it still does not move data until a run is confirmed.
function referencePolicyFromEnv(env) {
  const raw = String((env && env.HOT_COLD_ARCHIVE_REFERENCE) || '').trim().toLowerCase();
  return raw === 'all_settled' ? 'all_settled' : 'window';
}
function resolveReferencePolicy(explicit, env) {
  const raw = explicit == null ? '' : String(explicit).trim().toLowerCase();
  if (!raw) return { policy: referencePolicyFromEnv(env) };
  if (!REFERENCE_POLICIES.has(raw)) {
    return { error: 'reference must be "window" or "all_settled".' };
  }
  return { policy: raw };
}

function norm(s) { return String(s || '').trim().toLowerCase(); }
function strip0(s) { return String(s || '').replace(/^0+(?=.)/, ''); }
function looseEqual(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = strip0(a), sb = strip0(b);
  return !!(sa && sb && sa === sb);
}

function scannedQty(st) {
  const sc = st && st.scanned;
  if (!sc || typeof sc !== 'object') return 0;
  let n = 0;
  for (const v of Object.values(sc)) n += Number(v) || 0;
  return n;
}

// Same clocks the rest of the app already uses. A missing clock stays hot:
// an undated completion is not evidence the work is old.
function settlementTime(st) {
  if (!st) return '';
  if (st.status === 'done') return st.endTime || '';
  if (st.status === 'unprocessed') {
    return st.unprocessed_at || (st.client_cancelled && st.client_cancelled.at) || st.updated_at || '';
  }
  return '';
}

function batchDecision(batch, cutoffIso, referencePolicy) {
  if (!batch || !batch.id) return { move: false, reason: 'no-id' };
  const orders = batch.orders || [];
  const states = batch.orderStates || {};
  if (batch.reference_only) {
    // all_settled skips the age gate only. Open, processing, unknown, and
    // anything with a scanned quantity stay hot at any age.
    if (referencePolicy !== 'all_settled') {
      const uploaded = batch.uploaded_at || '';
      if (!uploaded || !(uploaded < cutoffIso)) return { move: false, reason: 'reference-recent' };
    }
    for (const o of orders) {
      const st = states[o.order_number] || {};
      const status = st.status || 'pending';
      if (status !== 'pending' && status !== 'done' && status !== 'unprocessed') {
        return { move: false, reason: 'reference-open' };
      }
      if (scannedQty(st) > 0) return { move: false, reason: 'reference-scanned' };
    }
    return { move: true, reason: 'reference-settled' };
  }
  if (!orders.length) return { move: false, reason: 'empty-work' };
  let newest = '';
  for (const o of orders) {
    const st = states[o.order_number];
    const status = st && st.status;
    if (status !== 'done' && status !== 'unprocessed') return { move: false, reason: 'open-work' };
    const t = settlementTime(st);
    if (!t) return { move: false, reason: 'undated' };
    if (t > newest) newest = t;
  }
  if (!(newest < cutoffIso)) return { move: false, reason: 'recent' };
  return { move: true, reason: 'settled' };
}

function planArchive(db, { now = new Date(), windowDays = WINDOW_DAYS_DEFAULT, referencePolicy = 'window' } = {}) {
  const policy = referencePolicy === 'all_settled' ? 'all_settled' : 'window';
  const cutoffIso = new Date(now.getTime() - windowDays * 86400000).toISOString();
  const move = [];
  const kept = {
    'no-id': 0, 'open-work': 0, undated: 0, recent: 0, 'empty-work': 0,
    'reference-recent': 0, 'reference-open': 0, 'reference-scanned': 0,
  };
  let moveOrders = 0, moveReferenceBatches = 0, moveWorkBatches = 0;
  for (const b of (db && db.batches) || []) {
    const d = batchDecision(b, cutoffIso, policy);
    if (d.move) {
      move.push(b);
      moveOrders += (b.orders || []).length;
      if (b.reference_only) moveReferenceBatches++;
      else moveWorkBatches++;
    } else {
      kept[d.reason] = (kept[d.reason] || 0) + 1;
    }
  }
  return {
    cutoffIso, windowDays, referencePolicy: policy,
    move, kept, moveOrders, moveReferenceBatches, moveWorkBatches,
  };
}

function shardMonth(batch) {
  if (batch.reference_only) return String(batch.uploaded_at || '').slice(0, 7);
  const states = batch.orderStates || {};
  let newest = '';
  for (const o of batch.orders || []) {
    const t = settlementTime(states[o.order_number]);
    if (t > newest) newest = t;
  }
  return newest.slice(0, 7);
}
function shardFileName(batch) {
  const m = shardMonth(batch);
  return /^[0-9]{4}-[0-9]{2}$/.test(m) ? `batches-${m}.json` : 'batches-undated.json';
}

function summarisePlan(plan, mode) {
  const sample = (plan.move || []).slice(0, 20).map(b => ({
    id: b.id,
    client: b.client_name || '',
    orders: (b.orders || []).length,
    uploaded_at: b.uploaded_at || '',
    reference_only: !!b.reference_only,
    shard: shardFileName(b),
  }));
  const keptBatches = Object.values(plan.kept || {}).reduce((s, n) => s + n, 0);
  const referencePolicy = plan.referencePolicy === 'all_settled' ? 'all_settled' : 'window';
  const note = referencePolicy === 'all_settled'
    ? 'Dry run. Nothing was written. Settled reference batches are included at any age. Work batches still use the window. Open or scanned reference stays hot. HOT_COLD_ARCHIVE=on does not move data by itself.'
    : 'Dry run. Nothing was written. Reference batches newer than the window stay hot. Pass reference=all_settled, or set HOT_COLD_ARCHIVE_REFERENCE=all_settled, to include them. HOT_COLD_ARCHIVE=on does not move data by itself.';
  return {
    cutoff: plan.cutoffIso,
    windowDays: plan.windowDays,
    referencePolicy,
    mode: mode || 'off',
    moveBatches: (plan.move || []).length,
    moveOrders: plan.moveOrders || 0,
    moveReferenceBatches: plan.moveReferenceBatches || 0,
    moveWorkBatches: plan.moveWorkBatches || 0,
    keptBatches,
    kept: plan.kept,
    sample,
    note,
  };
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function listShardFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => /^batches-.*\.json$/.test(f)).sort(); }
  catch { return []; }
}
function readShard(dir, name) {
  if (!name || !/^batches-.*\.json$/.test(name)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function emptyIndex() {
  return {
    byBatchId: Object.create(null),
    byOrder: Object.create(null),
    byWaybill: Object.create(null),
    byIssue: Object.create(null),
    byPo: Object.create(null),
    byPick: Object.create(null),
  };
}
function asMap(obj) {
  const m = Object.create(null);
  if (!obj || typeof obj !== 'object') return m;
  for (const k of Object.keys(obj)) {
    if (BAD_KEYS.has(k)) continue;
    m[k] = obj[k];
  }
  return m;
}
function loadIndex(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    return {
      byBatchId: asMap(raw && raw.byBatchId),
      byOrder: asMap(raw && raw.byOrder),
      byWaybill: asMap(raw && raw.byWaybill),
      byIssue: asMap(raw && raw.byIssue),
      byPo: asMap(raw && raw.byPo),
      byPick: asMap(raw && raw.byPick),
    };
  } catch { return emptyIndex(); }
}
function safeKey(s) {
  const k = norm(s);
  if (!k || BAD_KEYS.has(k)) return '';
  return k;
}
function indexAdd(map, key, ref) {
  const k = safeKey(key);
  if (!k) return;
  const add = (kk) => {
    if (BAD_KEYS.has(kk)) return;
    if (!Object.prototype.hasOwnProperty.call(map, kk)) map[kk] = [];
    map[kk].push(ref);
  };
  add(k);
  const bare = strip0(k);
  if (bare && bare !== k) add(bare);
}

function rebuildIndex(dir) {
  const idx = emptyIndex();
  for (const name of listShardFiles(dir)) {
    for (const b of readShard(dir, name)) {
      if (!b || !b.id || BAD_KEYS.has(b.id)) continue;
      idx.byBatchId[b.id] = name;
      for (const o of b.orders || []) {
        if (!o || !o.order_number) continue;
        const st = (b.orderStates || {})[o.order_number] || {};
        const ref = {
          batchId: b.id,
          order_number: o.order_number,
          shard: name,
          reference_only: !!b.reference_only,
          scan_status: st.status || 'pending',
        };
        indexAdd(idx.byOrder, o.order_number, ref);
        indexAdd(idx.byWaybill, o.waybill_number, ref);
        indexAdd(idx.byIssue, o.issue_no, ref);
        indexAdd(idx.byPo, o.po_number, ref);
        indexAdd(idx.byPick, o.pick_ticket, ref);
      }
    }
  }
  atomicWrite(path.join(dir, 'index.json'), idx);
  return idx;
}

// Shards first, then the hot list, then the index. A crash between those
// steps is recovered by the next apply: an id already in the shard is not
// written again, and a missing index falls through to a hay scan.
function applyPlan(dir, db, plan) {
  const move = (plan && plan.move || []).filter(b => b && b.id);
  const hotList = (db && db.batches) || [];
  const hotIds = new Set(hotList.map(b => b && b.id).filter(Boolean));
  const todo = move.filter(b => hotIds.has(b.id));
  if (!todo.length) return { movedBatches: 0, movedOrders: 0, shards: [], noop: true };
  fs.mkdirSync(dir, { recursive: true });
  const byName = new Map();
  const shardNames = new Set();
  for (const batch of todo) {
    const name = shardFileName(batch);
    shardNames.add(name);
    let entry = byName.get(name);
    if (!entry) {
      const existing = readShard(dir, name);
      entry = {
        batches: existing,
        ids: new Set(existing.map(b => b && b.id).filter(Boolean)),
        dirty: false,
      };
      byName.set(name, entry);
    }
    if (!entry.ids.has(batch.id)) {
      entry.batches.push(batch);
      entry.ids.add(batch.id);
      entry.dirty = true;
    }
  }
  for (const [name, entry] of byName) {
    if (!entry.dirty) continue;
    atomicWrite(path.join(dir, name), entry.batches);
  }
  const moveIds = new Set(todo.map(b => b.id));
  let movedBatches = 0, movedOrders = 0;
  const kept = [];
  for (const b of hotList) {
    if (b && b.id && moveIds.has(b.id)) {
      movedBatches++;
      movedOrders += (b.orders || []).length;
      continue;
    }
    kept.push(b);
  }
  db.batches = kept;
  rebuildIndex(dir);
  return { movedBatches, movedOrders, shards: [...shardNames].sort(), noop: movedBatches === 0 };
}

function readBatch(dir, batchId) {
  if (!batchId) return null;
  const idx = loadIndex(dir);
  const name = idx.byBatchId[batchId];
  if (name) {
    const hit = readShard(dir, name).find(b => b && b.id === batchId);
    if (hit) return hit;
  }
  for (const f of listShardFiles(dir)) {
    const hit = readShard(dir, f).find(b => b && b.id === batchId);
    if (hit) return hit;
  }
  return null;
}

function lookupRank(ref, q) {
  const st = String(ref.scan_status || '');
  let r = 0;
  if (ref.reference_only) r += 1000;
  if (st === 'unprocessed') r += 100;
  if (GI_SCAN_SHAPE.test(String(q || ''))) { if (st !== 'done' && st !== 'processing') r += 10; }
  else if (st === 'done') r += 10;
  return r;
}
function pickLookup(matches, q) {
  if (!matches || !matches.length) return null;
  return matches.map((o, i) => ({ o, i, r: lookupRank(o, q) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)[0].o;
}

function consider(out, seen, list) {
  for (const ref of list || []) {
    if (!ref || !ref.batchId) continue;
    const id = ref.batchId + '|' + ref.order_number;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(ref);
  }
}
function lookupExact(dir, q) {
  const needle = norm(q);
  if (!needle) return [];
  const idx = loadIndex(dir);
  const seen = new Set();
  const out = [];
  const bare = strip0(needle);
  for (const map of [idx.byOrder, idx.byWaybill, idx.byIssue, idx.byPo, idx.byPick]) {
    if (Object.prototype.hasOwnProperty.call(map, needle)) consider(out, seen, map[needle]);
    if (bare && bare !== needle && Object.prototype.hasOwnProperty.call(map, bare)) consider(out, seen, map[bare]);
  }
  if (!out.length) return hayExact(dir, needle);
  return out;
}
function hayExact(dir, needle) {
  const out = [];
  const seen = new Set();
  for (const f of listShardFiles(dir)) {
    for (const b of readShard(dir, f)) {
      if (!b) continue;
      for (const o of b.orders || []) {
        if (!o) continue;
        const fields = [o.order_number, o.waybill_number, o.issue_no, o.po_number, o.pick_ticket];
        if (!fields.some(v => looseEqual(norm(v), needle))) continue;
        const id = b.id + '|' + o.order_number;
        if (seen.has(id)) continue;
        seen.add(id);
        const st = (b.orderStates || {})[o.order_number] || {};
        out.push({
          batchId: b.id,
          order_number: o.order_number,
          shard: f,
          reference_only: !!b.reference_only,
          scan_status: st.status || 'pending',
        });
      }
    }
  }
  return out;
}

function toSearchRow(batch, orderNumber) {
  const o = (batch.orders || []).find(x => x && String(x.order_number) === String(orderNumber));
  if (!o) return null;
  const st = (batch.orderStates || {})[o.order_number] || {};
  return {
    ...o,
    items: o.lines || [],
    client_name: batch.client_name || '',
    batchId: batch.id,
    uploadedAt: batch.uploaded_at,
    idealscan_code: batch.idealscan_code || '',
    scan_status: st.status || 'pending',
    scanned: st.scanned || {},
    startTime: st.startTime || null,
    endTime: st.endTime || null,
    operator: st.operator || null,
    reference_only: !!batch.reference_only,
    archived: true,
    archive_tier: 'cold',
    client_cancelled: st.client_cancelled || null,
    pickup: st.pickup || null,
    hub_exception: st.hub_exception || null,
    unprocessed_reason: st.unprocessed_reason || '',
    auto_cancelled: st.auto_cancelled || null,
    unprocessed_at: st.unprocessed_at || null,
    updated_at: st.updated_at || null,
    client_reassigned_to: st.client_reassigned_to || '',
  };
}
function lookupPayload(batch, orderNumber) {
  const row = toSearchRow(batch, orderNumber);
  if (!row) return null;
  delete row.scanned;
  row.message = row.reference_only
    ? `${row.order_number} is a channel reference under ${row.client_name || 'the client'} in the history archive, and is not open for scanning.`
    : `Order ${row.order_number} is in the history archive and is not open for scanning.`;
  return row;
}

function lookupWhenReadable(env, dataDir, q) {
  if (!readsEnabled(modeFromEnv(env))) return null;
  const best = pickLookup(lookupExact(coldDir(dataDir), q), q);
  if (!best) return null;
  const batch = readBatch(coldDir(dataDir), best.batchId);
  if (!batch) return null;
  return lookupPayload(batch, best.order_number);
}

function searchCold(dir, q, cap, opts) {
  const needle = norm(q);
  if (needle.length < 3) return [];
  const bare = strip0(needle);
  const client = opts && opts.client ? norm(opts.client) : '';
  const identifiersOnly = !!(opts && opts.identifiersOnly);
  const out = [];
  const limit = cap > 0 ? cap : 60;
  for (const f of listShardFiles(dir)) {
    for (const batch of readShard(dir, f)) {
      if (!batch) continue;
      if (client && norm(batch.client_name) !== client) continue;
      for (const o of batch.orders || []) {
        if (!o) continue;
        const ids = [o.order_number, o.waybill_number, o.issue_no, o.pick_ticket, o.po_number];
        const idHit = ids.some(v => {
          const s = norm(v);
          if (!s) return false;
          if (s.includes(needle)) return true;
          return !!(bare && strip0(s) === bare);
        });
        let hit = idHit;
        if (!hit && !identifiersOnly) {
          const hay = [...ids, o.customer_name, batch.client_name, batch.idealscan_code]
            .filter(Boolean).join(' ').toLowerCase();
          hit = hay.includes(needle);
        }
        if (!hit) continue;
        const row = toSearchRow(batch, o.order_number);
        if (row) out.push(row);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
function searchWhenReadable(env, dataDir, q, cap = 60, opts) {
  if (!readsEnabled(modeFromEnv(env))) return [];
  return searchCold(coldDir(dataDir), q, cap, opts);
}
function readBatchWhenReadable(env, dataDir, batchId) {
  if (!readsEnabled(modeFromEnv(env))) return null;
  return readBatch(coldDir(dataDir), batchId);
}

function restoreAll(dir, db) {
  if (!db.batches) db.batches = [];
  const have = new Set(db.batches.map(b => b && b.id).filter(Boolean));
  const ids = [];
  for (const f of listShardFiles(dir)) {
    for (const b of readShard(dir, f)) {
      if (!b || !b.id || have.has(b.id)) continue;
      db.batches.push(b);
      have.add(b.id);
      ids.push(b.id);
    }
  }
  return { restored: ids.length, ids };
}
function retireCold(dataDir) {
  const dir = coldDir(dataDir);
  if (!fs.existsSync(dir)) return { retired: false };
  const dest = path.join(path.dirname(dir), 'cold-retired-' + Date.now());
  fs.renameSync(dir, dest);
  return { retired: true, to: dest };
}

function withEachShard(dir, fn) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const f of listShardFiles(dir)) {
    const file = path.join(dir, f);
    let batches;
    try { batches = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!Array.isArray(batches)) continue;
    if (fn(batches)) atomicWrite(file, batches);
  }
}

// Personal-data purge for a cold shard. Dry-run counts and returns dirty
// false so the shard file is not rewritten. Only a completed order with an
// endTime older than the cutoff is touched — the same clock as the live pass.
function redactSettledPersonal(batches, cutoffMs, fields, dryRun) {
  let orders = 0, fieldHits = 0, dirty = false;
  for (const b of batches || []) {
    const states = (b && b.orderStates) || {};
    for (const o of (b && b.orders) || []) {
      if (!o || o.pii_purged_at) continue;
      const st = states[o.order_number] || {};
      if (st.status !== 'done') continue;
      const done = new Date(st.endTime || 0).getTime();
      if (!done || done > cutoffMs) continue;
      let hit = false;
      for (const f of fields || []) {
        if (o[f] === undefined || o[f] === '' || o[f] === null) continue;
        fieldHits++;
        hit = true;
        if (!dryRun) o[f] = '';
      }
      if (hit) orders++;
      if (!dryRun && hit) { o.pii_purged_at = new Date().toISOString(); dirty = true; }
    }
  }
  return { orders, fieldHits, dirty };
}

module.exports = {
  WINDOW_DAYS_DEFAULT,
  modeFromEnv, windowDaysFromEnv, readsEnabled, movePermitted, coldDir,
  referencePolicyFromEnv, resolveReferencePolicy,
  batchDecision, planArchive, summarisePlan, shardFileName,
  applyPlan, rebuildIndex, readBatch, lookupExact, hayExact, pickLookup,
  lookupWhenReadable, searchWhenReadable, readBatchWhenReadable,
  restoreAll, retireCold, withEachShard, redactSettledPersonal,
  toSearchRow, atomicWrite,
};
