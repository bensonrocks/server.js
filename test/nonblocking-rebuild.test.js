// Non-blocking full rebuild (DB_REBUILD_NONBLOCKING) — freeze fix 2026-10-20.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const inc = require('../lib/incremental-persist');
const { makeSyntheticDb } = require('./fixtures/synthetic-db');

const text = b => inc.partsToString(b.parts);

function lagProbe() {
  let max = 0, last = process.hrtime.bigint(), on = true;
  const tick = () => { if (!on) return; const now = process.hrtime.bigint(); const d = Number(now - last) / 1e6; if (d > max) max = d; last = now; setImmediate(tick); };
  setImmediate(tick);
  return () => { on = false; return max; };
}

test('flag defaults: non-blocking off; avoid window Mon-Sat 08:00-19:00', () => {
  const p = process.env.DB_REBUILD_NONBLOCKING; delete process.env.DB_REBUILD_NONBLOCKING;
  assert.equal(inc.nonBlockingEnabled(), false);
  process.env.DB_REBUILD_NONBLOCKING = '1'; assert.equal(inc.nonBlockingEnabled(), true);
  if (p === undefined) delete process.env.DB_REBUILD_NONBLOCKING; else process.env.DB_REBUILD_NONBLOCKING = p;
  assert.equal(inc.avoidWindowSpec(), 'Mon-Sat 08:00-19:00');
});

test('avoid window is SGT and day-aware', () => {
  const sgt = s => Date.parse(s + '+08:00');
  assert.equal(inc.inAvoidWindow(sgt('2026-10-19T10:47:00')), true);   // Mon
  assert.equal(inc.inAvoidWindow(sgt('2026-10-24T18:59:00')), true);   // Sat
  assert.equal(inc.inAvoidWindow(sgt('2026-10-24T19:00:00')), false);
  assert.equal(inc.inAvoidWindow(sgt('2026-10-25T10:00:00')), false);  // Sun
  assert.equal(inc.inAvoidWindow(sgt('2026-10-20T07:59:00')), false);
  assert.equal(inc.inAvoidWindow(sgt('2026-10-20T12:00:00'), 'off'), false);
});

test('scan-hours guard defers a due rebuild until overdue', () => {
  const save = { ...process.env };
  process.env.DB_INCREMENTAL_REBUILD_MS = '600000';
  process.env.DB_INCREMENTAL_REBUILD_IDLE_MS = '0';
  process.env.DB_REBUILD_AVOID_MAX_DEFER_MS = '3600000';
  delete process.env.DB_REBUILD_AVOID_WINDOW;
  const mon11 = Date.parse('2026-10-19T11:00:00+08:00');
  const st = { primed: true, lastFullAt: mon11 - 700000, lastActivityAt: 0 };
  assert.deepEqual(inc.shouldFullRebuildNB(st, mon11), { full: false, reason: 'wait-scan-hours' });
  st.lastFullAt = mon11 - 600000 - 3600000;
  assert.equal(inc.shouldFullRebuildNB(st, mon11).reason, 'overdue-scan-hours');
  const mon20 = Date.parse('2026-10-19T20:00:00+08:00');
  st.lastFullAt = mon20 - 700000;
  assert.equal(inc.shouldFullRebuildNB(st, mon20).reason, 'due');
  process.env = save;
});

test('buildAsync round-trips byte-identically, then incremental continues', async () => {
  const raw = makeSyntheticDb(3, 7);
  const db = inc.track('rt', raw);
  const b = await inc.buildAsync('rt', raw, { forceFull: true });
  assert.equal(b.async, true); assert.equal(b.committed, true);
  assert.equal(text(b), JSON.stringify(raw));
  db.batches[1].orderStates[Object.keys(raw.batches[1].orderStates)[0]].status = 'processing';
  db.auditLog.push({ type: 'scan', at: new Date().toISOString() });
  const b2 = inc.build('rt', raw);
  assert.equal(b2.fullRebuild, false);
  assert.equal(b2.ordersRewritten, 0);
  assert.equal(text(b2), JSON.stringify(raw));
});

test('writes made DURING the rebuild are kept by the next persist', async () => {
  const save = process.env.DB_REBUILD_SLICE_MS; process.env.DB_REBUILD_SLICE_MS = '1';
  const raw = makeSyntheticDb(6, 3);
  const db = inc.track('during', raw);
  inc.build('during', raw); // prime
  const nB = raw.batches.length;
  const p = inc.buildAsync('during', raw, { forceFull: true });
  // Mutate on every turn while the rebuild yields: early batch (already
  // emitted), last batch (not yet), audit append, audit in-place edit, new key,
  // deleted key, new batch.
  let turns = 0, done = false;
  p.then(() => { done = true; });
  while (!done) {
    turns++;
    const first = db.batches[0]; const k0 = Object.keys(raw.batches[0].orderStates)[turns % 50];
    first.orderStates[k0].status = 'during-' + turns;
    db.batches[nB - 1].orders[0].customer_name = 'late-' + turns;
    db.auditLog.push({ type: 'scan', at: new Date().toISOString(), n: turns });
    if (turns === 3) db.auditLog[5].note = 'edited';
    db['k' + turns] = { t: turns };
    if (turns === 2) delete db.drivers;
    if (turns === 4) db.batches.push({ id: 'new', orders: [{ order_number: 'N1' }], orderStates: { N1: { status: 'pending' } } });
    await new Promise(r => setImmediate(r));
  }
  const b = await p;
  assert.ok(turns > 5, 'rebuild yielded ' + turns + ' times');
  assert.equal(b.committed, true);
  // The rebuild snapshot itself is valid JSON …
  JSON.parse(text(b));
  // … and the very next (incremental) persist equals the live object exactly.
  const next = inc.build('during', raw);
  assert.equal(next.fullRebuild, false);
  assert.equal(text(next), JSON.stringify(raw));
  if (save === undefined) delete process.env.DB_REBUILD_SLICE_MS; else process.env.DB_REBUILD_SLICE_MS = save;
});

test('db object swapped mid-rebuild → not committed', async () => {
  const raw = makeSyntheticDb(2, 5);
  inc.track('swap2', raw);
  const p = inc.buildAsync('swap2', raw, { forceFull: true });
  const other = { batches: [], auditLog: [] };
  inc.noteIdentity('swap2', other);
  const b = await p;
  assert.equal(b.committed, false);
  const n = inc.build('swap2', other);
  assert.equal(n.fullRebuild, true);
  assert.equal(text(n), JSON.stringify(other));
});

test('large synthetic DB: async rebuild keeps event-loop lag low; sync does not', async () => {
  const MB = parseInt(process.env.NB_TEST_MB || '60', 10);
  const raw = makeSyntheticDb(MB, 11);
  inc.track('lag', raw);
  let t = Date.now();
  const sync = inc.build('lag', raw, { forceFull: true });
  const syncMs = Date.now() - t;
  const stop = lagProbe();
  t = Date.now();
  const a = await inc.buildAsync('lag', raw, { forceFull: true });
  const asyncMs = Date.now() - t;
  const maxLag = stop();
  console.log(`# ${MB} MB: sync rebuild blocked ${syncMs} ms; async rebuild ${asyncMs} ms wall, max loop lag ${maxLag.toFixed(1)} ms, ${a.yields} yields`);
  assert.equal(inc.partsBytes(a.parts), inc.partsBytes(sync.parts));
  assert.ok(maxLag < 250, 'max lag ' + maxLag);
  if (syncMs > 500) assert.ok(maxLag < syncMs / 4);
});
