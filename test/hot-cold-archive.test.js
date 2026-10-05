// Hot/cold order archive. Pure functions plus temp-dir files. No server.
//
// The floor scan path rewrites the whole tenant db.json. Settled history
// older than the window moves into archive/cold, and a later stringify of
// the hot db must not touch those files. Open warehouse work never moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hotCold = require('../lib/hot-cold-archive');

const NOW = new Date('2026-10-05T00:00:00.000Z');
const DAY = 86400000;
const OLD = new Date(NOW.getTime() - 29 * DAY).toISOString();
const RECENT = new Date(NOW.getTime() - 10 * DAY).toISOString();
const READ = { HOT_COLD_ARCHIVE: 'read' };

function order(n, extra) {
  return Object.assign({ order_number: n, customer_name: 'Buyer', delivery_address: '1 Road', tel: '90000000' }, extra);
}
function states(map) {
  const s = Object.create(null);
  for (const [k, v] of Object.entries(map)) s[k] = v;
  return s;
}
function done(at, scanned) {
  const st = { status: 'done', endTime: at };
  if (scanned) st.scanned = scanned;
  return st;
}
function batch(id, orders, orderStates, extra) {
  return Object.assign({
    id, client_name: 'BETIME', uploaded_at: OLD, orders, orderStates,
  }, extra);
}
function planOf(db) {
  return hotCold.planArchive(db, { now: NOW, windowDays: 28 });
}
function reasons(plan) {
  return plan.move.map(b => b.id);
}
function keptReason(db, id) {
  const cutoff = planOf(db).cutoffIso;
  return hotCold.batchDecision(db.batches.find(b => b.id === id), cutoff).reason;
}
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hot-cold-'));
}
function mtime(file) {
  return fs.statSync(file).mtimeMs;
}
function age(file) {
  const past = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(file, past, past);
}

test('open work, mixed batches, undated completions and empty batches stay hot', () => {
  const db = { batches: [
    batch('open-pending', [order('P1')], states({ P1: { status: 'pending' } })),
    batch('open-processing', [order('P2')], states({ P2: { status: 'processing', scanned: { SKU: 1 } } })),
    batch('open-unknown', [order('P3')], states({ P3: { status: 'mystery' } })),
    batch('open-missing', [order('P4')], states({})),
    batch('mixed', [order('M1'), order('M2')], states({
      M1: done(OLD),
      M2: { status: 'pending' },
    })),
    batch('undated-done', [order('U1')], states({ U1: { status: 'done' } })),
    batch('undated-cancel', [order('U2')], states({ U2: { status: 'unprocessed' } })),
    batch('empty', [], states({})),
  ]};
  const plan = planOf(db);
  assert.deepEqual(reasons(plan), []);
  assert.equal(keptReason(db, 'open-pending'), 'open-work');
  assert.equal(keptReason(db, 'open-processing'), 'open-work');
  assert.equal(keptReason(db, 'open-unknown'), 'open-work');
  assert.equal(keptReason(db, 'open-missing'), 'open-work');
  assert.equal(keptReason(db, 'mixed'), 'open-work');
  assert.equal(keptReason(db, 'undated-done'), 'undated');
  assert.equal(keptReason(db, 'undated-cancel'), 'undated');
  assert.equal(keptReason(db, 'empty'), 'empty-work');
});

test('age cutoff keeps a recent settlement and a batch whose newest clock is inside the window', () => {
  const db = { batches: [
    batch('young', [order('Y1')], states({ Y1: done(RECENT) })),
    batch('mixed-age', [order('A1'), order('A2')], states({
      A1: done(OLD),
      A2: done(RECENT),
    })),
    batch('old-cancel', [order('C1')], states({
      C1: { status: 'unprocessed', unprocessed_at: OLD },
    })),
  ]};
  const plan = planOf(db);
  assert.deepEqual(reasons(plan), ['old-cancel']);
  assert.equal(keptReason(db, 'young'), 'recent');
  assert.equal(keptReason(db, 'mixed-age'), 'recent');
  assert.equal(hotCold.batchDecision(db.batches[2], plan.cutoffIso).reason, 'settled');
});

test('a completed order that was scanned still moves once it is older than the window', () => {
  const db = { batches: [
    batch('picked', [order('S1')], states({ S1: done(OLD, { SKU: 4 }) })),
  ]};
  const plan = planOf(db);
  assert.deepEqual(reasons(plan), ['picked']);
  assert.equal(hotCold.batchDecision(db.batches[0], plan.cutoffIso).reason, 'settled');
});

test('reference copies move only when settled and older than the window', () => {
  const ref = (id, uploaded, orderStates, statusOrders) => batch(id, statusOrders, orderStates, {
    reference_only: true, uploaded_at: uploaded, client_name: 'Betime Online',
  });
  const db = { batches: [
    ref('ref-recent', RECENT, states({ R1: { status: 'pending' } }), [order('R1')]),
    ref('ref-old', OLD, states({ R2: { status: 'pending' } }), [order('R2', { waybill_number: 'TXSGD03900001' })]),
    ref('ref-processing', OLD, states({ R3: { status: 'processing' } }), [order('R3')]),
    ref('ref-scanned', OLD, states({ R4: { status: 'pending', scanned: { SKU: 1 } } }), [order('R4')]),
    ref('ref-done', OLD, states({ R5: done(OLD) }), [order('R5')]),
    ref('ref-unknown', OLD, states({ R6: { status: 'holding' } }), [order('R6')]),
  ]};
  const plan = planOf(db);
  assert.equal(plan.referencePolicy, 'window');
  assert.deepEqual(reasons(plan).sort(), ['ref-done', 'ref-old']);
  assert.equal(keptReason(db, 'ref-recent'), 'reference-recent');
  assert.equal(keptReason(db, 'ref-processing'), 'reference-open');
  assert.equal(keptReason(db, 'ref-unknown'), 'reference-open');
  assert.equal(keptReason(db, 'ref-scanned'), 'reference-scanned');
});

test('all_settled moves settled reference copies of any age and leaves work on the window', () => {
  const ref = (id, uploaded, orderStates, statusOrders) => batch(id, statusOrders, orderStates, {
    reference_only: true, uploaded_at: uploaded, client_name: 'Betime Online',
  });
  const db = { batches: [
    ref('ref-recent', RECENT, states({ R1: { status: 'pending' } }), [order('R1', { waybill_number: 'TXSGD03911111' })]),
    ref('ref-done-young', RECENT, states({ R2: done(RECENT) }), [order('R2')]),
    ref('ref-undated', '', states({ R3: { status: 'unprocessed', unprocessed_at: RECENT } }), [order('R3')]),
    ref('ref-processing', RECENT, states({ R4: { status: 'processing' } }), [order('R4')]),
    ref('ref-scanned', RECENT, states({ R5: { status: 'pending', scanned: { SKU: 2 } } }), [order('R5')]),
    ref('ref-unknown', OLD, states({ R6: { status: 'holding' } }), [order('R6')]),
    ref('ref-scanned-old', OLD, states({ R7: { status: 'done', endTime: OLD, scanned: { SKU: 1 } } }), [order('R7')]),
    batch('young-work', [order('Y1')], states({ Y1: done(RECENT) })),
    batch('open-work', [order('O1')], states({ O1: { status: 'pending' } })),
    batch('old-work', [order('W1')], states({ W1: done(OLD) })),
  ]};
  const windowed = planOf(db);
  assert.deepEqual(reasons(windowed).sort(), ['old-work']);
  assert.equal(windowed.moveReferenceBatches, 0);
  assert.equal(keptReason(db, 'ref-recent'), 'reference-recent');
  assert.equal(keptReason(db, 'ref-undated'), 'reference-recent');

  const wide = hotCold.planArchive(db, { now: NOW, windowDays: 28, referencePolicy: 'all_settled' });
  assert.equal(wide.referencePolicy, 'all_settled');
  assert.deepEqual(reasons(wide).sort(), ['old-work', 'ref-done-young', 'ref-recent', 'ref-undated']);
  assert.equal(wide.moveReferenceBatches, 3);
  assert.equal(wide.moveWorkBatches, 1);
  assert.equal(hotCold.batchDecision(db.batches.find(b => b.id === 'ref-processing'), wide.cutoffIso, 'all_settled').reason, 'reference-open');
  assert.equal(hotCold.batchDecision(db.batches.find(b => b.id === 'ref-scanned'), wide.cutoffIso, 'all_settled').reason, 'reference-scanned');
  assert.equal(hotCold.batchDecision(db.batches.find(b => b.id === 'ref-unknown'), wide.cutoffIso, 'all_settled').reason, 'reference-open');
  assert.equal(hotCold.batchDecision(db.batches.find(b => b.id === 'ref-scanned-old'), wide.cutoffIso, 'all_settled').reason, 'reference-scanned');
  assert.equal(hotCold.batchDecision(db.batches.find(b => b.id === 'young-work'), wide.cutoffIso, 'all_settled').reason, 'recent');
  assert.equal(hotCold.batchDecision(db.batches.find(b => b.id === 'open-work'), wide.cutoffIso, 'all_settled').reason, 'open-work');

  const summary = hotCold.summarisePlan(wide, 'read');
  assert.equal(summary.referencePolicy, 'all_settled');
  assert.equal(summary.moveReferenceBatches, 3);
  assert.match(summary.note, /any age/);
  assert.match(summary.note, /Nothing was written/);
});

test('a reference archived by all_settled is still a read-only history hit', () => {
  const root = tmp();
  const dir = hotCold.coldDir(root);
  const db = { batches: [
    batch('ref-young', [order('171174129789495', { waybill_number: 'TXSGD03922222', issue_no: 'GI-144900' })], states({
      '171174129789495': { status: 'pending' },
    }), { reference_only: true, uploaded_at: RECENT, client_name: 'Betime Online' }),
    batch('work-young', [order('GI-KEEP')], states({ 'GI-KEEP': { status: 'pending' } }), { uploaded_at: RECENT }),
  ]};
  const plan = hotCold.planArchive(db, { now: NOW, windowDays: 28, referencePolicy: 'all_settled' });
  const applied = hotCold.applyPlan(dir, db, plan);
  assert.equal(applied.movedBatches, 1);
  assert.deepEqual(db.batches.map(b => b.id), ['work-young']);
  const hit = hotCold.lookupWhenReadable(READ, root, 'TXSGD03922222');
  assert.equal(hit.order_number, '171174129789495');
  assert.equal(hit.reference_only, true);
  assert.equal(hit.archived, true);
  assert.equal(hit.archive_tier, 'cold');
  assert.match(hit.message, /channel reference/);
  assert.match(hit.message, /not open for scanning/);
  assert.equal(hotCold.lookupWhenReadable(READ, root, 'gi-144900').issue_no, 'GI-144900');
  assert.equal(hotCold.searchWhenReadable(READ, root, '171174129789495')[0].client_name, 'Betime Online');
  assert.equal(hotCold.lookupWhenReadable({ HOT_COLD_ARCHIVE: 'off' }, root, 'TXSGD03922222'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the reference policy defaults to the window and only all_settled widens it', () => {
  assert.equal(hotCold.referencePolicyFromEnv({}), 'window');
  assert.equal(hotCold.referencePolicyFromEnv({ HOT_COLD_ARCHIVE_REFERENCE: 'true' }), 'window');
  assert.equal(hotCold.referencePolicyFromEnv({ HOT_COLD_ARCHIVE_REFERENCE: '1' }), 'window');
  assert.equal(hotCold.referencePolicyFromEnv({ HOT_COLD_ARCHIVE_REFERENCE: 'on' }), 'window');
  assert.equal(hotCold.referencePolicyFromEnv({ HOT_COLD_ARCHIVE_REFERENCE: 'ALL_SETTLED' }), 'all_settled');
  assert.deepEqual(hotCold.resolveReferencePolicy(undefined, {}), { policy: 'window' });
  assert.deepEqual(hotCold.resolveReferencePolicy('', { HOT_COLD_ARCHIVE_REFERENCE: 'all_settled' }), { policy: 'all_settled' });
  assert.deepEqual(hotCold.resolveReferencePolicy('window', { HOT_COLD_ARCHIVE_REFERENCE: 'all_settled' }), { policy: 'window' });
  assert.deepEqual(hotCold.resolveReferencePolicy('all_settled', {}), { policy: 'all_settled' });
  assert.match(hotCold.resolveReferencePolicy('yes', {}).error, /window/);
});

test('lookup finds an archived order by number, waybill, GI and leading zeros, and ranks like the live scan bar', () => {
  const root = tmp();
  const dir = hotCold.coldDir(root);
  const db = { batches: [
    batch('work-old', [
      order('GI-141037', { waybill_number: 'LZSGD1015379600', issue_no: '0012345678', po_number: 'PO-900', pick_ticket: '550983' }),
    ], states({ 'GI-141037': done(OLD, { SKU: 2 }) })),
    batch('work-pending-gi', [
      order('GI-141037', { issue_no: 'GI-141037' }),
    ], states({ 'GI-141037': { status: 'pending' } }), { uploaded_at: RECENT }),
    batch('plain-pending', [order('ORD-77')], states({ 'ORD-77': { status: 'pending' } })),
    batch('plain-done', [order('ORD-77')], states({ 'ORD-77': done(OLD) })),
    batch('ref-twin', [order('171067267872131', { waybill_number: 'TXSGD03900002' })], states({
      '171067267872131': { status: 'pending' },
    }), { reference_only: true, client_name: 'Betime Online' }),
    batch('work-twin', [order('GI-141936', { waybill_number: 'TXSGD03900002' })], states({
      'GI-141936': done(OLD),
    })),
  ]};
  // The pending GI twin is open work, so it stays hot. Archive only the settled ones.
  const moving = { batches: db.batches.filter(b => planOf({ batches: [b] }).move.length) };
  const plan = planOf(moving);
  hotCold.applyPlan(dir, moving, plan);
  assert.equal(moving.batches.length, 0);

  const byNum = hotCold.lookupWhenReadable(READ, root, 'GI-141037');
  assert.equal(byNum.order_number, 'GI-141037');
  assert.equal(byNum.archived, true);
  assert.equal(byNum.scanned, undefined);
  assert.match(byNum.message, /not open for scanning/);

  const byWb = hotCold.lookupWhenReadable(READ, root, 'lzs gd1015379600'.replace(' ', ''));
  assert.equal(byWb.waybill_number, 'LZSGD1015379600');
  assert.equal(hotCold.lookupWhenReadable(READ, root, '550983').pick_ticket, '550983');
  assert.equal(hotCold.lookupWhenReadable(READ, root, '12345678').issue_no, '0012345678');
  assert.equal(hotCold.lookupWhenReadable(READ, root, '0012345678').order_number, 'GI-141037');

  // Ranking is the same rule as the live scan bar. A GI prefers the copy
  // that was worked; a recycled plain number prefers the live one; work
  // beats a reference twin. Lower rank wins.
  const gi = hotCold.pickLookup([
    { batchId: 'untouched', order_number: 'GI-141037', scan_status: 'pending' },
    { batchId: 'worked', order_number: 'GI-141037', scan_status: 'done' },
  ], 'GI-141037');
  assert.equal(gi.batchId, 'worked');
  const recycled = hotCold.pickLookup([
    { batchId: 'plain-done', order_number: 'ORD-77', scan_status: 'done' },
    { batchId: 'plain-pending', order_number: 'ORD-77', scan_status: 'pending' },
  ], 'ORD-77');
  assert.equal(recycled.batchId, 'plain-pending');

  const twin = hotCold.lookupWhenReadable(READ, root, 'TXSGD03900002');
  assert.equal(twin.order_number, 'GI-141936');
  assert.equal(twin.reference_only, false);

  const refOnly = hotCold.lookupWhenReadable(READ, root, '171067267872131');
  assert.equal(refOnly.reference_only, true);
  assert.match(refOnly.message, /channel reference/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('apply shrinks the hot db, a second apply is a no-op, and stringifying hot does not rewrite cold', () => {
  const root = tmp();
  const dir = hotCold.coldDir(root);
  const db = { batches: [
    batch('move-me', [order('MV1', { waybill_number: 'LZSGD1019999999' })], states({ MV1: done(OLD) })),
    batch('keep-me', [order('KP1')], states({ KP1: { status: 'pending' } })),
  ]};
  const plan = planOf(db);
  const first = hotCold.applyPlan(dir, db, plan);
  assert.equal(first.noop, false);
  assert.equal(first.movedBatches, 1);
  assert.deepEqual(db.batches.map(b => b.id), ['keep-me']);
  assert.equal(JSON.stringify(db).includes('move-me'), false);
  const shard = path.join(dir, 'batches-2026-09.json');
  assert.equal(fs.existsSync(shard), true);
  assert.match(fs.readFileSync(shard, 'utf8'), /move-me/);

  age(shard);
  age(path.join(dir, 'index.json'));
  const shardAt = mtime(shard);
  const indexAt = mtime(path.join(dir, 'index.json'));
  const second = hotCold.applyPlan(dir, db, planOf(db));
  assert.equal(second.noop, true);
  assert.equal(mtime(shard), shardAt);
  assert.equal(mtime(path.join(dir, 'index.json')), indexAt);
  JSON.stringify(db);
  assert.equal(mtime(shard), shardAt);
  assert.equal(mtime(path.join(dir, 'index.json')), indexAt);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a shard already holding the batch is not rewritten, and a missing index still finds the order', () => {
  const root = tmp();
  const dir = hotCold.coldDir(root);
  const moved = batch('crash', [order('CR1')], states({ CR1: done(OLD) }));
  fs.mkdirSync(dir, { recursive: true });
  const shard = path.join(dir, hotCold.shardFileName(moved));
  hotCold.atomicWrite(shard, [moved]);
  age(shard);
  const shardAt = mtime(shard);
  const db = { batches: [moved, batch('live', [order('LV1')], states({ LV1: { status: 'processing' } }))] };
  const result = hotCold.applyPlan(dir, db, planOf(db));
  assert.equal(result.movedBatches, 1);
  assert.equal(mtime(shard), shardAt);
  assert.deepEqual(db.batches.map(b => b.id), ['live']);
  assert.equal(hotCold.lookupWhenReadable(READ, root, 'CR1').order_number, 'CR1');

  fs.unlinkSync(path.join(dir, 'index.json'));
  assert.equal(hotCold.lookupWhenReadable(READ, root, 'CR1').batchId, 'crash');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the feature flag defaults off, and only read or on answers from cold', () => {
  assert.equal(hotCold.modeFromEnv({}), 'off');
  assert.equal(hotCold.modeFromEnv({ HOT_COLD_ARCHIVE: 'true' }), 'off');
  assert.equal(hotCold.modeFromEnv({ HOT_COLD_ARCHIVE: '1' }), 'off');
  assert.equal(hotCold.modeFromEnv({ HOT_COLD_ARCHIVE: 'ON' }), 'on');
  assert.equal(hotCold.readsEnabled(hotCold.modeFromEnv({ HOT_COLD_ARCHIVE: 'read' })), true);
  assert.equal(hotCold.readsEnabled(hotCold.modeFromEnv({ HOT_COLD_ARCHIVE: 'on' })), true);
  assert.equal(hotCold.readsEnabled('off'), false);
  assert.equal(hotCold.movePermitted('on'), true);
  assert.equal(hotCold.movePermitted('read'), false);
  assert.equal(hotCold.movePermitted('off'), false);
  assert.equal(hotCold.windowDaysFromEnv({}), 28);
  assert.equal(hotCold.windowDaysFromEnv({ HOT_COLD_WINDOW_DAYS: '14' }), 14);

  const root = tmp();
  const db = { batches: [batch('flag', [order('FL1')], states({ FL1: done(OLD) }))] };
  const plan = planOf(db);
  assert.equal(plan.move.length, 1);
  hotCold.applyPlan(hotCold.coldDir(root), db, plan);
  assert.deepEqual(hotCold.searchWhenReadable({ HOT_COLD_ARCHIVE: 'off' }, root, 'FL1'), []);
  assert.equal(hotCold.lookupWhenReadable({}, root, 'FL1'), null);
  assert.equal(hotCold.readBatchWhenReadable({ HOT_COLD_ARCHIVE: 'true' }, root, 'flag'), null);
  assert.equal(hotCold.lookupWhenReadable(READ, root, 'FL1').order_number, 'FL1');
  assert.equal(hotCold.readBatchWhenReadable({ HOT_COLD_ARCHIVE: 'on' }, root, 'flag').id, 'flag');
  assert.deepEqual(hotCold.searchWhenReadable(READ, root, 'fl'), []);
  assert.equal(hotCold.searchWhenReadable(READ, root, 'FL1')[0].order_number, 'FL1');
  fs.rmSync(root, { recursive: true, force: true });
});

test('restore merges cold back without duplicating, and retire is a separate step', () => {
  const root = tmp();
  const dir = hotCold.coldDir(root);
  const open = batch('still-open', [order('OP1')], states({ OP1: { status: 'pending' } }));
  const db = { batches: [
    batch('gone', [order('GN1')], states({ GN1: done(OLD) })),
    open,
  ]};
  hotCold.applyPlan(dir, db, planOf(db));
  assert.deepEqual(db.batches.map(b => b.id), ['still-open']);
  const back = hotCold.restoreAll(dir, db);
  assert.equal(back.restored, 1);
  assert.deepEqual(back.ids, ['gone']);
  assert.deepEqual(db.batches.map(b => b.id), ['still-open', 'gone']);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(hotCold.restoreAll(dir, db).restored, 0);
  const retired = hotCold.retireCold(root);
  assert.equal(retired.retired, true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(hotCold.lookupWhenReadable(READ, root, 'GN1'), null);
  assert.equal(db.batches[0].id, 'still-open');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.dirname(retired.to), { recursive: true, force: true });
});

test('prototype-shaped order numbers are not written into the index and are still findable by a hay scan', () => {
  const root = tmp();
  const dir = hotCold.coldDir(root);
  const st = Object.create(null);
  st['__proto__'] = done(OLD);
  st['constructor'] = done(OLD);
  const orders = [
    { order_number: '__proto__', customer_name: 'A', delivery_address: 'B', tel: '1' },
    { order_number: 'constructor', customer_name: 'C', delivery_address: 'D', tel: '2' },
  ];
  const db = { batches: [batch('proto', orders, st)] };
  hotCold.applyPlan(dir, db, planOf(db));
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.byOrder, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.byOrder, 'constructor'), false);
  assert.equal(hotCold.lookupWhenReadable(READ, root, '__proto__').order_number, '__proto__');
  assert.equal(hotCold.lookupWhenReadable(READ, root, 'constructor').order_number, 'constructor');
  fs.rmSync(root, { recursive: true, force: true });
});

test('personal-data redaction on a cold shard is dry-run safe and only touches old completed orders', () => {
  const cutoffMs = NOW.getTime() - 90 * DAY;
  const ancient = new Date(cutoffMs - DAY).toISOString();
  const batches = [batch('pii', [
    order('OLD1', { customer_name: 'Ann', delivery_address: '9 Lane', tel: '111' }),
    order('NEW1', { customer_name: 'Bob', delivery_address: '8 Lane', tel: '222' }),
    order('PEND', { customer_name: 'Cara', delivery_address: '7 Lane', tel: '333' }),
  ], states({
    OLD1: done(ancient),
    NEW1: done(RECENT),
    PEND: { status: 'pending' },
  }))];
  const fields = ['customer_name', 'delivery_address', 'tel'];
  const preview = hotCold.redactSettledPersonal(batches, cutoffMs, fields, true);
  assert.equal(preview.dirty, false);
  assert.equal(preview.orders, 1);
  assert.equal(preview.fieldHits, 3);
  assert.equal(batches[0].orders[0].customer_name, 'Ann');
  assert.equal(batches[0].orders[0].pii_purged_at, undefined);

  const live = hotCold.redactSettledPersonal(batches, cutoffMs, fields, false);
  assert.equal(live.dirty, true);
  assert.equal(batches[0].orders[0].customer_name, '');
  assert.equal(batches[0].orders[0].delivery_address, '');
  assert.equal(batches[0].orders[0].tel, '');
  assert.ok(batches[0].orders[0].pii_purged_at);
  assert.equal(batches[0].orders[1].customer_name, 'Bob');
  assert.equal(batches[0].orders[2].customer_name, 'Cara');
  assert.equal(hotCold.redactSettledPersonal(batches, cutoffMs, fields, false).orders, 0);
});

test('writeDb does not know about the cold archive, and the server consults it on read', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /hotCold\.withEachShard/);
  assert.match(src, /lookupWhenReadable/);
  assert.equal((src.match(/hotCold\.applyPlan/g) || []).length, 1);
  assert.match(src, /resolveReferencePolicy/);
  assert.equal(src.includes('setInterval') && src.slice(src.indexOf('Hot/cold order archive'), src.indexOf('Order claiming')).includes('setInterval'), false);
  const start = src.indexOf('function writeDb(');
  const next = src.indexOf('\nfunction ', start + 1);
  const body = src.slice(start, next);
  assert.equal(body.includes('hotCold'), false);
  assert.equal(body.includes('archive/cold'), false);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /data\.archived/);
  const cli = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'hot-cold-archive.js'), 'utf8');
  assert.match(cli, /resolveReferencePolicy/);
  assert.match(cli, /--server-stopped/);
});
