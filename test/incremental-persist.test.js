// Incremental hot-db persist. No server. Proves the assembled file matches
// JSON.stringify, and that a scan-shaped edit does not re-stringify orders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const inc = require('../lib/incremental-persist');

function text(built) { return inc.partsToString(built.parts); }

function roundTrip(raw, tenant) {
  const built = inc.build(tenant, raw);
  const out = text(built);
  assert.equal(out, JSON.stringify(raw));
  return built;
}

test('flag is off unless explicitly enabled', () => {
  const prev = process.env.DB_INCREMENTAL_PERSIST;
  delete process.env.DB_INCREMENTAL_PERSIST;
  assert.equal(inc.enabled(), false);
  for (const off of ['', '0', 'off', 'false', 'no', 'OFF']) {
    process.env.DB_INCREMENTAL_PERSIST = off;
    assert.equal(inc.enabled(), false, off);
  }
  for (const on of ['1', 'on', 'true', 'yes', 'ON']) {
    process.env.DB_INCREMENTAL_PERSIST = on;
    assert.equal(inc.enabled(), true, on);
  }
  if (prev === undefined) delete process.env.DB_INCREMENTAL_PERSIST;
  else process.env.DB_INCREMENTAL_PERSIST = prev;
});

test('assembled JSON matches stringify across scan-shaped edits', () => {
  const raw = {
    batches: [{
      id: 'b1',
      client_name: 'BETIME',
      orders: [
        { sku: '8006', description: 'Tape', qty: 3 },
        { sku: '8009', description: 'Box', qty: 1 },
      ],
      orderStates: {
        'GI-1': { status: 'pending', scanned: { '8006': 0 }, scanLog: [] },
      },
      uploaded_at: '2026-10-05T01:02:03.000Z',
    }],
    auditLog: [],
    inbound: [{ id: 'IB-1', lines: [{ sku: '8006', qty: 4 }] }],
    drivers: [{ id: 'DRV-1', name: 'Ahmad' }],
    skipped: undefined,
  };
  const db = inc.track('eq', raw);
  let built = roundTrip(raw, 'eq');
  assert.equal(built.fullRebuild, true);

  const state = db.batches[0].orderStates['GI-1'];
  state.scanned['8006'] = (state.scanned['8006'] || 0) + 1;
  state.status = 'processing';
  state.scanLog.push({ sku: '8006', at: '2026-10-05T02:00:00.000Z' });
  db.batches[0].orderStates['GI-1'] = state;
  built = roundTrip(raw, 'eq');
  assert.equal(built.fullRebuild, false);
  assert.equal(built.ordersRewritten, 0);
  assert.equal(built.statesRewritten, 1);
  assert.equal(built.auditMode, 'reuse');

  db.auditLog.push({ type: 'scan', order: 'GI-1', at: '2026-10-05T02:00:01.000Z' });
  built = roundTrip(raw, 'eq');
  assert.equal(built.auditMode, 'append');
  assert.equal(built.statesRewritten, 0);
  assert.equal(built.ordersRewritten, 0);

  db.batches.unshift({
    id: 'b0',
    orders: [{ sku: '1', qty: 1 }],
    orderStates: { 'GI-0': { status: 'pending', scanned: {} } },
  });
  built = roundTrip(raw, 'eq');
  assert.equal(built.ordersRewritten, 1);
  assert.equal(built.statesRewritten, 1);

  db.auditLog.splice(0, 1, { type: 'replaced', at: '2026-10-05T03:00:00.000Z' });
  built = roundTrip(raw, 'eq');
  assert.equal(built.auditMode, 'full');

  db.auditLog[0].extra = 'edited';
  built = roundTrip(raw, 'eq');
  assert.equal(built.auditMode, 'full');

  db.batches[1].orders.forEach(line => { if (line.sku === '8006') line.qty = 9; });
  built = roundTrip(raw, 'eq');
  assert.equal(built.ordersRewritten, 1);
  assert.equal(built.statesRewritten, 0);

  db.inbound[0].lines[0].qty = 5;
  built = roundTrip(raw, 'eq');
  assert.equal(raw.inbound[0].lines[0].qty, 5);

  delete db.drivers;
  built = roundTrip(raw, 'eq');
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'drivers'), false);

  db.batches[1].uploaded_at = new Date('2026-10-05T00:00:00.000Z');
  built = roundTrip(raw, 'eq');
  assert.match(text(built), /2026-10-05T00:00:00.000Z/);

  let seen = 0;
  for (const batch of db.batches) { batch.walked = true; seen++; }
  assert.equal(seen, 2);
  roundTrip(raw, 'eq');
});

test('a scan does not re-stringify a large orders array', () => {
  const fat = 'X'.repeat(4000);
  const orders = [];
  for (let i = 0; i < 2000; i++) orders.push({ sku: 'SKU' + i, description: fat, qty: 1 });
  const raw = {
    batches: [{
      id: 'big',
      orders,
      orderStates: { 'GI-900001': { status: 'processing', scanned: { SKU1: 1 }, cartons: [{ num: 1, scans: { SKU1: 1 } }] } },
    }],
    auditLog: [{ type: 'boot', at: '2026-10-05T00:00:00.000Z' }],
    inbound: [],
  };
  const db = inc.track('big', raw);
  const first = roundTrip(raw, 'big');
  assert.equal(first.fullRebuild, true);
  assert.equal(first.ordersRewritten, 1);
  const ordersBytes = first.stringifiedBytes;

  db.batches[0].orderStates['GI-900001'].scanned.SKU1 = 2;
  db.auditLog.push({ type: 'scan', sku: 'SKU1' });
  // Time build() only. roundTrip also stringifies the whole object to prove
  // byte-equality, and that cost is the legacy path, not this one.
  const t0 = process.hrtime.bigint();
  const second = inc.build('big', raw);
  const incMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const s0 = process.hrtime.bigint();
  const full = JSON.stringify(raw);
  const fullMs = Number(process.hrtime.bigint() - s0) / 1e6;

  assert.equal(second.fullRebuild, false);
  assert.equal(second.ordersRewritten, 0);
  assert.equal(second.statesRewritten, 1);
  assert.equal(second.auditMode, 'append');
  assert.ok(second.stringifiedBytes < 8000, 'stringified ' + second.stringifiedBytes);
  assert.ok(second.reusedBytes > 5_000_000, 'reused ' + second.reusedBytes);
  assert.ok(ordersBytes > second.stringifiedBytes * 20);
  assert.equal(text(second), full);
  if (fullMs > 8) assert.ok(incMs < fullMs / 3, `incremental ${incMs.toFixed(1)} ms vs full ${fullMs.toFixed(1)} ms`);
});

test('replacing the db object drops stale fragments', () => {
  const first = { batches: [{ id: 'a', orders: [{ sku: '1', description: 'Y'.repeat(1000), qty: 1 }], orderStates: {} }], auditLog: [] };
  inc.track('swap', first);
  roundTrip(first, 'swap');
  const next = { batches: [{ id: 'b', orders: [{ sku: '2', qty: 4 }], orderStates: { N: { status: 'pending', scanned: {} } } }], auditLog: [{ type: 'new' }] };
  inc.noteIdentity('swap', next);
  const built = roundTrip(next, 'swap');
  assert.equal(built.fullRebuild, true);
  assert.equal(text(built), JSON.stringify(next));
  assert.equal(text(built).includes('"id":"a"'), false);
});

test('module does not read the cold archive', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'incremental-persist.js'), 'utf8');
  assert.equal(src.includes('hotCold'), false);
  assert.equal(src.includes('archive/cold'), false);
  const marker = 'COLD_SHARD_MARKER_not_in_hot_db';
  const raw = { batches: [], auditLog: [], note: 'hot only' };
  const built = roundTrip(raw, 'cold-' + Date.now());
  assert.equal(text(built).includes(marker), false);
});

test('server keeps the legacy stringify and gates the incremental path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = src.indexOf('function _persistDb(');
  const end = src.indexOf('function _flushPersistTimer(');
  const body = src.slice(start, end);
  assert.match(body, /incrementalPersist\.enabled\(\)/);
  assert.match(body, /incrementalPersist\.build\(/);
  assert.match(body, /JSON\.stringify\(/);
  const wStart = src.indexOf('function writeDb(');
  const wEnd = src.indexOf('\nfunction ', wStart + 1);
  const writeBody = src.slice(wStart, wEnd);
  assert.equal(writeBody.includes('hotCold'), false);
  assert.equal(writeBody.includes('archive/cold'), false);
  assert.match(writeBody, /incrementalPersist\.unwrap/);
  assert.match(src, /function readDb\([\s\S]*incrementalPersist\.track/);
});

test('periodic rebuild waits for idle window, then runs; max-defer forces', () => {
  const prev = { ...process.env };
  process.env.DB_INCREMENTAL_PERSIST = 'on';
  process.env.DB_INCREMENTAL_REBUILD_MS = '1000';
  process.env.DB_INCREMENTAL_REBUILD_IDLE_MS = '500';
  process.env.DB_INCREMENTAL_REBUILD_MAX_DEFER_MS = '5000';
  delete process.env.DB_INCREMENTAL_REBUILD_OFFPEAK;

  const raw = {
    batches: [{ id: 'b1', orders: [{ sku: '1', qty: 1 }], orderStates: { 'GI-1': { status: 'pending', scanned: {} } } }],
    auditLog: [],
  };
  const tid = 'idle-' + Date.now();
  const db = inc.track(tid, raw);
  let built = inc.build(tid, raw, { now: 1_000_000 });
  assert.equal(built.fullRebuild, true);
  assert.equal(built.rebuildReason, 'prime');

  // Due (now past lastFullAt+1000) but a write landed 50ms ago → wait-idle
  db.batches[0].orderStates['GI-1'].scanned['1'] = 1;
  inc.noteActivity(tid, 1_001_150);
  built = inc.build(tid, raw, { now: 1_001_200 });
  assert.equal(built.fullRebuild, false, 'should wait for idle');
  assert.equal(built.rebuildReason, 'wait-idle');

  // Quiet for >= 500ms since last activity
  built = inc.build(tid, raw, { now: 1_001_700 });
  assert.equal(built.fullRebuild, true);
  assert.equal(built.rebuildReason, 'due');

  // Max-defer forces even while busy
  const tid2 = 'defer-' + Date.now();
  const raw2 = JSON.parse(JSON.stringify(raw));
  inc.track(tid2, raw2);
  built = inc.build(tid2, raw2, { now: 2_000_000 });
  assert.equal(built.rebuildReason, 'prime');
  inc.noteActivity(tid2, 2_006_000);
  built = inc.build(tid2, raw2, { now: 2_006_500 });
  assert.equal(built.fullRebuild, true);
  assert.equal(built.rebuildReason, 'max-defer');

  for (const k of Object.keys(process.env)) {
    if (!(k in prev)) delete process.env[k];
  }
  Object.assign(process.env, prev);
});

test('off-peak window gates rebuild until SGT window (or max-defer)', () => {
  const prev = { ...process.env };
  process.env.DB_INCREMENTAL_PERSIST = 'on';
  process.env.DB_INCREMENTAL_REBUILD_MS = '1000';
  process.env.DB_INCREMENTAL_REBUILD_IDLE_MS = '0'; // idle always ok
  process.env.DB_INCREMENTAL_REBUILD_MAX_DEFER_MS = '10000'; // 10000
  process.env.DB_INCREMENTAL_REBUILD_OFFPEAK = '22:00-06:00';

  // Pick a UTC instant that is 12:00 SGT (UTC+8) → 04:00 UTC
  // 2026-10-09T04:00:00Z = 12:00 SGT — outside 22:00-06:00
  const noonSgt = Date.parse('2026-10-09T04:00:00.000Z');
  assert.equal(inc.inRebuildOffPeak(noonSgt, '22:00-06:00'), false);
  const nightSgt = Date.parse('2026-10-09T16:00:00.000Z'); // 00:00 SGT next calendar... 16:00Z = 00:00 SGT
  assert.equal(inc.inRebuildOffPeak(nightSgt, '22:00-06:00'), true);

  const tid = 'offpeak-' + Date.now();
  const raw = { batches: [], auditLog: [] };
  inc.track(tid, raw);
  let built = inc.build(tid, raw, { now: noonSgt });
  assert.equal(built.rebuildReason, 'prime');
  built = inc.build(tid, raw, { now: noonSgt + 2000 });
  assert.equal(built.fullRebuild, false);
  assert.equal(built.rebuildReason, 'wait-offpeak');
  built = inc.build(tid, raw, { now: noonSgt + 12_000 });
  assert.equal(built.fullRebuild, true);
  assert.equal(built.rebuildReason, 'max-defer');

  for (const k of Object.keys(process.env)) {
    if (!(k in prev)) delete process.env[k];
  }
  Object.assign(process.env, prev);
});

test('IDLE_MS=0 restores immediate rebuild-when-due (legacy)', () => {
  const prev = { ...process.env };
  process.env.DB_INCREMENTAL_PERSIST = 'on';
  process.env.DB_INCREMENTAL_REBUILD_MS = '1000';
  process.env.DB_INCREMENTAL_REBUILD_IDLE_MS = '0';
  process.env.DB_INCREMENTAL_REBUILD_MAX_DEFER_MS = '0';
  delete process.env.DB_INCREMENTAL_REBUILD_OFFPEAK;

  const tid = 'legacy-' + Date.now();
  const raw = { batches: [{ id: 'b', orders: [], orderStates: {} }], auditLog: [] };
  inc.track(tid, raw);
  let built = inc.build(tid, raw, { now: 5_000_000 });
  assert.equal(built.rebuildReason, 'prime');
  inc.noteActivity(tid, 5_001_500); // would have blocked if idle gate on
  built = inc.build(tid, raw, { now: 5_001_500 });
  assert.equal(built.fullRebuild, true);
  assert.equal(built.rebuildReason, 'due');

  for (const k of Object.keys(process.env)) {
    if (!(k in prev)) delete process.env[k];
  }
  Object.assign(process.env, prev);
});
