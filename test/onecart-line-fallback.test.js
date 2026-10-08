// OneCart blank-SKU lines: the order-record fallback.
//
// GET /delivery_orders sometimes returns a line with sku null (and null
// unit_price / line_total) while GET /orders/{id}?_fields=order_items carries
// the SKU. Live: StellarKBeauty Shopee 2610083JN2X503 (OneCart 14408268,
// READY_TO_SHIP, 8 Oct 2026) — the pull logged it as skippedNoLines and
// dropped it every 30 minutes. Part 1 proves the matcher on its own; part 2
// drives the REAL server's pull against a local OneCart stub.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const net  = require('net');
const http = require('http');
const { spawn } = require('child_process');
const oc = require('../lib/onecart');

const savedBase = process.env.ONECART_BASE;
delete process.env.ONECART_BASE;
after(() => { if (savedBase !== undefined) process.env.ONECART_BASE = savedBase; });

// The live payloads, verbatim apart from the redacted customer fields.
const LIVE_ROW = {
  id: 14408268, order_no: '2610083JN2X503', platform: 'Shopee', shop_id: 340,
  order_date: '2026-10-08T01:45:15.000Z', status: 'READY_TO_SHIP', shop_name: 'Stellar K-Beauty',
  shipping_address: 'x', shipping_postal_code: '000000', shipping_phone_number: '', first_name: 'A', last_name: 'B',
  line_items: [{ sku: null, quantity: 1, unit_price: null, line_total: null,
    name: '[New & Updated] BAO H. Lab Hair Loss Care Roll-on Treatment 15ml Hair Loss & Sensitive Scalp, Hair Strength & Thinning',
    is_bundle_component: false }],
};
const LIVE_ITEMS = [{ variant_id: 14552198, sku: 'BAO_AMP_15', qty: 1, unit_price: 41.9, line_total: 41.9, original_unit_price: null, original_line_total: null }];

// ── Part 1: the matcher ─────────────────────────────────────────────────────

test('live case: the blank line takes BAO_AMP_15 / qty 1 / 41.90 from order_items', () => {
  assert.equal(oc.needsOrderItemsFallback(LIVE_ROW), true);
  assert.equal(oc.mapDeliveryOrder(LIVE_ROW).rows.length, 0, 'before: nothing to import');
  const r = oc.fillLinesFromOrderItems(LIVE_ROW, LIVE_ITEMS);
  assert.equal(r.recovered, 1); assert.equal(r.unresolved, 0);
  assert.deepEqual(r.lines, [{ sku: 'BAO_AMP_15', qty: 1, source: 'orders_fallback', matchedBy: 'position' }]);
  const li = r.order.line_items[0];
  assert.equal(li.unit_price, 41.9); assert.equal(li.line_total, 41.9); assert.equal(li.variant_id, 14552198);
  assert.equal(LIVE_ROW.line_items[0].sku, null, 'the input row is not mutated');
  const m = oc.mapDeliveryOrder(r.order);
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].sku, 'BAO_AMP_15'); assert.equal(m.rows[0].qty, 1);
  assert.match(m.rows[0].description, /BAO H\. Lab/, 'the queue line keeps its name');
});

test('a row whose lines all carry a SKU never asks for the fallback', () => {
  const d = { id: 1, order_no: 'A1', line_items: [{ sku: 'X', quantity: 2 }, { sku: 'Y', quantity: 1 }] };
  assert.equal(oc.needsOrderItemsFallback(d), false);
  assert.equal(oc.needsOrderItemsFallback({ id: 2, line_items: [] }), true, 'no lines at all → ask');
  assert.equal(oc.needsOrderItemsFallback({ id: 3 }), true);
});

test('mixed row: the line that has a SKU is not duplicated; the blank one gets the other item', () => {
  const d = { id: 5, order_no: 'M1', line_items: [{ sku: 'AAA', quantity: 2, name: 'a' }, { sku: '', quantity: 1, name: 'b' }] };
  const r = oc.fillLinesFromOrderItems(d, [{ sku: 'AAA', qty: 2 }, { sku: 'BBB', qty: 1, unit_price: 5 }]);
  assert.deepEqual(r.lines.map(l => [l.sku, l.qty, l.source]), [['AAA', 2, 'delivery_orders'], ['BBB', 1, 'orders_fallback']]);
  assert.equal(oc.mapDeliveryOrder(r.order).rows.length, 2);
});

test('variant_id wins over position when the queue line carries one', () => {
  const d = { id: 6, order_no: 'V1', line_items: [{ sku: null, quantity: 1, variant_id: 22 }, { sku: null, quantity: 3, variant_id: 11 }] };
  const r = oc.fillLinesFromOrderItems(d, [{ variant_id: 11, sku: 'ELEVEN', qty: 3 }, { variant_id: 22, sku: 'TWENTYTWO', qty: 1 }]);
  assert.deepEqual(r.lines.map(l => [l.sku, l.qty, l.matchedBy]), [['TWENTYTWO', 1, 'variant_id'], ['ELEVEN', 3, 'variant_id']]);
});

test('counts differ: a blank line is matched by quantity only when exactly one item fits', () => {
  const d = { id: 7, order_no: 'Q1', line_items: [{ sku: null, quantity: 2 }] };
  const ok = oc.fillLinesFromOrderItems(d, [{ sku: 'P', qty: 1 }, { sku: 'Q', qty: 2 }]);
  assert.deepEqual(ok.lines.map(l => [l.sku, l.matchedBy]), [['Q', 'quantity']]);
  const d2 = { id: 8, order_no: 'Q2', line_items: [{ sku: 'K', quantity: 1 }, { sku: null, quantity: 1 }] };
  const amb = oc.fillLinesFromOrderItems(d2, [{ sku: 'K', qty: 1 }, { sku: 'P', qty: 1 }, { sku: 'R', qty: 1 }]);
  assert.deepEqual(amb.lines.map(l => l.sku), ['K'], 'ambiguous → left blank, never guessed');
  assert.equal(amb.unresolved, 1);
});

test('the order record has no SKU either → still nothing to import (skip as today)', () => {
  const r = oc.fillLinesFromOrderItems(LIVE_ROW, [{ variant_id: 1, sku: null, qty: 1 }]);
  assert.equal(r.recovered, 0); assert.equal(r.unresolved, 1);
  assert.equal(oc.mapDeliveryOrder(r.order).rows.length, 0);
  assert.equal(oc.mapDeliveryOrder(oc.fillLinesFromOrderItems(LIVE_ROW, []).order).rows.length, 0);
});

test('blank bundle components: the order record parent is taken, not dropped by the parent rule', () => {
  const d = { id: 9, order_no: 'B1', line_items: [
    { sku: null, quantity: 1, is_bundle_component: true, bundle_sku: 'KIT-1', name: 'piece a' },
    { sku: null, quantity: 2, is_bundle_component: true, bundle_sku: 'KIT-1', name: 'piece b' },
  ] };
  const r = oc.fillLinesFromOrderItems(d, [{ sku: 'KIT-1', qty: 1 }]);
  assert.deepEqual(r.lines.map(l => [l.sku, l.qty, l.matchedBy]), [['KIT-1', 1, 'order_items']]);
  assert.equal(r.unresolved, 0);
  const m = oc.mapDeliveryOrder(r.order);
  assert.deepEqual(m.rows.map(x => [x.sku, x.qty]), [['KIT-1', 1]]);
});

test('components WITH a SKU still stand in for their parent (unchanged)', () => {
  const d = { id: 10, order_no: 'B2', line_items: [
    { sku: 'KIT-2', quantity: 1, is_bundle_component: false },
    { sku: 'PA', quantity: 1, is_bundle_component: true, bundle_sku: 'KIT-2' },
    { sku: 'PB', quantity: 1, is_bundle_component: true, bundle_sku: 'KIT-2' },
  ] };
  assert.deepEqual(oc.mapDeliveryOrder(d).rows.map(x => x.sku), ['PA', 'PB']);
});

test('an empty queue line list takes the order record lines', () => {
  const r = oc.fillLinesFromOrderItems({ id: 11, order_no: 'E1', line_items: [] }, [{ sku: 'S1', qty: 2 }, { sku: 'S2', qty: 1 }]);
  assert.deepEqual(r.lines.map(l => [l.sku, l.qty, l.source]), [['S1', 2, 'orders_fallback'], ['S2', 1, 'orders_fallback']]);
});

// ── getOrderItems: the request and its timeout ──────────────────────────────

function listen(handler) { return new Promise(res => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); }); }

test('getOrderItems asks for _fields=id,order_items and returns the items', async () => {
  let url = null;
  const s = await listen((req, res) => { url = req.url; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: { id: 14408268, order_items: LIVE_ITEMS }, meta: {}, errors: [], warnings: [] })); });
  try {
    const items = await oc.getOrderItems({ apiKey: 'k', endpoint: `http://127.0.0.1:${s.address().port}/api/v2` }, 14408268);
    assert.equal(url, '/api/v2/orders/14408268?_fields=id%2Corder_items');
    assert.deepEqual(items, LIVE_ITEMS);
  } finally { s.closeAllConnections(); await new Promise(r => s.close(r)); }
});

test('getOrderItems gives up at its timeout with code TIMEOUT', async () => {
  const s = await listen(() => { /* never answers */ });
  try {
    const t0 = Date.now();
    await assert.rejects(() => oc.getOrderItems({ apiKey: 'k', endpoint: `http://127.0.0.1:${s.address().port}/api/v2` }, 1, { timeoutMs: 300 }),
      e => e instanceof oc.OnecartError && e.code === 'TIMEOUT');
    assert.ok(Date.now() - t0 < 3000);
  } finally { s.closeAllConnections(); await new Promise(r => s.close(r)); }
});

// ── Part 2: the real pull against a stub ────────────────────────────────────

const ROOT   = path.resolve(__dirname, '..');
const SERVER = process.env.IDEALONE_SERVER || path.join(ROOT, 'server.js');
const MASTER = process.env.MASTER_KEY || '201432547E';
let DDIR, PORT, B, child, token, stub, STUB;
const calls = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': token, 'x-master-key': MASTER });
function freePort() { return new Promise(res => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); }); }
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('server did not come up: ' + url); }

const QUEUE = [
  LIVE_ROW,
  { id: 500, order_no: 'NORMAL-1', platform: 'Lazada', status: 'pending', order_date: '2026-10-08T01:00:00.000Z',
    line_items: [{ sku: 'NORM_SKU', quantity: 2, name: 'normal', is_bundle_component: false }] },
  { id: 501, order_no: 'NOSKU-ANYWHERE', platform: 'Shopee', status: 'READY_TO_SHIP', order_date: '2026-10-08T01:00:00.000Z',
    line_items: [{ sku: null, quantity: 1, name: 'mystery', is_bundle_component: false }] },
];
const ORDER_ITEMS = { 14408268: LIVE_ITEMS, 501: [{ variant_id: 9, sku: null, qty: 1 }] };

before(async () => {
  stub = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push(u.pathname + u.search);
    const send = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname === '/api/v2/delivery_orders') return send({ data: QUEUE, meta: { has_next_page: false, total_items: QUEUE.length }, errors: [], warnings: [] });
    if (u.pathname === '/api/v2/orders') return send({ data: [], meta: { has_next_page: false }, errors: [], warnings: [] });
    const m = u.pathname.match(/^\/api\/v2\/orders\/(\d+)$/);
    if (m) return send({ data: { id: Number(m[1]), order_items: ORDER_ITEMS[m[1]] || [] }, meta: {}, errors: [], warnings: [] });
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no' } }));
  });
  STUB = `http://127.0.0.1:${stub.address().port}/api/v2`;
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idealone-ocfb-'));
  PORT = await freePort(); B = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: DDIR }; delete env.ONECART_BASE;
  const log = fs.openSync(path.join(DDIR, 'server.log'), 'a');
  child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', log, log] });
  await waitUp(B + '/api/version'); await sleep(2500);
  const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }));
  assert.ok(d.token, 'demo login'); token = d.token;
});
after(async () => {
  if (child) { child.kill('SIGTERM'); await new Promise(r => { child.once('exit', r); setTimeout(r, 5000); }); }
  if (stub) { stub.closeAllConnections(); await new Promise(r => stub.close(r)); }
  try { fs.rmSync(DDIR, { recursive: true, force: true }); } catch {}
});

test('the pull imports the live blank-SKU order from the order record, and only asks for blank rows', async () => {
  const st = await J(await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: H(),
    body: JSON.stringify({ clientName: 'StellarKBeauty', apiKey: 'stub-key', endpoint: STUB, enabled: false, autoPullMinutes: 0 }) }));
  assert.ok(st.id, 'store saved ' + JSON.stringify(st));
  const r = await fetch(B + `/api/master/onecart/stores/${st.id}/pull`, { method: 'POST', headers: H() });
  const out = await J(r);
  assert.equal(r.status, 200, JSON.stringify(out).slice(0, 300));
  assert.equal(out.imported, 2, 'the live order and the normal one: ' + JSON.stringify(out));
  assert.deepEqual(out.skippedNoLines, ['NOSKU-ANYWHERE'], 'skipped only when the order record has no SKU either');
  const fb = out.lineFallback;
  assert.equal(fb.candidates, 2); assert.equal(fb.attempted, 2); assert.equal(fb.recoveredCount, 1);
  assert.equal(fb.recovered[0].order, '2610083JN2X503');
  assert.deepEqual(fb.recovered[0].lines, [{ sku: 'BAO_AMP_15', qty: 1, source: 'orders_fallback', matchedBy: 'position' }]);
  assert.equal(fb.noSkuOnOrder[0].order, 'NOSKU-ANYWHERE');
  const detail = calls.filter(c => /^\/api\/v2\/orders\/\d+/.test(c));
  assert.deepEqual(detail.sort(), ['/api/v2/orders/14408268?_fields=id%2Corder_items', '/api/v2/orders/501?_fields=id%2Corder_items'],
    'no fallback call for the row whose lines already have SKUs');

  await sleep(1500);
  const db = JSON.parse(fs.readFileSync(path.join(DDIR, 'tenants', 'default', 'db.json'), 'utf8'));
  const batch = db.batches.find(b => b.id === out.batchId);
  assert.equal(batch.reference_only, true, 'default reference mode respected');
  const live = batch.orders.find(o => o.order_number === '2610083JN2X503');
  assert.deepEqual(live.lines.map(l => [l.sku, l.qty]), [['BAO_AMP_15', 1]]);
  assert.equal(live.onecart_id, '14408268');
  assert.equal(live.onecart_line_sources[0].source, 'orders_fallback');
  const normal = batch.orders.find(o => o.order_number === 'NORMAL-1');
  assert.deepEqual(normal.lines.map(l => [l.sku, l.qty]), [['NORM_SKU', 2]]);
  assert.equal(normal.onecart_line_sources, undefined, 'an order with SKU lines is untouched');
  const aud = (db.auditLog || []).filter(e => e.type === 'onecart_line_fallback');
  assert.deepEqual(aud.map(e => e.outcome).sort(), ['no_sku_on_order', 'recovered']);

  // A second pull holds the order: no new import, no second fallback call for it.
  calls.length = 0;
  const out2 = await J(await fetch(B + `/api/master/onecart/stores/${st.id}/pull`, { method: 'POST', headers: H() }));
  assert.equal(out2.imported, 0);
  assert.deepEqual(calls.filter(c => /^\/api\/v2\/orders\/\d+/.test(c)), ['/api/v2/orders/501?_fields=id%2Corder_items']);
});
