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
    { order_number: 'GI-400000', waybill_number: 'CLIP1', carrier: 'Flash Express', lines: [{ sku: 'SKU1', qty: 2 }] },
    { order_number: 'GI-500000', waybill_number: 'OPEN1', lines: [{ sku: 'SKU1', qty: 1 }] },
  ],
  orderStates: {
    'GI-151764': { status: 'done', operator: 'packer4', startTime: '2026-10-22T03:00:30.000Z', endTime: '2026-10-22T03:02:02.000Z', scanned: { SKU1: 1 } },
    'GI-200000': { status: 'done', operator: 'packer9', startTime: '2026-10-22T05:00:00.000Z', endTime: '2026-10-22T05:01:00.000Z', scanned: { SKU1: 1 } },
    'GI-400000': { status: 'done', operator: 'packer4', startTime: '2026-10-22T05:00:35.000Z', endTime: '2026-10-22T05:00:40.000Z', scanned: { SKU1: 2 },
      scanLog: [{ kind: 'scan', at: '2026-10-22T05:00:36.000Z', sku: 'SKU1', qty: 1, by: 'packer4' }, { kind: 'scan', at: '2026-10-22T05:00:38.000Z', sku: 'SKU1', qty: 2, by: 'packer4' }] },
    'GI-500000': { status: 'processing', claimedBy: 'packer9', scanned: {} },
    'GI-300000': { status: 'processing', claimedBy: 'packer4', claimedAt: '2026-10-22T04:00:00.000Z', updated_at: '2026-10-22T04:00:00.000Z', operator: 'packer4', startTime: '2026-10-22T04:00:00.000Z', scanned: {} },
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

test('OFF hides everything for EVERYONE incl. admin; admin keeps only the toggle route', async () => {
  const a = (await api('GET', '/api/surveillance/status', T(adminTok))).body;
  assert.deepEqual([a.enabled, a.admin, a.visible, a.canToggle], [false, true, false, true], 'admin: no menu/panel/Video button, but a toggle entry');
  const u = (await api('GET', '/api/surveillance/status', T(userTok))).body;
  assert.deepEqual([u.visible, u.canToggle], [false, false], 'ordinary user sees nothing');
  // a per-user grant never helps while OFF
  const sf = path.join(S.dir, 'surveillance.json');
  const cfg = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {};
  assert.ok(!cfg.enabled);
  for (const [m, p] of [['GET', '/api/surveillance/lookup?q=GI-151764'], ['GET', '/api/surveillance/live?station=PACKING%20STATION%204'],
    ['GET', '/api/surveillance/order/GI-400000/packing'], ['POST', '/api/surveillance/order/GI-400000/clip'],
    ['GET', '/api/surveillance/clips/x/video'], ['GET', '/api/surveillance/clips/x/poster']]) {
    assert.equal((await api(m, p, T(adminTok))).status, 403, 'admin ' + m + ' ' + p + ' while OFF');
    assert.equal((await api(m, p, T(userTok))).status, 403, 'user ' + m + ' ' + p + ' while OFF');
  }
  // the minimal admin path: settings stay reachable so the switch can be flipped
  assert.equal((await api('GET', '/api/surveillance/settings', T(adminTok))).status, 200);
  assert.equal((await api('GET', '/api/surveillance/settings', T(userTok))).status, 403);
});

test('only an admin can toggle / grant; non-admin is refused even when ON', async () => {
  assert.equal((await api('PUT', '/api/surveillance/settings', T(userTok), { enabled: true, grantedUsers: ['staff1'] })).status, 403);
  const r = await api('PUT', '/api/surveillance/settings', T(adminTok), { enabled: true });
  assert.deepEqual([r.status, r.body.enabled], [200, true]);
  const on = (await api('GET', '/api/surveillance/status', T(adminTok))).body;
  assert.deepEqual([on.visible, on.canToggle], [true, false], 'ON: admin sees the full feature, no toggle-only entry');
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
    for (const u of ['/api/surveillance/order/GI-151764/packing', '/api/public/surveillance/agent/clips?key=x']) {
      const x = await fetch(D.base + u, { headers: { 'x-master-key': KEY } });
      assert.equal(x.status, 403, u); assert.equal((await x.json()).error, 'Disabled in demo mode');
    }
    const up = await fetch(D.base + '/api/public/surveillance/agent/clips/abc/upload', { method: 'POST', headers: { 'x-recorder-key': 'x' }, body: 'x' });
    assert.equal(up.status, 403);
    const p = await fetch(D.base + '/api/surveillance/status', { headers: { 'x-master-key': KEY } });
    const pj = await p.json(); assert.equal(pj.visible, false); assert.equal(pj.canToggle, false, 'demo never offers even the admin toggle');
  } finally { await stop(D); }
});

test('unit: file-name time pattern', () => {
  assert.equal(sv.parseFileTime('Rec_20261022_105500.mp4', 'YYYYMMDD_HHmmss', '+08:00'), '2026-10-22T02:55:00.000Z');
  assert.equal(sv.parseFileTime('nothing.mp4', 'YYYY-MM-DD HH-mm-ss'), null);
});

// ── Quick add camera (Tapo preset) ──────────────────────────────────────────
test('unit: RTSP URL building per preset, IP validation', () => {
  const t = sv.buildRtspUrl({ brand: 'tapo', ip: '192.168.1.50', user: 'cam', pass: 'p@ss:1' });
  assert.equal(t.url, 'rtsp://cam:p%40ss%3A1@192.168.1.50:554/stream1');
  assert.equal(t.base, 'rtsp://192.168.1.50:554/stream1');
  assert.equal(sv.buildRtspUrl({ brand: 'tapo', ip: '10.0.0.9', user: 'a', pass: 'b', quality: 'sd', port: 8554 }).url, 'rtsp://a:b@10.0.0.9:8554/stream2');
  assert.match(sv.buildRtspUrl({ brand: 'hikvision', ip: '10.0.0.9', user: 'a', pass: 'b' }).url, /Channels\/101$/);
  assert.match(sv.buildRtspUrl({ brand: 'dahua', ip: '10.0.0.9', user: 'a', pass: 'b', quality: 'sd' }).url, /subtype=1$/);
  for (const ip of ['192.168.1', '256.1.1.1', '1.2.3.4.5', 'abc', '01.2.3.4', '']) assert.ok(sv.buildRtspUrl({ ip, user: 'a', pass: 'b' }).error, ip);
  assert.ok(sv.buildRtspUrl({ ip: '1.2.3.4', user: 'a' }).error, 'password required');
  assert.ok(sv.buildRtspUrl({ ip: '1.2.3.4', user: 'a', pass: 'b', port: 70000 }).error);
  assert.ok(sv.buildRtspUrl({ brand: 'nope', ip: '1.2.3.4', user: 'a', pass: 'b' }).error);
});

test('quick add: admin only, ONE camera per station (409 → replace), masked, reveal once', async () => {
  const body = { brand: 'tapo', station: 'PACKING STATION 4', quality: 'hd', ip: '192.168.1.61', user: 'tapocam', pass: 'TapoPw1' };
  assert.equal((await api('POST', '/api/surveillance/cameras/quick', T(userTok), body)).status, 403);
  assert.equal((await api('GET', '/api/surveillance/packers', T(userTok))).status, 403);
  // multi-camera payloads are gone
  assert.equal((await api('POST', '/api/surveillance/cameras/quick', T(adminTok), { ...body, cameras: [body, body] })).status, 400);
  const badIp = await api('POST', '/api/surveillance/cameras/quick', T(adminTok), { ...body, ip: '192.168.1.300' });
  assert.equal(badIp.status, 400); assert.match(badIp.body.error, /IP/);
  const pk = await api('GET', '/api/surveillance/packers', T(adminTok));
  assert.ok(pk.body.some(u => u.name === 'PACKING STATION 4'));
  assert.ok(!JSON.stringify(pk.body).match(/salt|passwordHash/));
  // station 4 already has "Cam 4" from the earlier test → clear 409 offering replace
  const dup = await api('POST', '/api/surveillance/cameras/quick', T(adminTok), body);
  assert.equal(dup.status, 409); assert.match(dup.body.error, /already has a camera/); assert.equal(dup.body.canReplace, true);
  assert.ok(dup.body.existingCameraId); assert.ok(!JSON.stringify(dup.body).includes('S3cretPw'));
  // generic add for the same station is refused too
  assert.equal((await api('POST', '/api/surveillance/cameras', T(adminTok), { name: 'Second', station: 'PACKING STATION 4', rtspUrl: 'rtsp://1.2.3.4/x' })).status, 409);
  const r = await api('POST', '/api/surveillance/cameras/quick', T(adminTok), { ...body, replace: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.replaced, true);
  assert.equal(r.body.camera.id, dup.body.existingCameraId, 'replaced in place');
  assert.equal(r.body.camera.name, 'PACKING STATION 4', 'name defaults to the station');
  assert.equal(r.body.camera.obsMediaSourceUrl, 'rtsp://tapocam:****@192.168.1.61:554/stream1');
  assert.equal(r.body.obsFilenameFormat, '%CCYY-%MM-%DD %hh-%mm-%ss');
  const s = await api('GET', '/api/surveillance/settings', T(adminTok));
  assert.equal(s.body.cameras.filter(c => c.station === 'PACKING STATION 4').length, 1);
  assert.ok(!JSON.stringify(s.body).includes('TapoPw') && !JSON.stringify(r.body).includes('TapoPw'));
  const id = r.body.camera.id;
  assert.equal((await api('POST', `/api/surveillance/cameras/${id}/reveal`, T(userTok))).status, 403);
  const rv = await api('POST', `/api/surveillance/cameras/${id}/reveal`, T(adminTok));
  assert.equal(rv.body.url, 'rtsp://tapocam:TapoPw1@192.168.1.61:554/stream1');
  assert.equal((await api('POST', `/api/surveillance/cameras/${id}/reveal`, T(adminTok))).status, 410);
  // a different station is fine
  const other = await api('POST', '/api/surveillance/cameras/quick', T(adminTok), { ...body, station: 'staff1', ip: '192.168.1.62' });
  assert.equal(other.status, 200);
});

// ── Station LIVE PANEL + waybill + camera detections ────────────────────────
test('live panel: access-gated; checklist, last scan, wrong-SKU red, over-scan, PACKED', async () => {
  await api('PUT', '/api/surveillance/settings', T(adminTok), { enabled: true });
  const L = (tok) => api('GET', '/api/surveillance/live?station=packer4', T(tok));
  assert.equal((await L(packerTok)).status, 403, 'not granted');
  assert.equal((await api('GET', '/api/public/surveillance/live?station=packer4&key=nope', {})).status, 401);
  let r = await L(userTok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.station, 'PACKING STATION 4'); assert.equal(r.body.order.number, 'GI-300000');
  assert.equal(r.body.status, 'packing');
  assert.deepEqual(r.body.lines.map(l => [l.sku, l.scanned, l.expected, l.complete]), [['SKU9', 1, 2, false]]);
  assert.equal(r.body.lastScan.sku, 'SKU9');
  assert.ok(!JSON.stringify(r.body).match(/rtsp|TapoPw|S3cret/i), 'no RTSP / credentials in live payload');
  assert.equal(r.body.camera.name, 'PACKING STATION 4');
  // wrong SKU via the REAL scan route → still 404 from the scan route, panel goes red
  const bad = await api('POST', '/api/scan/increment', T(packerTok), { orderNumber: 'GI-300000', sku: 'NOT-IN-ORDER' });
  assert.equal(bad.status, 404);
  r = await L(userTok);
  assert.equal(r.body.status, 'error'); assert.match(r.body.alert, /WRONG SKU: NOT-IN-ORDER/);
  // a good scan clears it and completes the line
  assert.equal((await api('POST', '/api/scan/increment', T(packerTok), { orderNumber: 'GI-300000', sku: 'SKU9' })).status, 200);
  r = await L(userTok);
  assert.equal(r.body.status, 'packing'); assert.equal(r.body.lines[0].complete, true);
  // public (OBS) path with the recorder key
  const pub = await api('GET', '/api/public/surveillance/live?station=' + encodeURIComponent('PACKING STATION 4') + '&key=' + recKey, {});
  assert.equal(pub.status, 200); assert.equal(pub.body.order.number, 'GI-300000');
});

test('waybill: matched green, mismatch red, missing at close amber; no order state touched', async () => {
  const W = v => api('POST', '/api/surveillance/live/waybill', T(userTok), { station: 'packer4', value: v });
  const mm = await W('SPX000WRONG');
  assert.deepEqual([mm.status, mm.body.matched], [200, false]);
  let r = await api('GET', '/api/surveillance/live?station=packer4', T(userTok));
  assert.equal(r.body.waybill.state, 'mismatch');
  const ok = await W(' live1 ');
  assert.equal(ok.body.matched, true);
  r = await api('GET', '/api/surveillance/live?station=packer4', T(userTok));
  assert.deepEqual([r.body.waybill.state, r.body.waybill.expected], ['matched', 'LIVE1']);
  assert.equal((await api('POST', '/api/surveillance/live/waybill', T(packerTok), { station: 'packer4', value: 'x' })).status, 403);
  // close the order WITHOUT a matched waybill on a fresh station → amber warning
  const c = await api('POST', '/api/scan/complete', T(packerTok), { orderNumber: 'GI-300000', operator: 'packer4' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  r = await api('GET', '/api/surveillance/live?station=packer4', T(userTok));
  assert.equal(r.body.status, 'packed');
  assert.equal(r.body.waybill.state, 'matched', 'matched before close → no warning');
  assert.equal(r.body.waybill.warning, undefined);
  const u = sv.liveForStation({ batches: [{ client_name: 'X', orders: [{ order_number: 'A1', waybill_number: 'T1', lines: [{ sku: 'S', qty: 1 }] }],
    orderStates: { A1: { status: 'done', operator: 'p', scanned: { S: 1 }, updated_at: '2026-01-01T00:00:00Z' } } }] }, { id: 'p', name: 'P' });
  assert.equal(u.waybill.warning, 'WAYBILL NOT SCANNED AT CLOSE');
});

test('recorder detections: exact tracking match → "seen on camera" with seek; near-miss ignored', async () => {
  const body = { fileName: '2026-10-22 10-59-00.mkv', station: 'PACKING STATION 4', durationSec: 600,
    detections: [{ offsetSec: 95.5, value: 'SPX123456789', type: 'CODE-128' }, { offsetSec: 96, value: 'SPX12345678S', type: 'OCR' },
                 { time: '2026-10-22T03:01:50.000Z', value: 'spx123456789', type: 'QR-Code' }] };
  const p = await api('POST', '/api/public/surveillance/recordings', { 'x-recorder-key': recKey, 'Content-Type': 'application/json' }, body);
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.recording.detections.length, 3);
  const r = await api('GET', '/api/surveillance/lookup?q=GI-151764', T(userTok));
  const ws = r.body.results[0].waybillSeen;
  assert.equal(ws.length, 2, JSON.stringify(ws));
  assert.equal(ws[0].at, '2026-10-22T03:00:35.500Z'); assert.equal(ws[0].seekSec, 96);
  assert.equal(ws[1].seekHms, '00:02:50');
  assert.equal(r.body.results[0].videos[0].fileName, '2026-10-22 10-59-00.mkv', 'newest recording containing the order first');
});


// ── Completed order → packing info + clip queue (real agent script) ─────────
const AGENT = path.join(ROOT, 'scripts', 'surveillance-recorder-agent.js');
const SAMPLE = process.env.SURV_SAMPLE_VIDEO || '/workspace/uploads/packing-obs.mp4';
const { execFileSync } = require('child_process');
const haveFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('packing info: gated (off / no access / not completed) and content', async () => {
  const U = o => api('GET', `/api/surveillance/order/${o}/packing`, T(userTok));
  assert.equal((await api('GET', '/api/surveillance/order/GI-400000/packing', T(packerTok))).status, 403, 'no access');
  assert.equal((await U('GI-500000')).status, 409, 'not completed');
  assert.equal((await U('NOPE')).status, 404);
  await api('PUT', '/api/surveillance/settings', T(adminTok), { enabled: false });
  assert.equal((await U('GI-400000')).status, 403, 'feature off');
  assert.equal((await api('GET', '/api/surveillance/status', T(userTok))).body.visible, false, 'button hidden');
  await api('PUT', '/api/surveillance/settings', T(adminTok), { enabled: true });
  // waybill + a wrong-SKU event on the panel timeline come from earlier tests for GI-300000
  const r3 = await U('GI-300000');
  assert.equal(r3.status, 200);
  assert.ok(r3.body.timeline.some(e => e.kind === 'wrong' && e.sku === 'NOT-IN-ORDER'), 'wrong SKU in timeline');
  assert.equal(r3.body.waybill.result, 'matched'); assert.ok(r3.body.waybill.scannedAt);
  const r = await U('GI-400000');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.deepEqual([d.station, d.login, d.client, d.courier, d.tracking, d.durationSec], ['PACKING STATION 4', 'packer4', 'BETIME', 'Flash Express', 'CLIP1', 5]);
  assert.deepEqual(d.timeline.map(e => [e.sku, e.qty]), [['SKU1', 1], ['SKU1', 2]]);
  assert.equal(d.waybill.result, 'missing');
  assert.equal(d.video.recording.fileName, '2026-10-22 10-30-00.mkv', 'long recording covers it');
  assert.equal(d.clip, null);
  // packer9 has no camera → no recording → times only, and no clip
  const n = (await U('GI-200000')).body;
  assert.equal(n.video.recording, null); assert.ok(n.video.windowStart);
  assert.equal((await api('POST', '/api/surveillance/order/GI-200000/clip', T(userTok))).status, 409, 'no recording → no clip');
});

test('clip queue: agent auth, request → real agent cuts packing-obs.mp4 → ready → audited download', { skip: !(haveFfmpeg && fs.existsSync(SAMPLE)) && 'ffmpeg or sample video missing' }, async () => {
  // recorder registers the sample as the station's recording (13:00:00 SGT = 05:00:00Z)
  const RDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'surv-rec-'));
  const fname = '2026-10-22 13-00-00.mp4';
  fs.copyFileSync(SAMPLE, path.join(RDIR, fname));
  const reg = await api('POST', '/api/public/surveillance/recordings', { 'x-recorder-key': recKey, 'Content-Type': 'application/json' }, { fileName: fname, station: 'PACKING STATION 4', durationSec: 36 });
  assert.equal(reg.status, 200);
  let d = (await api('GET', '/api/surveillance/order/GI-400000/packing', T(userTok))).body;
  assert.equal(d.video.recording.fileName, fname); assert.equal(d.video.recording.seekSec, 5);
  // agent endpoints need the key
  assert.equal((await api('GET', '/api/public/surveillance/agent/clips', {})).status, 401);
  assert.equal((await api('GET', '/api/public/surveillance/agent/clips', { 'x-recorder-key': 'wrong' })).status, 401);
  assert.equal((await api('POST', '/api/public/surveillance/agent/clips/x/upload', { 'x-recorder-key': 'wrong' })).status, 401);
  assert.equal((await api('POST', '/api/public/surveillance/agent/clips/x/fail', { 'x-recorder-key': 'wrong' })).status, 401);
  // request
  const q = await api('POST', '/api/surveillance/order/GI-400000/clip', T(userTok));
  assert.equal(q.status, 200); assert.equal(q.body.clip.status, 'requested');
  assert.equal((await api('POST', '/api/surveillance/order/GI-400000/clip', T(userTok))).body.clip.id, q.body.clip.id, 'idempotent');
  // the REAL reference agent, one pass
  const out = execFileSync(process.execPath, [AGENT, '--once'], { env: { ...process.env, IDEALONE_URL: B, RECORDER_KEY: recKey, RECORDINGS_DIR: RDIR }, encoding: 'utf8', timeout: 120000 });
  assert.match(out, /uploaded/);
  d = (await api('GET', '/api/surveillance/order/GI-400000/packing', T(userTok))).body;
  assert.equal(d.clip.status, 'ready', JSON.stringify(d.clip)); assert.ok(d.clip.size > 1000);
  assert.equal(d.clip.file, undefined, 'server path not exposed');
  assert.equal(d.clip.hasPoster, true, 'agent uploaded a poster frame');
  const pr = await fetch(`${B}/api/surveillance/clips/${d.clip.id}/poster`, { headers: T(userTok) });
  assert.equal(pr.status, 200); assert.equal(pr.headers.get('content-type'), 'image/jpeg');
  // download: no access → 403; granted → MP4 + audit
  assert.equal((await fetch(`${B}/api/surveillance/clips/${d.clip.id}/video`, { headers: T(packerTok) })).status, 403);
  const v = await fetch(`${B}/api/surveillance/clips/${d.clip.id}/video?download=1`, { headers: T(userTok) });
  assert.equal(v.status, 200); assert.equal(v.headers.get('content-type'), 'video/mp4');
  assert.match(v.headers.get('content-disposition'), /attachment; filename="GI-400000-packing.mp4"/);
  const buf = Buffer.from(await v.arrayBuffer());
  assert.equal(buf.slice(4, 8).toString(), 'ftyp');
  const tmpMp4 = path.join(RDIR, 'got.mp4'); fs.writeFileSync(tmpMp4, buf);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmpMp4]).toString();
  assert.ok(Number(probe) > 20 && Number(probe) < 36, 'clip ≈ seek 5 s → end of 36 s file: ' + probe);
  let audit = '';
  for (let k = 0; k < 20 && !/surveillance_clip_downloaded[^}]*staff1/.test(audit); k++) {
    await sleep(500);
    const files = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, e.name); if (e.isDirectory()) walk(fp); else if (e.name === 'db.json') files.push(fp); } };
    walk(S.dir); audit = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  }
  assert.match(audit, /staff1/, 'download audited with the user');
  // agent failure path: missing recording on the PC
  const q2 = await api('POST', '/api/surveillance/order/GI-151764/clip', T(userTok));
  assert.equal(q2.status, 200);
  execFileSync(process.execPath, [AGENT, '--once'], { env: { ...process.env, IDEALONE_URL: B, RECORDER_KEY: recKey, RECORDINGS_DIR: RDIR }, encoding: 'utf8', timeout: 60000 });
  const f = (await api('GET', '/api/surveillance/order/GI-151764/packing', T(userTok))).body.clip;
  assert.equal(f.status, 'failed'); assert.match(f.reason, /not found on this PC/);
  // non-MP4 upload refused; oversize refused
  const q3 = await api('POST', '/api/surveillance/order/GI-151764/clip', T(userTok), { retry: true });
  const bad = await fetch(`${B}/api/public/surveillance/agent/clips/${q3.body.clip.id}/upload`, { method: 'POST', headers: { 'x-recorder-key': recKey, 'Content-Type': 'video/mp4' }, body: 'x'.repeat(500) });
  assert.equal(bad.status, 400);
  await api('PUT', '/api/surveillance/settings', T(adminTok), { clipMaxMB: 1 });
  const big = await fetch(`${B}/api/public/surveillance/agent/clips/${q3.body.clip.id}/upload`, { method: 'POST', headers: { 'x-recorder-key': recKey, 'Content-Type': 'video/mp4' }, body: Buffer.alloc(1.5 * 1048576) });
  assert.equal(big.status, 413);
  fs.rmSync(RDIR, { recursive: true, force: true });
});

test('clip retention: clips older than the admin-set days are deleted from disk', { skip: !(haveFfmpeg && fs.existsSync(SAMPLE)) && 'needs the clip test' }, async () => {
  const f = path.join(S.dir, 'surveillance.json');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = cfg.clips.find(x => x.order === 'GI-400000' && x.status === 'ready');
  assert.ok(c && fs.existsSync(path.join(S.dir, 'surveillance-clips', c.file)));
  c.readyAt = new Date(Date.now() - 31 * 86400000).toISOString();
  fs.writeFileSync(f, JSON.stringify(cfg));
  await api('PUT', '/api/surveillance/settings', T(adminTok), { clipRetentionDays: 30 });
  await api('POST', '/api/surveillance/order/GI-151764/clip', T(userTok), { retry: true }); // any request runs the sweep
  assert.ok(!fs.existsSync(path.join(S.dir, 'surveillance-clips', c.file)), 'file deleted');
  assert.equal((await api('GET', '/api/surveillance/order/GI-400000/packing', T(userTok))).body.clip, null);
});

test('orders UI hook is isolated: index.html only adds one deferred script', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.equal((html.match(/surveillance-order\.js/g) || []).length, 1);
  const js = fs.readFileSync(path.join(ROOT, 'public', 'surveillance-order.js'), 'utf8');
  assert.match(js, /\/api\/surveillance\/status/); assert.match(js, /status-done/);
});

// ── CodeQL hardening: ReDoS, parameter type confusion, rate limiting ────────
test('RTSP credential check is linear-time (no ReDoS) and still flags real passwords', async () => {
  const post = body => api('POST', '/api/surveillance/cameras', T(adminTok), body);
  const t0 = Date.now();
  await post({ name: 'redos', station: 'ST-REDOS', rtspUrl: ':'.repeat(200000) });
  await post({ name: 'redos2', station: 'ST-REDOS2', rtspUrl: 'rtsp://' + ':'.repeat(50000) + 'x' });
  assert.ok(Date.now() - t0 < 5000, 'crafted URLs must not stall the server: ' + (Date.now() - t0) + 'ms');
  assert.equal((await api('GET', '/api/surveillance/status', T(adminTok))).status, 200, 'server still responsive');
  const withPw = await post({ name: 'pw', station: 'ST-PW', rtspUrl: 'rtsp://cam:Secret1@192.168.1.60:554/s1' });
  assert.equal(withPw.body.camera.canReveal, true, 'password in URL → reveal-once pending');
  const masked = await post({ name: 'masked', station: 'ST-MASK', rtspUrl: 'rtsp://cam:****@192.168.1.61:554/s1' });
  assert.equal(masked.body.camera.canReveal, false, 'masked password is not a new secret');
  const noPw = await post({ name: 'nopw', station: 'ST-NOPW', rtspUrl: 'rtsp://192.168.1.62:554/s1' });
  assert.equal(noPw.body.camera.canReveal, false);
  const arr = await post({ name: 'arr', station: 'ST-ARR', rtspUrl: ['rtsp://a:b@h/', 'x'] });
  assert.ok(arr.status < 500, 'array rtspUrl does not crash');
  const s = await api('GET', '/api/surveillance/settings', T(adminTok));
  for (const c of s.body.cameras.filter(c => /^ST-/.test(c.station))) await api('DELETE', '/api/surveillance/cameras/' + c.id, T(adminTok));
});

test('array / object request params are rejected, never coerced into a lookup', async () => {
  const lk = await api('GET', '/api/surveillance/lookup?q=GI-151764&q=GI-200000', T(userTok));
  assert.equal(lk.status, 400, 'q given twice → not a string → "q is required"');
  assert.equal((await api('GET', '/api/surveillance/lookup?q[a]=GI-151764', T(userTok))).status, 400);
  assert.equal((await api('GET', '/api/surveillance/lookup?q=GI-151764', T(userTok))).status, 200, 'a plain string still works');
  const live = await api('GET', '/api/surveillance/live?station=packer4&station=packer9', T(userTok));
  assert.equal(live.status, 404, 'station given twice → unknown station');
  const wb = await api('POST', '/api/surveillance/live/waybill', T(userTok), { station: ['packer4'], value: 'X' });
  assert.equal(wb.status, 404);
  const wb2 = await api('POST', '/api/surveillance/live/waybill', T(userTok), { station: 'packer4', value: ['X', 'Y'] });
  assert.equal(wb2.status, 400, 'array waybill value → "value is required"');
  const vid = await api('GET', '/api/surveillance/clips/nope/video?download=1&download=2', T(userTok));
  assert.equal(vid.status, 404);
  // recorder-agent POSTs: a non-binary / missing body is refused with 400, not a crash
  const up = await fetch(`${B}/api/public/surveillance/agent/clips/x/poster`, { method: 'POST', headers: { 'x-recorder-key': recKey }, body: 'x' });
  assert.equal(up.status, 404, 'unknown clip id');
});

test('clip + poster file routes are rate limited (429 + Retry-After), per IP + login', async () => {
  let last, limited = 0;
  for (let i = 0; i < 70; i++) {
    last = await fetch(`${B}/api/surveillance/clips/nope/poster`, { headers: T(userTok) });
    if (last.status === 429) { limited++; assert.ok(last.headers.get('retry-after')); }
    else assert.equal(last.status, 404);
  }
  assert.ok(limited >= 5, 'poster GET limited, got ' + limited);
  // the video route shares the file-route bucket for the same login
  assert.equal((await fetch(`${B}/api/surveillance/clips/nope/video`, { headers: T(userTok) })).status, 429);
  // another login is unaffected by this one's bucket
  assert.equal((await fetch(`${B}/api/surveillance/clips/nope/video`, { headers: T(adminTok) })).status, 404);
  // recorder-agent upload + poster POSTs
  let up429 = 0;
  for (let i = 0; i < 130; i++) {
    const r = await fetch(`${B}/api/public/surveillance/agent/clips/nope/upload`, { method: 'POST', headers: { 'x-recorder-key': recKey }, body: 'x' });
    if (r.status === 429) up429++; else assert.equal(r.status, 404);
  }
  assert.ok(up429 >= 5, 'upload POST limited, got ' + up429);
});

test('UI: Surveillance menu is shown for visible OR admin toggle-only; order Video button needs visible', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /s\.visible \|\| s\.canToggle/);
  const js = fs.readFileSync(path.join(ROOT, 'public', 'surveillance-order.js'), 'utf8');
  assert.match(js, /on = !!\(s && s\.visible\)/, 'Video button only when visible (never from canToggle / admin)');
  assert.ok(!/canToggle/.test(js));
  const pg = fs.readFileSync(path.join(ROOT, 'public', 'surveillance.html'), 'utf8');
  assert.match(pg, /canToggle/); assert.match(pg, /id="offBox"/);
});
