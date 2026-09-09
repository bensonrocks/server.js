// THE REFERENCE-RECORD FENCE, proven against the real server.
//
// A channel's reference copy (OneCart → Betime Online) is a ledger entry, not
// work: never scanned, never cancelled, never moved, never labelled. This suite
// boots the actual server on a scratch data dir seeded with one reference copy
// and one work order sharing its waybill, then proves:
//   1. every mutating scan / orders / waves route refuses the reference number
//      (the route fence at the auth gate) while the work order passes through;
//   2. a label can never be filed on a reference copy — by hand (409) and by
//      the writer itself;
//   3. a label filed the OLD way (before the fence) is moved onto the work
//      order at boot, once, with an audit row.
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
const SERVER = process.env.IDEALONE_SERVER || path.join(ROOT, 'server.js');   // point at another build to prove the suite bites
const MASTER = process.env.MASTER_KEY || '201432547E';

const REF_MP  = '172397910455623';      // the marketplace number, held ONLY by the reference copy
const REF_MP2 = '585836014589150279';   // a second reference copy with no picking list at all
const GI      = 'GI-141936';            // BETIME's picking-list order, same shipment as REF_MP
const WB      = 'TXSGD03800975';        // the waybill both carry

let DDIR, PORT, B, child, token;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': token, 'x-master-key': MASTER });
const dbPath = () => path.join(DDIR, 'tenants', 'default', 'db.json');
const readDb = async () => { await sleep(1500); return JSON.parse(fs.readFileSync(dbPath(), 'utf8')); };

function freePort() { return new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('server did not come up: ' + url); }
async function boot() {
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR }, stdio: ['ignore', log, log] });
  await waitUp(B + '/api/version'); await sleep(2500);
}
async function stop() { if (!child) return; child.kill('SIGTERM'); await new Promise(r => { child.once('exit', r); setTimeout(r, 5000); }); child = null; await sleep(500); }
async function login() { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) })); assert.ok(d.token, 'demo login'); token = d.token; }
const post = (p, body) => fetch(B + p, { method: 'POST', headers: H(), body: JSON.stringify(body) });

function seed(db) {
  const now = new Date().toISOString();
  const line = { sku: '8006', description: 'Test item', qty: 1, uom: 'EACH', location: '', batch_number: '', serial_number: '', expiry_date: '', remarks_betime: '' };
  db.batches = [
    { id: 'batch-work', filename: 'gi-analysis.xlsx', idealscan_code: 'IS-TEST-01', uploaded_at: now, uploaded_by: 'demo', client_name: 'BETIME',
      order_count: 1, row_count: 1, inventory_tracked: false,
      orders: [{ order_number: GI, customer_name: '', tel: '', delivery_address: '', carrier: '', waybill_number: WB, issue_no: GI, pick_ticket: '', po_number: '', platform: '', shop_name: '', date: null, lines: [{ ...line }], total_qty: 1 }],
      orderStates: {} },
    { id: 'batch-ref', filename: 'onecart-Betime_Online', idealscan_code: 'IS-TEST-02', uploaded_at: now, uploaded_by: 'onecart-sync', onecart_store_id: 'store-1', reference_only: true, client_name: 'Betime Online',
      order_count: 2, row_count: 2, inventory_tracked: false,
      orders: [
        { order_number: REF_MP,  customer_name: 'Phang Chew Yen', tel: '', delivery_address: '', carrier: 'TraxLogics', waybill_number: WB, issue_no: '', pick_ticket: '', po_number: '', platform: 'Lazada', shop_name: 'Betime Lazada', date: null, lines: [{ ...line }], total_qty: 1, onecart_id: '9003', onecart_store_id: 'store-1' },
        { order_number: REF_MP2, customer_name: 'Ali Tan', tel: '', delivery_address: '', carrier: 'J&T', waybill_number: '', issue_no: '', pick_ticket: '', po_number: '', platform: 'TikTok', shop_name: 'Betime TikTok', date: null, lines: [{ ...line }], total_qty: 1, onecart_id: '9001', onecart_store_id: 'store-1' },
      ],
      orderStates: {} },
  ];
  // A label filed the OLD way — on the reference copy — with its page text
  // naming both the marketplace number and the waybill.
  db.labelImports = [{ id: 'imp-old', filename: 'traxlogics.pdf', uploadedAt: now, uploadedBy: 'demo', pageCount: 1,
    pages: [{ pageIndex: 0, pageFile: 'page_1.pdf', rawText: `${WB} TRACX ORDER NO. ${REF_MP} RECIPIENT Phang Chew Yen`,
      extracted: { trackingNumber: WB, orderNumber: REF_MP, giNumber: '' }, matchStatus: 'matched', matchedOrderNumber: REF_MP, matchMethod: 'order_number', matchConfidence: 'exact' }] }];
  db.orderLabels = { [REF_MP]: { importId: 'imp-old', pageIndex: 0, pageFile: 'page_1.pdf', attachedAt: now, attachedBy: 'demo', tracking: WB } };
  return db;
}

before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-fence-'));
  PORT = await freePort(); B = `http://127.0.0.1:${PORT}`;
  await boot();               // first boot creates db.json
  await stop();
  fs.writeFileSync(dbPath(), JSON.stringify(seed(JSON.parse(fs.readFileSync(dbPath(), 'utf8')))));
  try { fs.unlinkSync(path.join(DDIR, 'tenants', 'default', 'scan-journal.ndjson')); } catch {}
  await boot();               // second boot runs the re-home pass
  await login();
});
after(async () => { await stop(); try { fs.rmSync(DDIR, { recursive: true, force: true }); } catch {} });

test('boot moves a label filed on a reference copy onto the work order sharing its waybill', async () => {
  const db = await readDb();
  assert.ok(db.orderLabels[GI], `label is on ${GI}`);
  assert.equal(db.orderLabels[REF_MP], undefined, `nothing left on ${REF_MP}`);
  const page = db.labelImports[0].pages[0];
  assert.equal(page.matchedOrderNumber, GI);
  assert.equal(page.rehomedFrom, REF_MP);
  const rows = (db.auditLog || []).filter(e => e.type === 'labels_rehomed_from_reference');
  assert.equal(rows.length, 1, 'one audit row');
  assert.equal(rows[0].moved, 1);
});

test('the route fence refuses every mutating call naming a reference-only number', async () => {
  const calls = [
    ['/api/scan/increment',        { orderNumber: REF_MP, sku: '8006', eventId: 'ev-1' }],
    ['/api/scan/claim',            { orderNumber: REF_MP }],
    ['/api/scan/new-carton',       { orderNumber: REF_MP }],
    ['/api/scan/setqty',           { orderNumber: REF_MP, sku: '8006', qty: 1 }],
    ['/api/scan/cancel',           { orderNumber: REF_MP, reason: 'not ours at all' }],
    ['/api/scan/complete',         { orderNumber: REF_MP }],
    ['/api/orders/bulk-cancel',    { orders: [REF_MP], reason: 'test cancel reason' }],
    ['/api/orders/bulk-reclassify',{ orders: [REF_MP], to: 'pending', reason: 'test reason', password: 'demo' }],
    ['/api/orders/bulk-refile',    { orders: [REF_MP], client: 'BETIME', reason: 'test reason' }],
    [`/api/orders/${REF_MP}/refile`, { client: 'BETIME', reason: 'test reason' }],
    ['/api/waves',                 { name: 'W', order_numbers: [REF_MP] }],
  ];
  for (const [p, body] of calls) {
    const r = await post(p, body); const d = await J(r);
    assert.equal(r.status, 409, `${p} → ${r.status} ${JSON.stringify(d).slice(0, 120)}`);
    assert.equal(d.referenceOnly, true, `${p} says referenceOnly`);
  }
  const db = await readDb();
  assert.ok((db.auditLog || []).some(e => e.type === 'reference_order_fenced'), 'a fenced call is on the trail');
  const st = db.batches.find(b => b.id === 'batch-ref').orderStates || {};
  assert.equal(Object.keys(st).length, 0, 'the reference copy has no scan state at all');
});

test('a bulk call mixing a work order and a reference copy is refused naming only the copy', async () => {
  const r = await post('/api/orders/bulk-cancel', { orders: [GI, REF_MP], reason: 'test cancel reason' }); const d = await J(r);
  assert.equal(r.status, 409); assert.deepEqual(d.orders, [REF_MP]);
  const db = await readDb();
  assert.notEqual((db.batches.find(b => b.id === 'batch-work').orderStates[GI] || {}).status, 'unprocessed', 'the work order was not cancelled by the refused call');
});

test('the same calls on the work order are NOT fenced', async () => {
  for (const [p, body] of [
    ['/api/scan/claim',       { orderNumber: GI }],
    ['/api/scan/increment',   { orderNumber: GI, sku: '8006', eventId: 'ev-2' }],
    ['/api/waves',            { name: 'W', order_numbers: [GI] }],
  ]) {
    const r = await post(p, body); const d = await J(r);
    assert.notEqual(d.referenceOnly, true, `${p} not fenced (${r.status})`);
  }
  const db = await readDb();
  assert.equal((db.batches.find(b => b.id === 'batch-work').orderStates[GI] || {}).scanned?.['8006'], 1, 'the scan landed on the work order');
});

test('a label can never be filed on a reference copy by hand', async () => {
  const r = await post('/api/label-imports/imp-old/pages/0/match', { orderNumber: REF_MP2 }); const d = await J(r);
  assert.equal(r.status, 409); assert.equal(d.referenceOnly, true);
  const db = await readDb();
  assert.equal(db.orderLabels[REF_MP2], undefined);
  assert.ok(db.orderLabels[GI], 'the page is still on the work order');
});

test('a second boot moves nothing and logs nothing', async () => {
  await stop(); await boot(); await login();
  const db = await readDb();
  assert.equal((db.auditLog || []).filter(e => e.type === 'labels_rehomed_from_reference').length, 1);
  assert.ok(db.orderLabels[GI]);
});
