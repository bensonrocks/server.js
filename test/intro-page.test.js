// Public /intro landing page: 200 with no auth, and / (login) still served.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const SERVER = process.env.IDEALONE_SERVER || path.join(__dirname, '..', 'server.js');
let DDIR, B, child;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-intro-'));
  const PORT = await freePort(); B = `http://127.0.0.1:${PORT}`;
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR }, stdio: ['ignore', log, log] });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/ping')).ok) return; } catch {} await sleep(500); }
  throw new Error('server did not come up');
});
after(async () => {
  if (child) { child.kill('SIGTERM'); await new Promise(r => { child.once('exit', r); setTimeout(r, 5000); }); }
  try { fs.rmSync(DDIR, { recursive: true, force: true }); } catch {}
});
test('GET /intro returns 200 without auth', async () => {
  const r = await fetch(B + '/intro');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /IdealOne/);
  assert.match(html, /href="\/portal"/);
});
test('GET / still serves the login app', async () => {
  const r = await fetch(B + '/');
  assert.equal(r.status, 200);
});
