// DRIVER SCAN-TO-CLOSE: unit rules (lib/driver-scan.js) + a booted-server
// run through POST /api/driver/scan-close with the feature flag on and off.
'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), crypto = require('crypto');
const { spawn } = require('child_process');
const ds = require('../lib/driver-scan');

const mk = () => ([
  { id: 'T1', referenceId: 'ORD-1', assignedDriver: 'D1', routeNum: 1, stopSeq: 1, status: 'in-transit' },
  { id: 'T2', referenceId: 'ORD-2', assignedDriver: 'D1', routeNum: 1, stopSeq: 2, status: 'in-transit' },
  { id: 'T3', referenceId: 'ORD-3', assignedDriver: 'D1', routeNum: 2, stopSeq: 1, status: 'in-transit' },
  { id: 'T4', referenceId: 'ORD-4', assignedDriver: 'D2', routeNum: 1, stopSeq: 1, status: 'in-transit' },
  { id: 'T5', referenceId: 'ORD-5', assignedDriver: 'D1', routeNum: 1, stopSeq: 3, status: 'confirmed', driverAcceptedAt: 'x' },
]);
const orders = { 'ORD-1': { order_number: 'ORD-1', waybill_number: 'SPX123', issue_no: 'GI-77' } };
const Q = v => 'IO-DLV:' + v;
const run = (transport, code, anchor = 'T1', driverId = 'D1') =>
  ds.scanClose({ transport, driverId, anchorJobId: anchor, code: code.startsWith('RAW:') ? code.slice(4) : Q(code), orderFor: j => orders[j.referenceId] || null, now: new Date('2026-10-14T03:00:00Z') });

describe('lib/driver-scan', () => {
  test('order number on this job closes it, with driver/timestamp, and reports progress', () => {
    const t = mk(); const r = run(t, ' ord-2 ');
    assert.equal(r.ok, true); assert.equal(r.result, 'closed');
    const j = t.find(x => x.id === 'T2');
    assert.equal(j.status, 'delivered'); assert.equal(j.deliveredBy, 'D1'); assert.equal(j.closedBy, 'driver-scan');
    assert.equal(j.deliveredAt, '2026-10-14T03:00:00.000Z');
    assert.deepEqual(r.progress, { closed: 1, total: 3, complete: false });
  });
  test('waybill and DO number on the label match too', () => {
    let t = mk(); assert.equal(run(t, 'SPX123').job.id, 'T1');
    t = mk(); assert.equal(run(t, 'DO-GI-77').job.id, 'T1');
    t = mk(); assert.equal(run(t, 'DO-ORD-2').job.id, 'T2');
  });
  test('order on another route of mine is refused, nothing changes', () => {
    const t = mk(); const before = JSON.stringify(t); const r = run(t, 'ORD-3');
    assert.equal(r.ok, false); assert.equal(r.result, 'wrong_job'); assert.match(r.message, /Route 2/);
    assert.equal(JSON.stringify(t), before);
  });
  test("another driver's order is refused", () => {
    const t = mk(); const before = JSON.stringify(t); const r = run(t, 'ORD-4');
    assert.equal(r.result, 'wrong_job'); assert.match(r.message, /not on your job/); assert.equal(JSON.stringify(t), before);
  });
  test('raw barcode value (no QR prefix) is refused: scan the QR, not the barcode', () => {
    const t = mk(); const before = JSON.stringify(t);
    for (const c of ['RAW:ORD-2', 'RAW:SPX123', 'RAW:DO-ORD-2']) {
      const r = run(t, c); assert.equal(r.result, 'not_qr'); assert.equal(r.status, 400); assert.match(r.message, /Scan the QR code, not the barcode/);
    }
    assert.equal(JSON.stringify(t), before);
  });
  test('payload helpers', () => {
    assert.equal(ds.deliveryQrPayload('SPX123'), 'IO-DLV:SPX123');
    assert.equal(ds.parseDeliveryQr('io-dlv: ord-1 '), 'ord-1'); assert.equal(ds.parseDeliveryQr('ORD-1'), null);
  });
  test('unknown code is refused', () => {
    const t = mk(); const before = JSON.stringify(t); const r = run(t, 'NOPE-999');
    assert.equal(r.result, 'unknown'); assert.equal(r.status, 404); assert.equal(JSON.stringify(t), before);
  });
  test('already closed says so and does not rewrite', () => {
    const t = mk(); run(t, 'ORD-1'); const at = t[0].deliveredAt;
    const r = run(t, 'ORD-1'); assert.equal(r.result, 'already_closed'); assert.equal(t[0].deliveredAt, at);
  });
  test('not picked up yet is refused', () => {
    const t = mk(); const r = run(t, 'ORD-5'); assert.equal(r.result, 'not_picked_up'); assert.equal(t[4].status, 'confirmed');
  });
  test('job completes when every order on it is closed', () => {
    const t = mk(); t[4].status = 'in-transit';
    run(t, 'ORD-1'); run(t, 'ORD-2'); const r = run(t, 'ORD-5');
    assert.deepEqual(r.progress, { closed: 3, total: 3, complete: true });
  });
  test('unrouted job: scope is just that stop', () => {
    const t = [{ id: 'U1', referenceId: 'U-1', assignedDriver: 'D1', status: 'in-transit' }, { id: 'U2', referenceId: 'U-2', assignedDriver: 'D1', status: 'in-transit' }];
    assert.equal(run(t, 'U-2', 'U1').result, 'wrong_job');
    assert.equal(run(t, 'U-1', 'U1').progress.complete, true);
  });
  test('never touches warehouse/order scan state', () => {
    const o = { order_number: 'ORD-1', waybill_number: 'SPX123', status: 'pending', scanned: 0 };
    const t = mk(); const snap = JSON.stringify(o);
    ds.scanClose({ transport: t, driverId: 'D1', anchorJobId: 'T1', code: 'IO-DLV:ORD-1', orderFor: () => o });
    assert.equal(JSON.stringify(o), snap);
  });
});

// ── booted server ──
const SERVER = path.join(__dirname, '..', 'server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
async function boot(DDIR, env) {
  const PORT = await freePort(); const B = `http://127.0.0.1:${PORT}`;
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR, ...env }, stdio: ['ignore', log, log] });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/ping')).ok) return { B, child }; } catch {} await sleep(500); }
  throw new Error('server did not come up');
}
const stop = c => new Promise(r => { c.once('exit', r); c.kill('SIGTERM'); setTimeout(r, 5000); });

describe('POST /api/driver/scan-close (server)', () => {
  let DDIR, srv;
  before(async () => {
    DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-dscan-'));
    const first = await boot(DDIR, {}); await sleep(800); await stop(first.child);
    const f = path.join(DDIR, 'tenants', 'default', 'db.json');
    const db = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    const salt = crypto.randomBytes(16).toString('hex');
    db.drivers = [{ id: 'DRV-T', name: 'Test Driver', status: 'active', pinSalt: salt, pinHash: crypto.scryptSync('4321', salt, 64).toString('hex') }];
    db.transport = mk().map(j => ({ ...j, assignedDriver: j.assignedDriver === 'D1' ? 'DRV-T' : 'DRV-OTHER', shipping: { addressLine1: '1 Test Rd', zip: '123456' } }));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(db));
    srv = await boot(DDIR, { DRIVER_SCAN_CLOSE: '1' });
  });
  after(async () => { if (srv) await stop(srv.child); try { fs.rmSync(DDIR, { recursive: true, force: true }); } catch {} });

  test('flag on: closes only this job\'s order, refuses others', async () => {
    const lg = await (await fetch(srv.B + '/api/driver/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'DRV-T', pin: '4321' }) })).json();
    assert.ok(lg.token, JSON.stringify(lg));
    const H = { 'Content-Type': 'application/json', 'x-auth-token': lg.token };
    const jobs = await (await fetch(srv.B + '/api/driver/jobs', { headers: H })).json();
    assert.equal(jobs.features.scanClose, true);
    const post = b => fetch(srv.B + '/api/driver/scan-close', { method: 'POST', headers: H, body: JSON.stringify(b) });
    let r = await post({ jobId: 'T1', code: 'ORD-2' }); assert.equal(r.status, 400); assert.equal((await r.json()).result, 'not_qr');
    r = await post({ jobId: 'T1', code: 'IO-DLV:ORD-3' }); assert.equal(r.status, 409); assert.equal((await r.json()).result, 'wrong_job');
    r = await post({ jobId: 'T1', code: 'IO-DLV:ZZZ-1' }); assert.equal(r.status, 404);
    r = await post({ jobId: 'T1', code: 'IO-DLV:ORD-2' }); assert.equal(r.status, 200);
    const d = await r.json(); assert.equal(d.result, 'closed'); assert.deepEqual(d.progress, { closed: 1, total: 3, complete: false });
    r = await post({ jobId: 'T1', code: 'IO-DLV:ORD-2' }); assert.equal((await r.json()).result, 'already_closed');
    const after = await (await fetch(srv.B + '/api/driver/jobs', { headers: H })).json();
    assert.equal(after.jobs.find(j => j.id === 'T2').status, 'delivered');
    assert.equal(after.jobs.find(j => j.id === 'T3').status, 'in-transit');
    r = await fetch(srv.B + '/api/driver/scan-close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
  });
});

describe('delivery QR printed on the DO', () => {
  test('DO PDF embeds a QR image and still builds', async () => {
    const { buildDeliveryOrderPdf } = require('../lib/delivery-order');
    const buf = await buildDeliveryOrderPdf({ order: { order_number: '26516084', lines: [{ sku: 'A', qty: 1 }] }, clientName: 'T' });
    assert.equal(buf.slice(0, 5).toString(), '%PDF-');
    assert.match(buf.toString('latin1'), /\/Subtype\s*\/Image/);
  });
});
