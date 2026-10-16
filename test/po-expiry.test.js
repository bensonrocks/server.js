// PO EXPIRY ON TRANSPORT JOBS (lib/tms-importer.js parsePoExpiry + import,
// GET /api/transport, POST /api/transport/:id/update).
'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const tms = require('../lib/tms-importer');

describe('parsePoExpiry', () => {
  test('accepts the shapes found in the Betime planner', () => {
    assert.equal(tms.parsePoExpiry(new Date(2026, 9, 17)), '2026-10-17');
    assert.equal(tms.parsePoExpiry(' 2025-05-23'), '2025-05-23');
    assert.equal(tms.parsePoExpiry('19/10/2026'), '2026-10-19');
    assert.equal(tms.parsePoExpiry('2026-10-17 00:00:00'), '2026-10-17');
    assert.equal(tms.parsePoExpiry(46312), '2026-10-17');           // Excel serial
  });
  test('rejects non-dates and bad serials', () => {
    for (const v of ['YES', '', null, undefined, 1004207608, '31/02/2026', 'soon']) assert.equal(tms.parsePoExpiry(v), null, String(v));
  });
});

describe('importBetimeDeliveries', () => {
  test('reads PO EXPIRED and does not mistake it for the delivery date', () => {
    const rows = [{ 'PO NO': 26516266, CUSTOMER: "Watson's", ' STORE NAME': 'JEM', 'PO EXPIRED': '17/10/2026', 'ORDER QTY': 6, 'DELIVERY DATE': '2026-10-14' },
                  { 'PO NO': 26516288, CUSTOMER: "Watson's", ' STORE NAME': 'JW', 'PO EXPIRED': 'YES', 'ORDER QTY': 3, 'DELIVERY DATE': '2026-10-14' }];
    const out = tms.importBetimeDeliveries(rows);
    assert.equal(out.length, 2);
    assert.equal(out[0].poExpiry, '2026-10-17'); assert.equal(out[1].poExpiry, null);
    const db = {}; tms.createOrdersFromImport({ customers: out }, db);
    assert.equal(db.transport[0].poExpiry, '2026-10-17'); assert.equal(db.transport[0].poExpiryMatch, 'import');
    assert.equal(db.transport[1].poExpiry, undefined);
  });
});

const SERVER = path.join(__dirname, '..', 'server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
async function boot(DDIR) {
  const PORT = await freePort(); const B = `http://127.0.0.1:${PORT}`;
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR, MASTER_KEY: 'mk-poexp' }, stdio: ['ignore', log, log] });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/ping')).ok) return { B, child }; } catch {} await sleep(500); }
  child.kill(); throw new Error('server did not start');
}
const stop = c => new Promise(r => { c.once('exit', r); c.kill('SIGTERM'); setTimeout(r, 5000); });
const J = { 'Content-Type': 'application/json' };

describe('server: poExpiry on transport jobs', () => {
  let DDIR, srv, H;
  before(async () => {
    DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-poexp-'));
    const first = await boot(DDIR); await sleep(800); await stop(first.child);
    const f = path.join(DDIR, 'tenants', 'default', 'db.json');
    const db = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    db.transport = [{ id: 'TR-1', referenceId: '26516266', clientName: 'JEM (170)', status: 'preplanned', shipping: { zip: '608549' }, source: { manual: true } }];
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(db));
    srv = await boot(DDIR);
    assert.ok((await fetch(srv.B + '/api/master/users', { method: 'POST', headers: { ...J, 'x-master-key': 'mk-poexp' }, body: JSON.stringify({ id: 'ofc', password: 'pw-ofc-123', role: 'admin', name: 'O' }) })).ok);
    const tok = (await (await fetch(srv.B + '/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ id: 'ofc', password: 'pw-ofc-123' }) })).json()).token;
    H = { ...J, 'x-auth-token': tok };
  });
  after(async () => { if (srv) await stop(srv.child); if (DDIR) fs.rmSync(DDIR, { recursive: true, force: true }); });

  const list = async () => (await (await fetch(srv.B + '/api/transport', { headers: H })).json()).find(j => j.id === 'TR-1');
  const upd = b => fetch(srv.B + '/api/transport/TR-1/update', { method: 'POST', headers: H, body: JSON.stringify(b) });

  test('null until set; set with note; bad date refused; clear', async () => {
    let j = await list(); assert.equal(j.poExpiry, null); assert.equal(j.poExpiryMatch, '');
    let r = await upd({ poExpiry: '2026-10-21', poExpiryMatch: 'best guess (medium)' }); assert.equal(r.status, 200);
    j = await list(); assert.equal(j.poExpiry, '2026-10-21'); assert.equal(j.poExpiryMatch, 'best guess (medium)');
    assert.equal(j.status, 'preplanned');                       // nothing else touched
    r = await upd({ poExpiry: 'YES' }); assert.equal(r.status, 400);
    assert.equal((await list()).poExpiry, '2026-10-21');
    r = await upd({ poExpiry: '21/10/2026' }); assert.equal(r.status, 200); assert.equal((await list()).poExpiry, '2026-10-21');
    r = await upd({ poExpiry: null }); assert.equal(r.status, 200);
    j = await list(); assert.equal(j.poExpiry, null); assert.equal(j.poExpiryMatch, '');
  });
});

describe('UI chip colour (public/app.js poExpiryInfo)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = src.indexOf('  function poExpiryInfo(job)');
  const end = src.indexOf('  function poExpiryChip(job');
  const NOW = Date.parse('2026-10-16T04:00:00Z');                  // 12:00 SGT
  const info = new Function('Date', src.slice(start, end) + '; return poExpiryInfo;')(
    class extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } });
  test('red / amber / green / delivered neutral / TBA grey', () => {
    assert.equal(info({ poExpiry: '2026-10-15', status: 'preplanned' }).level, 'expired');
    assert.equal(info({ poExpiry: '2026-10-16', status: 'preplanned' }).level, 'soon');
    assert.equal(info({ poExpiry: '2026-10-18', status: 'preplanned' }).level, 'soon');
    assert.equal(info({ poExpiry: '2026-10-19', status: 'preplanned' }).level, 'ok');
    assert.equal(info({ poExpiry: '2026-10-19', status: 'preplanned' }).color, '#15803d');
    assert.equal(info({ poExpiry: '2026-10-10', status: 'delivered' }).level, 'done');
    assert.equal(info({ poExpiry: '2026-10-17', status: 'delivered' }).level, 'done');
    assert.equal(info({ status: 'pending' }).text, 'PO exp TBA');
  });
});
