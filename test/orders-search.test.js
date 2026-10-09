// SERVER-SIDE ORDER SEARCH — GET /api/orders?q=…
// Proves q is honoured (capped, lean), empty q is unchanged, and scan paths
// are untouched. Unit tests cover the matcher; e2e boots the real server.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const search = require('../lib/orders-search');

test('matcher: order no, waybill, client, SKU, TR- id; respects cap', () => {
  const db = {
    batches: [
      {
        id: 'b1', client_name: 'BETIME', idealscan_code: 'IS-260101-01',
        orders: [
          { order_number: 'GI-1', waybill_number: 'WB-AAA', customer_name: 'Ada', lines: [{ sku: '8006', qty: 1 }] },
          { order_number: 'GI-2', waybill_number: 'WB-BBB', customer_name: 'Bob', lines: [{ sku: '9001', qty: 2 }] },
          { order_number: 'GI-3', waybill_number: 'WB-CCC', customer_name: 'Cid', lines: [{ sku: '8006', qty: 1 }] },
        ],
      },
      {
        id: 'b2', client_name: 'Mayer', idealscan_code: 'IS-260101-02', reference_only: true,
        orders: [
          { order_number: 'MP-9', waybill_number: 'WB-REF', customer_name: 'Ref', lines: [{ sku: 'ZZ', qty: 1 }] },
        ],
      },
    ],
    transport: [
      { id: 'TR-42', referenceId: 'GI-2', status: 'pending' },
    ],
  };
  assert.deepEqual(search.findMatchingOrderNumbers(db, 'GI-1'), ['GI-1']);
  assert.deepEqual(search.findMatchingOrderNumbers(db, 'wb-aaa'), ['GI-1']);
  assert.deepEqual(search.findMatchingOrderNumbers(db, '8006').sort(), ['GI-1', 'GI-3']);
  assert.deepEqual(search.findMatchingOrderNumbers(db, 'TR-42'), ['GI-2']);
  assert.deepEqual(search.findMatchingOrderNumbers(db, 'BETIME').sort(), ['GI-1', 'GI-2', 'GI-3']);
  assert.deepEqual(search.findMatchingOrderNumbers(db, 'IS-260101-02'), ['MP-9']);
  assert.deepEqual(search.findMatchingOrderNumbers(db, '8006', 1), ['GI-1']);
  assert.deepEqual(search.findMatchingOrderNumbers(db, ''), []);
});

test('leanOrderForList drops stock chips, keeps pick_locations', () => {
  const lean = search.leanOrderForList({
    order_number: 'GI-1',
    client_name: 'BETIME',
    scan_status: 'done',
    lines: [{ sku: '8006', description: 'Tape', qty: 1, stock_onhand: 99, stock_free: 3, pick_locations: [{ location_id: 'A1', qty: 1 }] }],
    items: [{ sku: '8006', stock_onhand: 99 }],
    fulfilment: { minutesLeft: 10 },
    extraJunk: { huge: true },
  });
  assert.equal(lean.order_number, 'GI-1');
  assert.equal(lean.extraJunk, undefined);
  assert.equal(lean.lines[0].stock_onhand, undefined);
  assert.deepEqual(lean.lines[0].pick_locations, [{ location_id: 'A1', qty: 1 }]);
  assert.equal(lean.fulfilment.minutesLeft, 10);
});

test('wantLean defaults on when q is set', () => {
  assert.equal(search.wantLean({ q: 'GI-1' }), true);
  assert.equal(search.wantLean({ q: 'GI-1', lean: '0' }), false);
  assert.equal(search.wantLean({}), false);
});

// ── e2e against real server ───────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const SERVER = process.env.IDEALONE_SERVER || path.join(ROOT, 'server.js');
const GI = 'GI-SEARCH-1';
const REF = '172399999999001';

let DDIR, PORT, B, child, token;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': token });
const dbPath = () => path.join(DDIR, 'tenants', 'default', 'db.json');

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
async function boot() {
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', log, log],
  });
  await waitUp(B + '/api/version');
  await sleep(1500);
}
async function stop(signal = 'SIGTERM') {
  if (!child) return;
  child.kill(signal);
  await new Promise(r => { child.once('exit', r); setTimeout(r, 5000); });
  child = null;
  await sleep(400);
}
async function login() {
  const d = await J(await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }),
  }));
  assert.ok(d.token, 'demo login');
  token = d.token;
}
const get = p => fetch(B + p, { headers: H() });

function seed(db) {
  const now = new Date().toISOString();
  const line = { sku: '8006', description: 'Test item', qty: 2, uom: 'EACH' };
  const ord = (n, extra = {}) => ({
    order_number: n, customer_name: 'Search Cust', tel: '', delivery_address: '',
    carrier: '', waybill_number: 'WB-' + n, issue_no: '', pick_ticket: '', po_number: '',
    platform: '', shop_name: '', date: null, lines: [{ ...line }], total_qty: 2, ...extra,
  });
  db.batches = [
    {
      id: 'batch-work', filename: 'pick.xlsx', idealscan_code: 'IS-SEARCH-01',
      uploaded_at: now, uploaded_by: 'demo', client_name: 'BETIME',
      order_count: 1, row_count: 1, inventory_tracked: false,
      orders: [ord(GI)], orderStates: { [GI]: { status: 'done', scanned: { '8006': 2 }, endTime: now } },
    },
    {
      id: 'batch-ref', filename: 'onecart-ref', idealscan_code: 'IS-SEARCH-02',
      uploaded_at: now, uploaded_by: 'onecart-sync', onecart_store_id: 'store-1',
      reference_only: true, client_name: 'Betime Online',
      order_count: 1, row_count: 1, inventory_tracked: false,
      orders: [ord(REF)], orderStates: {},
    },
  ];
  // Pad with many unrelated pending orders so range=all without q is large.
  for (let i = 0; i < 40; i++) {
    const n = 'PAD-' + String(i).padStart(3, '0');
    db.batches[0].orders.push(ord(n, { customer_name: 'Pad' }));
    db.batches[0].orderStates[n] = { status: 'pending', scanned: {} };
  }
  db.transport = [{ id: 'TR-SEARCH-9', referenceId: GI, status: 'pending' }];
  return db;
}

before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-search-'));
  PORT = await freePort();
  B = `http://127.0.0.1:${PORT}`;
  await boot(); await stop();
  fs.writeFileSync(dbPath(), JSON.stringify(seed(JSON.parse(fs.readFileSync(dbPath(), 'utf8')))));
  await boot(); await login();
});
after(async () => {
  await stop();
  try { fs.rmSync(DDIR, { recursive: true, force: true }); } catch {}
});

test('empty q: range=all still returns the full catalog (unchanged)', async () => {
  const r = await get('/api/orders?range=all');
  const d = await J(r);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(d) && d.length >= 40, 'full list present, got ' + d.length);
  assert.equal(r.headers.get('x-search-cap'), null);
});

test('q= order number: capped lean hit list, not the whole catalog', async () => {
  const r = await get('/api/orders?range=all&q=' + encodeURIComponent(GI));
  const d = await J(r);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-search-cap'), '60');
  assert.equal(r.headers.get('x-search-lean'), '1');
  assert.equal(d.length, 1);
  assert.equal(d[0].order_number, GI);
  assert.equal(d[0].lines[0].stock_onhand, undefined);
  assert.ok(d[0].client_name);
});

test('q= waybill and TR- id resolve the same order', async () => {
  const wb = await J(await get('/api/orders?range=all&q=' + encodeURIComponent('WB-' + GI)));
  assert.equal(wb.length, 1);
  assert.equal(wb[0].order_number, GI);
  const tr = await J(await get('/api/orders?range=all&q=TR-SEARCH-9'));
  assert.equal(tr.length, 1);
  assert.equal(tr[0].order_number, GI);
  assert.equal(tr[0].transport_id, 'TR-SEARCH-9');
});

test('lean=0 keeps enriched stock fields on the match', async () => {
  const r = await get('/api/orders?range=all&q=' + encodeURIComponent(GI) + '&lean=0');
  const d = await J(r);
  assert.equal(r.headers.get('x-search-lean'), '0');
  assert.equal(d.length, 1);
  // stock_onhand may be null when inventory is not tracked — field should exist
  assert.ok('stock_onhand' in (d[0].lines[0] || {}));
});

test('scan increment still works (search PR does not touch scan paths)', async () => {
  // Use a pending padded order
  const r = await fetch(B + '/api/scan/increment', {
    method: 'POST', headers: H(),
    body: JSON.stringify({ orderNumber: 'PAD-000', sku: '8006', eventId: 'search-scan-1' }),
  });
  const d = await J(r);
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.scanned_qty, 1);
});
