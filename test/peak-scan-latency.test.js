// PEAK SCAN LATENCY (2026-10-05), proven against the real server.
//
// At Betime peak the Today list was ~1,740 rows, ~1,440 of them channel
// REFERENCE copies, and every barcode scan scheduled a full db.json rewrite
// at most 2 s apart. This suite boots the actual server on a scratch data dir
// seeded with one work order and two reference copies, then proves:
//   1. GET /api/orders with no new parameter is UNCHANGED (work + reference);
//   2. ?reference=exclude (and workOnly=1 / hideReference=true) returns work
//      only, and reports how many reference rows it left out, per client;
//   3. ?reference=only returns just the reference rows — nothing is lost;
//   4. a scan that never reached db.json (hard kill inside the longer
//      scan-rate persist window) is replayed from the journal at boot WITH
//      its carton breakdown, and a clean SIGTERM flushes it immediately.
// Run: npm test   (node --test, no extra dependencies).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const net  = require('net');
const { spawn } = require('child_process');

const ROOT   = path.resolve(__dirname, '..');
const SERVER = process.env.IDEALONE_SERVER || path.join(ROOT, 'server.js');

const GI      = 'GI-900001';
const REF_A   = '172300000000001';
const REF_B   = '172300000000002';

let DDIR, PORT, B, child, token;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': token });
const dbPath = () => path.join(DDIR, 'tenants', 'default', 'db.json');
const journalPath = () => path.join(DDIR, 'scan-journal.ndjson');

function freePort() { return new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('server did not come up: ' + url); }
async function boot() {
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR }, stdio: ['ignore', log, log] });
  await waitUp(B + '/api/version'); await sleep(2500);
}
async function stop(signal = 'SIGTERM') { if (!child) return; child.kill(signal); await new Promise(r => { child.once('exit', r); setTimeout(r, 5000); }); child = null; await sleep(500); }
async function login() { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) })); assert.ok(d.token, 'demo login'); token = d.token; }
const post = (p, body) => fetch(B + p, { method: 'POST', headers: H(), body: JSON.stringify(body) });
const get  = p => fetch(B + p, { headers: H() });

function seed(db) {
  const now = new Date().toISOString();
  const line = { sku: '8006', description: 'Test item', qty: 3, uom: 'EACH', location: '', batch_number: '', serial_number: '', expiry_date: '', remarks_betime: '' };
  const ord = n => ({ order_number: n, customer_name: '', tel: '', delivery_address: '', carrier: '', waybill_number: '', issue_no: '', pick_ticket: '', po_number: '', platform: '', shop_name: '', date: null, lines: [{ ...line }], total_qty: 3 });
  db.batches = [
    { id: 'batch-work', filename: 'pick.xlsx', idealscan_code: 'IS-PEAK-01', uploaded_at: now, uploaded_by: 'demo', client_name: 'BETIME',
      order_count: 1, row_count: 1, inventory_tracked: false, orders: [ord(GI)], orderStates: {} },
    { id: 'batch-ref', filename: 'onecart-Betime_Online', idealscan_code: 'IS-PEAK-02', uploaded_at: now, uploaded_by: 'onecart-sync', onecart_store_id: 'store-1', reference_only: true, client_name: 'Betime Online',
      order_count: 2, row_count: 2, inventory_tracked: false, orders: [ord(REF_A), ord(REF_B)], orderStates: {} },
  ];
  return db;
}

before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-peak-'));
  PORT = await freePort(); B = `http://127.0.0.1:${PORT}`;
  await boot(); await stop();
  fs.writeFileSync(dbPath(), JSON.stringify(seed(JSON.parse(fs.readFileSync(dbPath(), 'utf8')))));
  try { fs.unlinkSync(journalPath()); } catch {}
  await boot(); await login();
});
after(async () => { await stop(); try { fs.rmSync(DDIR, { recursive: true, force: true }); } catch {} });

const nums = list => list.map(o => o.order_number).sort();

test('default Orders fetch is unchanged: work + reference', async () => {
  const r = await get('/api/orders?range=today'); const d = await J(r);
  assert.equal(r.status, 200);
  assert.deepEqual(nums(d), [GI, REF_A, REF_B].sort());
  assert.equal(r.headers.get('x-reference-mode'), null);
});

test('reference=exclude / workOnly=1 / hideReference=true return work only, with counts', async () => {
  for (const q of ['reference=exclude', 'workOnly=1', 'hideReference=true']) {
    const r = await get(`/api/orders?range=today&${q}`); const d = await J(r);
    assert.equal(r.status, 200, q);
    assert.deepEqual(nums(d), [GI], q);
    assert.ok(d.every(o => !o.reference_only), q);
    assert.equal(r.headers.get('x-reference-mode'), 'exclude', q);
    assert.equal(r.headers.get('x-reference-count'), '2', q);
    assert.deepEqual(JSON.parse(decodeURIComponent(r.headers.get('x-reference-clients'))), { 'Betime Online': 2 }, q);
  }
  const all = await J(await get('/api/orders?range=all&reference=exclude'));
  assert.deepEqual(nums(all), [GI], 'range=all honours it too');
});

test('reference=only returns just the reference rows — still queryable', async () => {
  const r = await get('/api/orders?range=today&reference=only'); const d = await J(r);
  assert.deepEqual(nums(d), [REF_A, REF_B].sort());
  assert.ok(d.every(o => o.reference_only));
});

test('reference records still answer a waybill / number lookup', async () => {
  const r = await post('/api/waybill-lookup', { waybill: REF_A }); const d = await J(r);
  assert.equal(r.status, 200);
  assert.equal(d.order_number, REF_A);
  assert.equal(d.reference_only, true);
});

test('a scan lost by a hard kill inside the scan-rate window is replayed with its cartons', async () => {
  assert.equal((await post('/api/scan/claim', { orderNumber: GI })).status, 200);
  await sleep(1200);                      // let the claim's normal-schedule write land first
  const r = await post('/api/scan/increment', { orderNumber: GI, sku: '8006', eventId: 'peak-ev-1' }); const d = await J(r);
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.scanned_qty, 1);
  await sleep(150);                       // journal append lands; db persist is still deferred
  const line = fs.readFileSync(journalPath(), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.order === GI).pop();
  assert.ok(line, 'journal line written');
  assert.equal(line.scanned['8006'], 1);
  assert.ok(Array.isArray(line.cartons) && line.cartons.length === 1, 'journal carries the carton breakdown');
  // The scan-rate write is still waiting (1 s debounce): db.json lacks it.
  const before = JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
  const st0 = before.batches.find(b => b.id === 'batch-work').orderStates[GI] || {};
  assert.equal((st0.scanned || {})['8006'] || 0, 0, 'scan not yet in db.json — it is deferred');
  await stop('SIGKILL');                  // no graceful flush
  await boot(); await login();
  await stop('SIGTERM');                  // clean stop flushes the replayed state
  const db = JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
  const st = db.batches.find(b => b.id === 'batch-work').orderStates[GI];
  assert.ok(st, 'order state present after replay');
  assert.equal(st.scanned['8006'], 1, 'scanned restored');
  assert.equal(st.status, 'processing');
  assert.ok(Array.isArray(st.cartons) && st.cartons[0].scans['8006'] === 1, 'carton breakdown restored with it');
  await boot(); await login();
});

test('a clean SIGTERM flushes a pending scan-rate write at once', async () => {
  const r = await post('/api/scan/increment', { orderNumber: GI, sku: '8006', eventId: 'peak-ev-2' });
  assert.equal(r.status, 200);
  await stop('SIGTERM');
  try { fs.unlinkSync(journalPath()); } catch {}   // prove it came from db.json, not the journal
  const db = JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
  assert.equal(db.batches.find(b => b.id === 'batch-work').orderStates[GI].scanned['8006'], 2);
  await boot(); await login();
});

test('version health reports the scan-rate window', async () => {
  const d = await J(await get('/api/version'));
  const db = d.db || (d.health && d.health.db) || {};
  assert.equal(db.scanDebounceMs, 1000);
  assert.equal(db.scanMaxWaitMs, 6000);
});
