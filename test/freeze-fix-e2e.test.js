// Freeze fix 2026-10-20, server level: non-blocking rebuild persists durably
// and keeps writes; daily-summary is cached, single-flight, not wiped by writes.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let DDIR, PORT, B, child, token;
const MASTER = '201432547E';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': token });
function freePort() { return new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function waitUp() { for (let i = 0; i < 120; i++) { try { if ((await fetch(B + '/api/version')).status < 500) return; } catch {} await sleep(500); } throw new Error('no boot'); }
const ENV = { DB_INCREMENTAL_PERSIST: '1', DB_REBUILD_NONBLOCKING: '1', DB_INCREMENTAL_REBUILD_MS: '1500', DB_INCREMENTAL_REBUILD_IDLE_MS: '0', DB_REBUILD_AVOID_WINDOW: 'off', DAILY_SUMMARY_TTL_MS: '60000' };
async function boot() { const log = fs.openSync(path.join(DDIR, 'server.log'), 'a'); child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, ...ENV, PORT: String(PORT), DATA_DIR: DDIR }, stdio: ['ignore', log, log] }); await waitUp(); await sleep(1200); }
async function stop() { if (!child) return; child.kill('SIGTERM'); await new Promise(r => { child.once('exit', r); setTimeout(r, 6000); }); child = null; await sleep(300); }
const dbPath = () => path.join(DDIR, 'tenants', 'default', 'db.json');
function seed(db) {
  const now = new Date().toISOString();
  db.batches = [{ id: 'b1', filename: 'p.xlsx', idealscan_code: 'IS-FF-1', uploaded_at: now, uploaded_by: 'demo', client_name: 'ACMECO', order_count: 20, row_count: 20,
    orders: Array.from({ length: 20 }, (_, i) => ({ order_number: 'FF-' + i, customer_name: 'C' + i, date: now, total_qty: 1, lines: [{ sku: 'SKU1', description: 'Item', qty: 1 }] })),
    orderStates: Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['FF-' + i, { status: 'pending', scanned: {} }])) }];
  db.auditLog = (db.auditLog || []).concat(Array.from({ length: 5000 }, (_, i) => ({ type: i % 2 ? 'order_completed' : 'upload', at: now, client: 'ACMECO', pieces: 1, orders: 3, lines: 4 })));
  return db;
}
before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-ff-')); PORT = await freePort(); B = `http://127.0.0.1:${PORT}`;
  await boot(); await stop();
  fs.writeFileSync(dbPath(), JSON.stringify(seed(JSON.parse(fs.readFileSync(dbPath(), 'utf8')))));
  await boot();
  const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }));
  token = d.token; assert.ok(token);
});
after(async () => { await stop(); try { fs.rmSync(DDIR, { recursive: true, force: true }); } catch {} });

test('non-blocking rebuild runs, db.json stays valid and keeps every write', async () => {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(B + '/api/scan/increment', { method: 'POST', headers: H(), body: JSON.stringify({ orderNumber: 'FF-' + i, sku: 'SKU1', eventId: 'ff-' + i }) });
    assert.equal(r.status, 200, JSON.stringify(await J(r)));
    await sleep(700); // straddles several rebuild periods
  }
  let v;
  for (let i = 0; i < 30; i++) { await sleep(500); v = await J(await fetch(B + '/api/version')); if ((v.db.asyncRebuilds || 0) >= 2) break; }
  assert.equal(v.db.nonBlockingRebuild, true);
  assert.ok((v.db.asyncRebuilds || 0) >= 2, JSON.stringify(v.db));
  await stop();
  assert.equal(fs.existsSync(dbPath() + '.tmp'), false);
  const db = JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
  for (let i = 0; i < 6; i++) assert.equal(db.batches[0].orderStates['FF-' + i].scanned.SKU1, 1, 'FF-' + i);
  await boot();
  const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }));
  token = d.token;
});

test('daily-summary: single-flight, cached, not wiped by writes', async () => {
  const u = '/api/master/report/daily-summary?from=2026-01-01&to=2030-12-31';
  const h = { 'x-master-key': MASTER };
  const v0 = await J(await fetch(B + '/api/version'));
  const rs = await Promise.all([1, 2, 3, 4].map(() => fetch(B + u, { headers: h })));
  for (const r of rs) { assert.equal(r.status, 200); await r.arrayBuffer(); }
  const v1 = await J(await fetch(B + '/api/version'));
  assert.equal(v1.dailySummary.asyncEnabled, true);
  assert.equal(v1.dailySummary.builds - v0.dailySummary.builds, 1, 'four concurrent cold requests share one build');
  // A non-scan write used to clear the cache (PR #101's _perfCache).
  const w = await fetch(B + '/api/drivers', { method: 'POST', headers: H(), body: JSON.stringify({ name: 'Cache Buster' }) });
  assert.equal(w.status, 200, JSON.stringify(await J(w)));
  const r2 = await fetch(B + u, { headers: h });
  assert.equal(r2.headers.get('x-report-cache'), 'hit');
  const buf = Buffer.from(await r2.arrayBuffer());
  assert.ok(buf.length > 1000);
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Daily, { header: 1 });
  assert.equal(rows[0][0], 'Date');
  assert.equal(rows.slice(1).reduce((s, r) => s + r[1], 0), 2500, 'uploads counted');
  const v2 = await J(await fetch(B + '/api/version'));
  assert.equal(v2.dailySummary.builds, v1.dailySummary.builds);
});
