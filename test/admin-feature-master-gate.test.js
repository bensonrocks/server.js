// ADMINISTRATOR FEATURE ON EVERY /api/master/* ROUTE
// PR #54's grant ran only inside the main auth gate, so master routes
// registered BEFORE that gate (Onboard Client profiles, client-data, …)
// answered 403 to a feature session — and the Onboard Client list showed
// "No clients yet" over 25 live profiles. Boots the real server.
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
async function login(id, password) {
  const d = await api('POST', '/api/auth/login', { 'Content-Type': 'application/json' }, { id, password });
  assert.ok(d.body.token, 'login ' + id + ': ' + JSON.stringify(d.body));
  return d.body.token;
}
const ALL_ON = { upload: true, orders: true, inbound: true, transport: true, labels: true, reports: true };

let featTok, plainTok;
before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-adminfeat-'));
  PORT = await freePort();
  B = `http://127.0.0.1:${PORT}`;
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR, MASTER_KEY: KEY },
    stdio: ['ignore', log, log],
  });
  await waitUp(B + '/api/version');
  await sleep(1000);
  for (const id of ['featadmin', 'plainadmin']) {
    const r = await api('POST', '/api/master/users', KJ, { id, name: id, password: 'pw-' + id, role: 'admin' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const g = await api('PUT', '/api/master/users/featadmin/features', KJ, { features: { ...ALL_ON, administrator: true } });
  assert.equal(g.body.features.administrator, true);
  for (const c of ['ClientA', 'ClientB']) {
    const r = await api('POST', '/api/master/client-profiles', KJ, { client: c, type: 'b2c' });
    assert.equal(r.status, 200);
  }
  featTok = await login('featadmin', 'pw-featadmin');
  plainTok = await login('plainadmin', 'pw-plainadmin');
});
after(async () => {
  if (child) { child.kill('SIGTERM'); await new Promise(r => { child.once('exit', r); setTimeout(r, 5000); }); }
  try { fs.rmSync(DDIR, { recursive: true, force: true }); } catch {}
});

// Routes registered BEFORE the main auth gate, plus one after it.
const EARLY = ['/api/master/client-profiles', '/api/master/client-data/clients', '/api/master/rate-cards', '/api/master/system-errors'];
const LATE = ['/api/master/users'];

test('feature session + empty key (what the UI sends) → 200 on early AND late master routes', async () => {
  for (const p of [...EARLY, ...LATE]) {
    const r = await api('GET', p, { 'x-auth-token': featTok, 'x-master-key': '' });
    assert.equal(r.status, 200, p + ' → ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
  }
  const r = await api('GET', '/api/master/client-profiles', { 'x-auth-token': featTok, 'x-master-key': '' });
  assert.deepEqual(r.body.map(p => p.client).sort(), ['ClientA', 'ClientB']);
});

test('feature session can WRITE an early master route (profile save) and it is attributed', async () => {
  const r = await api('POST', '/api/master/client-profiles',
    { 'x-auth-token': featTok, 'x-master-key': '', 'Content-Type': 'application/json' }, { client: 'ClientA', commodity: 'Tea' });
  assert.equal(r.status, 200);
  assert.equal(r.body.commodity, 'Tea');
});

test('unticked session, no key → still 403 on early routes, and cannot self-grant', async () => {
  for (const p of EARLY) {
    const r = await api('GET', p, { 'x-auth-token': plainTok, 'x-master-key': '' });
    assert.equal(r.status, 403, p);
  }
  const self = await api('PUT', '/api/master/users/plainadmin/features',
    { 'x-auth-token': plainTok, 'x-master-key': '', 'Content-Type': 'application/json' }, { features: { ...ALL_ON, administrator: true } });
  assert.equal(self.status, 403, 'self-grant must be refused');
  const after = await api('GET', '/api/master/users', KJ);
  assert.notEqual(after.body.find(u => u.id === 'plainadmin').features?.administrator, true);
});

test('no session, no key → 403 early / 401 late; bogus token grants nothing; wrong key refused', async () => {
  for (const p of EARLY) {
    assert.equal((await api('GET', p, { 'x-master-key': '' })).status, 403, p);
    assert.equal((await api('GET', p, { 'x-auth-token': 'nope', 'x-master-key': '' })).status, 403, p);
    assert.equal((await api('GET', p, { 'x-master-key': 'wrong' })).status, 403, p);
  }
  assert.equal((await api('GET', '/api/master/users', {})).status, 401);
});

test('key path unchanged: correct key, no session → 200 everywhere', async () => {
  for (const p of [...EARLY, ...LATE]) {
    assert.equal((await api('GET', p, { 'x-master-key': KEY })).status, 200, p);
  }
});

test('revoking the feature takes effect on the next request', async () => {
  const g = await api('PUT', '/api/master/users/featadmin/features', KJ, { features: { ...ALL_ON, administrator: false } });
  assert.equal(g.body.features.administrator, false);
  const r = await api('GET', '/api/master/client-profiles', { 'x-auth-token': featTok, 'x-master-key': '' });
  assert.equal(r.status, 403);
});
