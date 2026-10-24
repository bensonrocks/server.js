// MANIFEST — carrier handover: create / lock / no double inclusion / e-sign /
// public QR acknowledge / token security / demo hard-off / orders untouched.
// Boots the real server.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = process.env.IDEALONE_SERVER || path.join(ROOT, 'server.js');
const KEY = 'test-master-key-' + process.pid;
let B;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitUp(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).status < 500) return; } catch {}
    await sleep(500);
  }
  throw new Error('server did not come up: ' + url);
}
const KJ = { 'x-master-key': KEY, 'Content-Type': 'application/json' };
async function api(method, p, headers, body) {
  const r = await fetch(B + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await J(r) };
}
const { normalizeCarrier } = require('../lib/manifest');

const done = (min, op = 'packer1') => ({ status: 'done', operator: op, startTime: `2026-10-24T0${min}:00:00.000Z`, endTime: `2026-10-24T0${min}:05:00.000Z`, scanned: {} });
const SEED = { batches: [
  { id: 'b1', client_name: 'BETIME', uploaded_at: '2026-10-24T00:00:00Z', orders: [
    { order_number: 'SPX-1', waybill_number: 'SPXSG001', carrier: 'SPX', lines: [{ sku: 'A', qty: 2 }] },
    { order_number: 'SPX-2', waybill_number: 'SPXSG002', carrier: 'Shopee Xpress', lines: [{ sku: 'A', qty: 1 }] },
    { order_number: 'SPX-3', waybill_number: 'SPXSG003', carrier: 'SPX Express', lines: [{ sku: 'A', qty: 1 }] },
    { order_number: 'LEX-1', waybill_number: 'LXAD001', carrier: 'TracX', lines: [{ sku: 'B', qty: 3 }] },
    { order_number: 'NJV-1', waybill_number: 'NVSG001', carrier: 'Ninja Van', lines: [{ sku: 'B', qty: 1 }] },
    { order_number: 'SPX-OPEN', waybill_number: 'SPXSG009', carrier: 'SPX', lines: [{ sku: 'A', qty: 1 }] },
    { order_number: 'SPX-CXL', waybill_number: 'SPXSG010', carrier: 'SPX', lines: [{ sku: 'A', qty: 1 }] },
  ], orderStates: { 'SPX-1': done(1), 'SPX-2': done(2), 'SPX-3': done(3), 'LEX-1': done(4), 'NJV-1': done(5),
    'SPX-OPEN': { status: 'processing', scanned: {} },
    'SPX-CXL': { ...done(6), client_cancelled: { at: '2026-10-24T07:00:00Z' } } } },
  { id: 'b2', client_name: 'MAYER', uploaded_at: '2026-10-24T00:00:00Z', orders: [
    { order_number: 'MY-1', waybill_number: 'SPXSG100', carrier: 'spx express', lines: [{ sku: 'M', qty: 5 }] },
  ], orderStates: { 'MY-1': done(7) } },
], inbound: [], transport: [], drivers: [], fixSchedules: {} };

async function boot(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-mf-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(SEED));
  const port = await freePort();
  const log = fs.openSync(path.join(dir, 'server.log'), 'a');
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, MASTER_KEY: KEY, DEMO_MODE: '', ...extraEnv },
    stdio: ['ignore', log, log] });
  const base = `http://127.0.0.1:${port}`;
  await waitUp(base + '/api/version'); await sleep(800);
  return { dir, proc, base };
}
async function stop(s) {
  if (!s) return;
  s.proc.kill('SIGTERM'); await new Promise(r => { s.proc.once('exit', r); setTimeout(r, 5000); });
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
}
let S, adminTok, staffTok, offTok;
const T = t => ({ 'x-auth-token': t, 'x-master-key': '', 'Content-Type': 'application/json' });
const PUB = { 'Content-Type': 'application/json' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let seedStates;

before(async () => {
  S = await boot(); B = S.base;
  for (const id of ['mfadmin', 'staff1', 'nomf']) {
    const r = await api('POST', '/api/master/users', KJ, { id, name: id, password: 'pw-' + id, role: 'admin' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  await api('PUT', '/api/master/users/mfadmin/features', KJ, { features: { administrator: true } });
  await api('PUT', '/api/master/users/nomf/features', KJ, { features: { manifest: false } });
  const login = async id => (await api('POST', '/api/auth/login', PUB, { id, password: 'pw-' + id })).body.token;
  adminTok = await login('mfadmin'); staffTok = await login('staff1'); offTok = await login('nomf');
  seedStates = JSON.stringify((await api('GET', '/api/batches', T(staffTok))).body.map(b => b.orderStates));
});
after(() => stop(S));

test('carrier names normalise to one tile', () => {
  assert.equal(normalizeCarrier('Shopee Xpress'), 'SPX Express');
  assert.equal(normalizeCarrier('spx'), 'SPX Express');
  assert.equal(normalizeCarrier('TracX'), 'TracX (Lazada)');
  assert.equal(normalizeCarrier('LEX MY'), 'TracX (Lazada)');
  assert.equal(normalizeCarrier('Ninja Van SG'), 'Ninja Van');
  assert.equal(normalizeCarrier(''), 'Unassigned');
});

test('feature tick gates access; no login refused', async () => {
  assert.equal((await api('GET', '/api/manifests/status', T(staffTok))).body.visible, true);
  assert.equal((await api('GET', '/api/manifests/status', T(offTok))).body.visible, false);
  assert.equal((await api('GET', '/api/manifests/carriers', T(offTok))).status, 403);
  assert.ok([401, 403].includes((await api('GET', '/api/manifests/carriers', PUB)).status));
});

test('carrier tiles: only done, not-cancelled orders; counts; client filter', async () => {
  const r = await api('GET', '/api/manifests/carriers', T(staffTok));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.carriers.map(c => [c.carrier, c.orders]));
  assert.deepEqual(by, { 'SPX Express': 4, 'TracX (Lazada)': 1, 'Ninja Van': 1 });
  const f = await api('GET', '/api/manifests/carriers?client=MAYER', T(staffTok));
  assert.deepEqual(f.body.carriers.map(c => [c.carrier, c.orders]), [['SPX Express', 1]]);
  const l = await api('GET', '/api/manifests/ready?carrier=' + encodeURIComponent('SPX Express'), T(staffTok));
  assert.deepEqual(l.body.rows.map(x => x.order), ['SPX-1', 'SPX-2', 'SPX-3', 'MY-1']);
  assert.equal(l.body.rows[0].qty, 2); assert.deepEqual(l.body.rows[0].waybills, ['SPXSG001']);
});

let mf1;
test('create freezes a numbered draft; no double inclusion; not-ready refused', async () => {
  const bad = await api('POST', '/api/manifests', T(staffTok), { carrier: 'SPX Express', orders: ['SPX-1', 'SPX-OPEN'] });
  assert.equal(bad.status, 400); assert.deepEqual(bad.body.notReady, ['SPX-OPEN']);
  const wrongCarrier = await api('POST', '/api/manifests', T(staffTok), { carrier: 'SPX Express', orders: ['LEX-1'] });
  assert.equal(wrongCarrier.status, 400);
  const r = await api('POST', '/api/manifests', T(staffTok), { carrier: 'SPX Express', orders: ['SPX-1', 'SPX-2'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  mf1 = r.body.manifest;
  assert.match(mf1.no, /^MF-\d{6}-001$/);
  assert.equal(mf1.status, 'draft'); assert.equal(mf1.createdBy, 'staff1');
  assert.deepEqual(mf1.totals, { orders: 2, parcels: 2, qty: 3 });
  assert.ok(mf1.qrSvg.startsWith('<svg')); assert.match(mf1.ackUrl, /manifest-ack\.html#[A-Za-z0-9_-]{32}$/);
  const again = await api('POST', '/api/manifests', T(staffTok), { carrier: 'SPX Express', orders: ['SPX-2', 'SPX-3'] });
  assert.equal(again.status, 409); assert.deepEqual(again.body.clash, [{ order: 'SPX-2', manifest: mf1.no }]);
  const l = await api('GET', '/api/manifests/ready?carrier=' + encodeURIComponent('SPX Express'), T(staffTok));
  assert.deepEqual(l.body.rows.map(x => x.order), ['SPX-3', 'MY-1']);
  const r2 = await api('POST', '/api/manifests', T(staffTok), { carrier: 'SPX Express', orders: ['SPX-3'] });
  assert.match(r2.body.manifest.no, /-002$/);
});

test('history search by manifest no, order no and tracking; list never leaks token or signature', async () => {
  for (const q of [mf1.no, 'SPX-2', 'SPXSG001']) {
    const r = await api('GET', '/api/manifests?q=' + q, T(staffTok));
    assert.ok(r.body.manifests.some(m => m.no === mf1.no), q);
  }
  const all = await api('GET', '/api/manifests', T(staffTok));
  const tok = mf1.ackUrl.split('#')[1];
  assert.ok(!JSON.stringify(all.body).includes(tok));
});

test('QR acknowledge: public, minimal data, locks, staff sees who and when', async () => {
  const tok = mf1.ackUrl.split('#')[1];
  const g = await api('GET', '/api/public/manifest-ack/' + tok, {});
  assert.equal(g.status, 200);
  assert.deepEqual(Object.keys(g.body).sort(), ['ackAt', 'ackName', 'acknowledged', 'carrier', 'createdAt', 'no', 'orders', 'parcels', 'status']);
  assert.ok(!JSON.stringify(g.body).includes('BETIME') && !JSON.stringify(g.body).includes('SPX-1'));
  assert.equal((await api('POST', '/api/public/manifest-ack/' + tok, PUB, {})).status, 400);
  const a = await api('POST', '/api/public/manifest-ack/' + tok, { ...PUB, 'user-agent': 'DriverPhone/1.0' }, { name: 'Ali', plate: 'gbc1234x', geo: { lat: 1.33, lng: 103.7, accuracy: 20 } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.acknowledged, true); assert.equal(a.body.ackName, 'Ali');
  const again = await api('POST', '/api/public/manifest-ack/' + tok, PUB, { name: 'Someone else' });
  assert.equal(again.status, 409); assert.equal(again.body.ackName, 'Ali');
  const d = await api('GET', '/api/manifests/' + mf1.id, T(staffTok));
  assert.equal(d.body.manifest.status, 'handed_over'); assert.equal(d.body.manifest.handedOverVia, 'qr');
  assert.equal(d.body.manifest.ack.plate, 'GBC1234X'); assert.equal(d.body.manifest.ack.ua, 'DriverPhone/1.0');
  assert.deepEqual(d.body.manifest.ack.geo, { lat: 1.33, lng: 103.7, accuracy: 20 });
  assert.equal(d.body.manifest.qrSvg, '', 'no QR once locked');
  // signing a locked manifest is refused too
  assert.equal((await api('POST', '/api/manifests/' + mf1.id + '/sign', T(staffTok), { driverName: 'X', signature: PNG })).status, 409);
  // handed-over orders still never come back to the ready list
  const l = await api('GET', '/api/manifests/ready?carrier=' + encodeURIComponent('SPX Express'), T(staffTok));
  assert.ok(!l.body.rows.some(x => x.order === 'SPX-1'));
});

test('token security: wrong / malformed / other-length tokens give one generic 404', async () => {
  for (const t of ['x', 'A'.repeat(32), mf1.id, mf1.no, '../../etc', 'A'.repeat(33)]) {
    const r = await api('GET', '/api/public/manifest-ack/' + encodeURIComponent(t), {});
    assert.equal(r.status, 404, t); assert.deepEqual(r.body, { error: 'Link not valid' });
    assert.equal((await api('POST', '/api/public/manifest-ack/' + encodeURIComponent(t), PUB, { name: 'x' })).status, 404);
  }
});

test('e-sign: name + PNG required, stored, locks the manifest', async () => {
  const c = await api('POST', '/api/manifests', T(staffTok), { carrier: 'TracX (Lazada)', orders: ['LEX-1'] });
  const id = c.body.manifest.id;
  assert.equal((await api('POST', `/api/manifests/${id}/sign`, T(staffTok), { signature: PNG })).status, 400);
  assert.equal((await api('POST', `/api/manifests/${id}/sign`, T(staffTok), { driverName: 'Tan', signature: 'data:text/html;base64,PHNjcmlwdD4=' })).status, 400);
  const s = await api('POST', `/api/manifests/${id}/sign`, T(staffTok), { driverName: 'Tan', idLast4: 'S1234567A', plate: 'xy 1', signature: PNG });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.manifest.status, 'handed_over'); assert.equal(s.body.manifest.signature.image, PNG);
  assert.equal(s.body.manifest.signature.idLast4, '4567');
  assert.equal((await api('POST', `/api/manifests/${id}/sign`, T(staffTok), { driverName: 'Again', signature: PNG })).status, 409);
  const tok = c.body.manifest.ackUrl.split('#')[1];
  assert.equal((await api('POST', '/api/public/manifest-ack/' + tok, PUB, { name: 'Late' })).status, 409);
});

test('cancel is admin-only, frees the orders, locks the QR', async () => {
  const c = await api('POST', '/api/manifests', T(staffTok), { carrier: 'Ninja Van', orders: ['NJV-1'] });
  const id = c.body.manifest.id, tok = c.body.manifest.ackUrl.split('#')[1];
  assert.equal((await api('POST', `/api/manifests/${id}/cancel`, T(staffTok), {})).status, 403);
  const x = await api('POST', `/api/manifests/${id}/cancel`, T(adminTok), { reason: 'driver no-show' });
  assert.equal(x.status, 200); assert.equal(x.body.manifest.status, 'cancelled');
  assert.equal((await api('POST', '/api/public/manifest-ack/' + tok, PUB, { name: 'A' })).status, 410);
  const l = await api('GET', '/api/manifests/ready?carrier=Ninja%20Van', T(staffTok));
  assert.deepEqual(l.body.rows.map(r => r.order), ['NJV-1']);
  // a handed-over manifest can't be cancelled
  assert.equal((await api('POST', `/api/manifests/${mf1.id}/cancel`, T(adminTok), {})).status, 409);
});

test('orders are never touched: orderStates identical to the seed', async () => {
  const now = (await api('GET', '/api/batches', T(staffTok))).body.map(b => b.orderStates);
  assert.ok(seedStates.includes('SPX-1'));
  assert.equal(JSON.stringify(now), seedStates);
  // handover lives only in manifests.json
  assert.ok(fs.existsSync(path.join(S.dir, 'manifests.json')));
});

test('public acknowledge endpoint is rate-limited', async () => {
  let got429 = false;
  for (let i = 0; i < 40 && !got429; i++) got429 = (await api('GET', '/api/public/manifest-ack/' + 'B'.repeat(32), {})).status === 429;
  assert.ok(got429);
});

test('DEMO_MODE: manifest is hard-off and hidden', async () => {
  const D = await boot({ DEMO_MODE: '1' });
  try {
    const r = await fetch(D.base + '/api/manifests/status', { headers: { 'x-master-key': KEY } });
    assert.deepEqual(await r.json(), { visible: false, admin: false, demo: true });
    assert.equal((await fetch(D.base + '/api/manifests/carriers', { headers: { 'x-master-key': KEY } })).status, 403);
    assert.equal((await fetch(D.base + '/api/public/manifest-ack/' + 'A'.repeat(32))).status, 403);
  } finally { await stop(D); }
});
