// SURVEILLANCE — off by default, admin-only toggle/grant, masked RTSP
// passwords, keyed recorder index, order→video lookup with padding/seek,
// OBS overlay feed, DEMO_MODE hard-off, scan path unaffected. Boots the real server.
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

let DDIR, PORT, B, child;
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
const sv = require('../lib/surveillance');

// GI-151764 closed 11:02:02 SGT (03:02:02Z) at PACKING STATION 4, started 11:00:30.
const SEED = { batches: [{ id: 'b1', client_name: 'BETIME', uploaded_at: '2026-10-22T01:00:00Z',
  orders: [
    { order_number: 'GI-151764', waybill_number: 'SPX123456789', lines: [{ sku: 'SKU1', qty: 1 }] },
    { order_number: 'GI-200000', waybill_number: 'NJV999', lines: [{ sku: 'SKU1', qty: 1 }] },
    { order_number: 'GI-300000', waybill_number: 'LIVE1', lines: [{ sku: 'SKU9', qty: 2 }] },
  ],
  orderStates: {
    'GI-151764': { status: 'done', operator: 'packer4', startTime: '2026-10-22T03:00:30.000Z', endTime: '2026-10-22T03:02:02.000Z', scanned: { SKU1: 1 } },
    'GI-200000': { status: 'done', operator: 'packer9', startTime: '2026-10-22T05:00:00.000Z', endTime: '2026-10-22T05:01:00.000Z', scanned: { SKU1: 1 } },
    'GI-300000': { status: 'in_progress', operator: 'packer4', startTime: '2026-10-22T04:00:00.000Z', scanned: {} },
  } }], inbound: [], transport: [], drivers: [], fixSchedules: {} };

async function boot(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-surv-'));
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
let S, adminTok, userTok, packerTok, recKey;
const T = t => ({ 'x-auth-token': t, 'x-master-key': '', 'Content-Type': 'application/json' });

before(async () => {
  S = await boot(); B = S.base;
  for (const [id, role] of [['survadmin', 'admin'], ['staff1', 'admin'], ['packer4', 'warehouse']]) {
    const r = await api('POST', '/api/master/users', KJ, { id, name: id === 'packer4' ? 'PACKING STATION 4' : id, password: 'pw-' + id, role });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  await api('PUT', '/api/master/users/survadmin/features', KJ, { features: { administrator: true } });
  const login = async id => (await api('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { id, password: 'pw-' + id })).body.token;
  adminTok = await login('survadmin'); userTok = await login('staff1'); packerTok = await login('packer4');
});
after(() => stop(S));

test('OFF by default: status hidden for staff, every API 403, recorder/overlay 403', async () => {
  const st = await api('GET', '/api/surveillance/status', T(userTok));
  assert.deepEqual([st.status, st.body.enabled, st.body.visible], [200, false, false]);
  assert.equal((await api('GET', '/api/surveillance/lookup?q=GI-151764', T(userTok))).status, 403);
  assert.equal((await api('GET', '/api/surveillance/settings', T(userTok))).status, 403);
  assert.equal((await api('POST', '/api/public/surveillance/recordings', { 'Content-Type': 'application/json' }, { fileName: 'x', station: 'y' })).status, 403);
  assert.equal((await api('GET', '/api/public/surveillance/overlay?station=x&key=x', {})).status, 403);
});

test('only an admin can toggle / grant; non-admin is refused even when ON', async () => {
  assert.equal((await api('PUT', '/api/surveillance/settings', T(userTok), { enabled: true, grantedUsers: ['staff1'] })).status, 403);
  const r = await api('PUT', '/api/surveillance/settings', T(adminTok), { enabled: true });
  assert.deepEqual([r.status, r.body.enabled], [200, true]);
  // enabled but not granted → still 403
  assert.equal((await api('GET', '/api/surveillance/lookup?q=GI-151764', T(userTok))).status, 403);
  assert.equal((await api('GET', '/api/surveillance/status', T(userTok))).body.visible, false);
  // a granted non-admin can look up, but never touch settings
  await api('PUT', '/api/surveillance/settings', T(adminTok), { grantedUsers: ['staff1'] });
  assert.equal((await api('GET', '/api/surveillance/status', T(userTok))).body.visible, true);
  assert.equal((await api('GET', '/api/surveillance/settings', T(userTok))).status, 403);
  assert.equal((await api('POST', '/api/surveillance/cameras', T(userTok), { name: 'x', station: 'y' })).status, 403);
  assert.equal((await api('POST', '/api/surveillance/recorder-key', T(userTok))).status, 403);
});

test('camera with RTSP URL saves; password never returned', async () => {
  const r = await api('POST', '/api/surveillance/cameras', T(adminTok), { name: 'Cam 4', station: 'PACKING STATION 4',
    rtspUrl: 'rtsp://admin:S3cretPw@192.168.1.24:554/Streaming/Channels/101', folder: 'D:/OBS',
    filePattern: 'YYYY-MM-DD HH-mm-ss', tz: '+08:00', clockOffsetSec: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.camera.rtspUrl, 'rtsp://admin:****@192.168.1.24:554/Streaming/Channels/101');
  assert.equal(r.body.camera.hasPassword, true);
  const s = await api('GET', '/api/surveillance/settings', T(adminTok));
  assert.ok(!JSON.stringify(s.body).includes('S3cretPw'));
  assert.ok(!JSON.stringify(r.body).includes('S3cretPw'));
  // stored server-side
  assert.ok(fs.readFileSync(path.join(S.dir, 'surveillance.json'), 'utf8').includes('S3cretPw'));
  // re-saving the masked URL keeps the stored password
  await api('POST', '/api/surveillance/cameras', T(adminTok), { id: r.body.camera.id, rtspUrl: r.body.camera.rtspUrl });
  assert.ok(fs.readFileSync(path.join(S.dir, 'surveillance.json'), 'utf8').includes('S3cretPw'));
});

test('recorder index: key required, wrong key refused, file name parsed', async () => {
  const k = await api('POST', '/api/surveillance/recorder-key', T(adminTok));
  recKey = k.body.recorderKey; assert.ok(recKey && recKey.length >= 32);
  const body = { fileName: '2026-10-22 10-30-00.mkv', station: 'PACKING STATION 4', durationSec: 4 * 3600 };
  const P = (h) => api('POST', '/api/public/surveillance/recordings', { 'Content-Type': 'application/json', ...h }, body);
  assert.equal((await P({})).status, 401);
  assert.equal((await P({ 'x-recorder-key': 'wrong' })).status, 401);
  const ok = await P({ 'x-recorder-key': recKey });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.recording.startTime, '2026-10-22T02:30:00.000Z'); // 10:30 SGT
  const s = await api('GET', '/api/surveillance/settings', T(adminTok));
  assert.ok(!JSON.stringify(s.body).includes(recKey), 'key not echoed back');
});

test('lookup by GI / tracking → station, times, file and padded seek', async () => {
  for (const q of ['GI-151764', 'spx123456789']) {
    const r = await api('GET', '/api/surveillance/lookup?q=' + q, T(userTok));
    assert.equal(r.status, 200);
    const h = r.body.results[0];
    assert.equal(h.order, 'GI-151764'); assert.equal(h.operatorName, 'PACKING STATION 4');
    assert.equal(h.windowStart, '2026-10-22T03:00:00.000Z'); // 11:00:30 − 30s
    assert.equal(h.windowEnd, '2026-10-22T03:02:32.000Z');   // 11:02:02 + 30s
    assert.equal(h.videos.length, 1);
    assert.equal(h.videos[0].fileName, '2026-10-22 10-30-00.mkv');
    assert.equal(h.videos[0].seekSec, 1800); assert.equal(h.videos[0].seekHms, '00:30:00');
    assert.equal(h.videos[0].clipLengthSec, 92 + 60);
  }
  const none = await api('GET', '/api/surveillance/lookup?q=NJV999', T(userTok));
  assert.equal(none.body.results[0].startTime, '2026-10-22T05:00:00.000Z');
  assert.equal(none.body.results[0].videos.length, 0, 'times only');
});

test('clock offset shifts the seek', async () => {
  const s = await api('GET', '/api/surveillance/settings', T(adminTok));
  await api('POST', '/api/surveillance/cameras', T(adminTok), { id: s.body.cameras[0].id, clockOffsetSec: 10 });
  const r = await api('GET', '/api/surveillance/lookup?q=GI-151764', T(userTok));
  assert.equal(r.body.results[0].videos[0].seekSec, 1810);
  await api('POST', '/api/surveillance/cameras', T(adminTok), { id: s.body.cameras[0].id, clockOffsetSec: 0 });
});

test('OBS overlay: current order per station as plain text', async () => {
  const r = await fetch(B + '/api/public/surveillance/overlay?station=' + encodeURIComponent('PACKING STATION 4') + '&key=' + recKey);
  assert.equal(r.status, 200); assert.equal(await r.text(), 'GI-300000');
  const bad = await fetch(B + '/api/public/surveillance/overlay?station=x&key=nope');
  assert.equal(bad.status, 401);
});

test('scan path unaffected while ON', async () => {
  const c = await api('POST', '/api/scan/claim', T(packerTok), { orderNumber: 'GI-300000' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const i = await api('POST', '/api/scan/increment', T(packerTok), { orderNumber: 'GI-300000', sku: 'SKU9' });
  assert.equal(i.status, 200, JSON.stringify(i.body));
});

test('turning it OFF again closes everything', async () => {
  await api('PUT', '/api/surveillance/settings', T(adminTok), { enabled: false });
  assert.equal((await api('GET', '/api/surveillance/lookup?q=GI-151764', T(userTok))).status, 403);
  assert.equal((await api('POST', '/api/public/surveillance/recordings', { 'x-recorder-key': recKey, 'Content-Type': 'application/json' }, { fileName: 'a', station: 'b' })).status, 403);
});

test('DEMO_MODE hard-disables it, even for the master key', async () => {
  let D;
  try {
    D = await boot({ DEMO_MODE: 'true' });
    const r = await fetch(D.base + '/api/surveillance/settings', { headers: { 'x-master-key': KEY } });
    assert.equal(r.status, 403); assert.equal((await r.json()).error, 'Disabled in demo mode');
    const p = await fetch(D.base + '/api/surveillance/status', { headers: { 'x-master-key': KEY } });
    assert.equal((await p.json()).visible, false);
  } finally { await stop(D); }
});

test('unit: file-name time pattern', () => {
  assert.equal(sv.parseFileTime('Rec_20261022_105500.mp4', 'YYYYMMDD_HHmmss', '+08:00'), '2026-10-22T02:55:00.000Z');
  assert.equal(sv.parseFileTime('nothing.mp4', 'YYYY-MM-DD HH-mm-ss'), null);
});
