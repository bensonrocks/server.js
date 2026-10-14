// 24H PROCESSING TIMER (R/Y/G): unit rules (lib/order-sla.js) + booted-server
// routes (GET /api/order-sla, POST /api/master/order-sla, per-client profile).
'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const sla = require('../lib/order-sla');

const H = 3600000, NOW = Date.parse('2026-10-14T06:00:00Z');
const ago = h => new Date(NOW - h * H).toISOString();
const o = (h, x = {}) => ({ uploadedAt: ago(h), scan_status: 'pending', client_name: 'Acme', ...x });
const cfg = { hours: 24, yellowHours: 8, clients: { 'fast co': { hours: 4, yellowHours: 1 }, 'fastco alias': { hours: 4, yellowHours: 1 } } };

describe('lib/order-sla', () => {
  test('green > 8h left, yellow <= 8h left, red overdue (24h default)', () => {
    assert.equal(sla.compute(o(2), cfg, NOW).state, 'green');
    assert.equal(sla.compute(o(16), cfg, NOW).state, 'yellow');        // exactly 8h left
    assert.equal(sla.compute(o(15.9), cfg, NOW).state, 'green');
    assert.equal(sla.compute(o(27), cfg, NOW).state, 'red');
  });
  test('labels: countdown and late', () => {
    assert.equal(sla.compute(o(24 - 5 - 12 / 60), cfg, NOW).label, '5h 12m left');
    assert.equal(sla.compute(o(27), cfg, NOW).label, 'Late 3h');
  });
  test('defaults apply with no config', () => {
    const s = sla.compute(o(1), null, NOW); assert.equal(s.hours, 24); assert.equal(s.state, 'green');
  });
  test('per-client override, case-insensitive, aliases too', () => {
    assert.equal(sla.compute(o(3.5, { client_name: 'FAST CO' }), cfg, NOW).state, 'yellow');
    assert.equal(sla.compute(o(5, { client_name: 'FastCo Alias' }), cfg, NOW).state, 'red');
    assert.equal(sla.compute(o(5), cfg, NOW).state, 'green');
  });
  test('done stops the clock: in time vs late', () => {
    const start = ago(30);
    const inTime = sla.compute({ uploadedAt: start, scan_status: 'done', endTime: new Date(Date.parse(start) + 10 * H).toISOString() }, cfg, NOW);
    assert.equal(inTime.state, 'done'); assert.equal(inTime.late, false); assert.equal(inTime.label, 'Done in time');
    const late = sla.compute({ uploadedAt: start, scan_status: 'done', endTime: new Date(Date.parse(start) + 26 * H).toISOString() }, cfg, NOW);
    assert.equal(late.late, true); assert.equal(late.label, 'Done · 2h late');
  });
  test('excluded: cancelled, withdrawn (unprocessed), reference-only, no start time', () => {
    assert.equal(sla.compute(o(30, { client_cancelled: true }), cfg, NOW), null);
    assert.equal(sla.compute(o(30, { scan_status: 'unprocessed' }), cfg, NOW), null);
    assert.equal(sla.compute(o(30, { reference_only: true }), cfg, NOW), null);
    assert.equal(sla.compute({ scan_status: 'pending' }, cfg, NOW), null);
  });
  test('summarize counts and most-urgent ordering', () => {
    const list = [o(2), o(30), o(20), o(26), o(1, { scan_status: 'done', endTime: ago(0.5) }), o(9, { reference_only: true })];
    assert.deepEqual(sla.summarize(list, cfg, NOW), { red: 2, yellow: 1, green: 1, done: 1 });
    const sorted = list.map((x, i) => [i, sla.urgencyKey(x, cfg, NOW)]).sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1]).map(x => x[0]);
    assert.deepEqual(sorted, [1, 3, 2, 0, 4, 5]);
  });
  test('bad config is clamped; yellow >= hours falls back to a third', () => {
    const p = sla.policyFor({ hours: 6, yellowHours: 10 }); assert.equal(p.hours, 6); assert.equal(p.yellowHours, 2);
    assert.equal(sla.policyFor({ hours: -3 }).hours, 24);
  });
});

// ── booted server ──
const SERVER = path.join(__dirname, '..', 'server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
async function boot(DDIR, env) {
  const PORT = await freePort(); const B = `http://127.0.0.1:${PORT}`;
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR, MASTER_KEY: 'mk-sla', ...env }, stdio: ['ignore', log, log] });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/ping')).ok) return { B, child }; } catch {} await sleep(500); }
  child.kill(); throw new Error('server did not start');
}
const stop = c => new Promise(r => { c.once('exit', r); c.kill('SIGTERM'); setTimeout(r, 5000); });
const J = { 'Content-Type': 'application/json' }, MK = { ...J, 'x-master-key': 'mk-sla' };

for (const flag of ['1', '']) {
  describe(`server routes (ORDER_SLA_TIMER=${flag || 'off'})`, () => {
    let DDIR, srv, tok;
    before(async () => {
      DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-'));
      srv = await boot(DDIR, { ORDER_SLA_TIMER: flag });
      const u = await fetch(srv.B + '/api/master/users', { method: 'POST', headers: MK, body: JSON.stringify({ id: 'slauser', password: 'pw-sla-123', role: 'admin', name: 'SLA' }) });
      assert.ok(u.ok, 'create user ' + u.status);
      tok = (await (await fetch(srv.B + '/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ id: 'slauser', password: 'pw-sla-123' }) })).json()).token;
    });
    after(async () => { if (srv) await stop(srv.child); fs.rmSync(DDIR, { recursive: true, force: true }); });
    const A = () => ({ ...J, 'x-auth-token': tok });

    test('GET requires login and reports the flag', async () => {
      assert.equal((await fetch(srv.B + '/api/order-sla')).status, 401);
      const d = await (await fetch(srv.B + '/api/order-sla', { headers: A() })).json();
      assert.equal(d.enabled, flag === '1'); assert.equal(d.hours, 24); assert.equal(d.yellowHours, 8);
    });
    test('browser module is served', async () => {
      const r = await fetch(srv.B + '/vendor/order-sla.js'); assert.equal(r.status, 200); assert.match(await r.text(), /OrderSla/);
    });
    test('POST validates and saves the global policy', async () => {
      const post = b => fetch(srv.B + '/api/master/order-sla', { method: 'POST', headers: A(), body: JSON.stringify(b) });
      assert.equal((await post({ hours: 0, yellowHours: 0 })).status, 400);
      assert.equal((await post({ hours: 12, yellowHours: 12 })).status, 400);
      assert.equal((await post({ hours: 800, yellowHours: 1 })).status, 400);
      const r = await post({ hours: 12, yellowHours: 3 }); assert.equal(r.status, 200);
      const d = await (await fetch(srv.B + '/api/order-sla', { headers: A() })).json();
      assert.equal(d.hours, 12); assert.equal(d.yellowHours, 3);
    });
    test('client profile override (and its aliases), cleared by blank', async () => {
      const save = b => fetch(srv.B + '/api/master/client-profiles', { method: 'POST', headers: MK, body: JSON.stringify({ client: 'Fast Co', type: 'ecommerce', aliases: ['FastCo SG'], ...b }) });
      assert.ok((await save({ slaHours: '6', slaYellowHours: '2' })).ok);
      let d = await (await fetch(srv.B + '/api/order-sla', { headers: A() })).json();
      assert.deepEqual(d.clients['fast co'], { hours: 6, yellowHours: 2 });
      assert.deepEqual(d.clients['fastco sg'], { hours: 6, yellowHours: 2 });
      assert.ok((await save({ slaHours: '', slaYellowHours: '' })).ok);
      d = await (await fetch(srv.B + '/api/order-sla', { headers: A() })).json();
      assert.equal(d.clients['fast co'], undefined);
    });
  });
}
