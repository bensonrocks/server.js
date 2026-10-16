// Portal New Order (key-in + Excel/CSV + waybill) through the REAL server on a
// throwaway DATA_DIR: orders land via the shared intake (runOrderIntake),
// filed under the logged-in client, tagged source 'portal'; unknown SKUs,
// duplicate order nos (existing + same file) and missing fields are refused per
// order; step 2 attaches a label (attachLabelPage) or a tracking number.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');

const PORT = 4000 + Math.floor(Math.random() * 900) + 50;
const B = `http://localhost:${PORT}`;
const MASTER = process.env.MASTER_KEY || '201432547E';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return { ...JSON.parse(t), status: r.status }; } catch { return { status: r.status, _raw: t }; } };
let kid, DDIR, tok, tokB, admin;
// The persisted db (debounced writes): poll until it contains `needle`.
function findDb(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const f = findDb(p); if (f) return f; } else if (e.name === 'db.json') return p; } return null; }
async function dbSnap(needle) {
  for (let i = 0; i < 40; i++) { const f = findDb(DDIR); if (f) { const s = fs.readFileSync(f, 'utf8'); if (!needle || s.includes(needle)) return JSON.parse(s); } await sleep(250); }
  throw new Error('db never contained ' + needle);
}

async function boot() {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pno-'));
  kid = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR }, stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/version')).status < 500) break; } catch {} await sleep(500); }
  await sleep(1500);
}
async function seedClient(client, skus) {
  const MH = { 'Content-Type': 'application/json', 'x-master-key': MASTER, 'x-auth-token': admin };
  await fetch(B + '/api/inventory/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': admin },
    body: JSON.stringify({ clientId: client, items: skus.map(s => ({ sku: s, name: s + ' name', stock_qty: 500 })) }) });
  await J(await fetch(B + '/api/master/client-profiles', { method: 'POST', headers: MH, body: JSON.stringify({ client }) }));
  const u = await J(await fetch(B + `/api/master/client-profiles/${encodeURIComponent(client)}/portal-users`, { method: 'POST', headers: MH, body: JSON.stringify({ name: 'ops', access: 'full', password: 'Passw0rd!x' }) }));
  const user = (u.user || u).id || 'ops';
  const l = await J(await fetch(B + '/api/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, user, password: 'Passw0rd!x' }) }));
  if (!l.token) throw new Error('portal login failed: ' + JSON.stringify(l) + ' user ' + JSON.stringify(u));
  return l.token;
}
const P = (t, p, body, isForm) => fetch(B + p, { method: 'POST', headers: { 'x-auth-token': t, ...(isForm ? {} : { 'Content-Type': 'application/json' }) }, body: isForm ? body : JSON.stringify(body) });
const G = (t, p) => fetch(B + p, { headers: { 'x-auth-token': t } });
const order = (no, extra = {}) => ({ order_number: no, channel: 'Shopee', recipient_name: 'Tan Mei Ling', phone: '91234567', address: '10 Anson Road', postal_code: '079903', remarks: 'hi', lines: [{ sku: 'PNO-A', qty: 2 }], ...extra });

test.before(async () => {
  await boot();
  const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }));
  admin = d.token;
  tok = await seedClient('PNOCLIENT', ['PNO-A', 'PNO-B']);
  tokB = await seedClient('OTHERCO', ['OTH-1']);
});
test.after(async () => { try { process.kill(-kid.pid, 'SIGTERM'); } catch {} await sleep(500); fs.rmSync(DDIR, { recursive: true, force: true }); });

test('items endpoint lists only the client\'s own item master', async () => {
  const d = await J(await G(tok, '/api/portal/orders/new/items'));
  assert.deepStrictEqual(d.items.map(i => i.sku), ['PNO-A', 'PNO-B']);
});

test('template downloads (xlsx + csv) with the documented columns', async () => {
  const x = await G(tok, '/api/portal/orders/new/template');
  assert.strictEqual(x.status, 200);
  const wb = XLSX.read(Buffer.from(await x.arrayBuffer()));
  assert.deepStrictEqual(XLSX.utils.sheet_to_json(wb.Sheets.Orders, { header: 1 })[0], ['Order No', 'Channel', 'Recipient Name', 'Phone', 'Address', 'Postal Code', 'Remarks', 'SKU', 'Qty']);
  const c = await (await G(tok, '/api/portal/orders/new/template?format=csv')).text();
  assert.ok(c.startsWith('Order No,Channel,Recipient Name'));
});

test('key-in form: blank order no is auto-generated; order goes through intake under the client, source portal', async () => {
  const d = await J(await P(tok, '/api/portal/orders/new/submit', { mode: 'form', orders: [order('', { lines: [{ sku: 'pno-a', qty: 1 }, { sku: 'PNO-B', qty: '3' }] })] }));
  assert.strictEqual(d.status, 201, JSON.stringify(d));
  assert.strictEqual(d.created, 1);
  const r = d.results[0];
  assert.match(r.order_number, /^PNOCLIENT-\d{8}-001$/);
  assert.ok(r.auto_number && r.job);
  const list = await J(await G(tok, '/api/portal/orders'));
  const rows = list.orders || list.rows || list;
  assert.ok(JSON.stringify(rows).includes(r.order_number), 'order visible in the client\'s own list');
  const other = await J(await G(tokB, '/api/portal/orders'));
  assert.ok(!JSON.stringify(other).includes(r.order_number), 'not visible to another client');
  const det = await J(await G(tok, '/api/portal/order/' + encodeURIComponent(r.order_number)));
  assert.strictEqual(det.status, 200);
  const db = await dbSnap(r.order_number);
  const b = db.batches.find(x => (x.orders || []).some(o => o.order_number === r.order_number));
  assert.strictEqual(b.source, 'portal');
  assert.strictEqual(b.client_name.toUpperCase(), 'PNOCLIENT');
  const o = b.orders.find(x => x.order_number === r.order_number);
  assert.strictEqual(o.order_source, 'portal');
  assert.strictEqual(o.postal_code, '079903');
  assert.strictEqual(o.remarks, 'hi');
  assert.strictEqual(o.platform, 'Shopee');
});

test('rejections: unknown SKU, missing fields, duplicate against existing orders', async () => {
  await J(await P(tok, '/api/portal/orders/new/submit', { mode: 'form', orders: [order('PNO-DUP-1')] }));
  const d = await J(await P(tok, '/api/portal/orders/new/submit', { mode: 'form', orders: [
    order('PNO-DUP-1'), order('PNO-X1', { lines: [{ sku: 'OTH-1', qty: 1 }] }), order('PNO-X2', { recipient_name: '', postal_code: '12' }), order('PNO-OK-1')] }));
  const by = Object.fromEntries(d.results.map(r => [r.order_number, r]));
  assert.strictEqual(d.created, 1);
  assert.ok(by['PNO-OK-1'].ok);
  assert.match(by['PNO-DUP-1'].reason, /already exists/);
  assert.match(by['PNO-X1'].reason, /Unknown SKU OTH-1/, 'another client\'s SKU is unknown here');
  assert.match(by['PNO-X2'].reason, /Recipient name is required/);
  assert.match(by['PNO-X2'].reason, /Postal code must be 6 digits/);
  // all failed → 400, nothing created
  const z = await J(await P(tok, '/api/portal/orders/new/submit', { mode: 'file', orders: [order('')] }));
  assert.strictEqual(z.status, 400); assert.strictEqual(z.created, 0); assert.match(z.results[0].reason, /Order No is required/);
});

test('Excel upload: preview flags unknown SKU, in-file duplicate, existing duplicate, missing fields; submit creates only valid', async () => {
  const aoa = [['Order No', 'Channel', 'Recipient Name', 'Phone', 'Address', 'Postal Code', 'Remarks', 'SKU', 'Qty'],
    ['F-1', 'Lazada', 'A', '91111111', '1 Road', '111111', '', 'PNO-A', 1],
    ['F-1', 'Lazada', 'A', '91111111', '1 Road', '111111', '', 'PNO-B', 2],
    ['F-2', '', 'B', '92222222', '2 Road', '222222', '', 'NOPE', 1],
    ['F-3', '', 'C', '93333333', '3 Road', '333333', '', 'PNO-A', 1],
    ['F-1', '', 'Z', '99999999', '9 Road', '999999', '', 'PNO-A', 1],
    ['PNO-DUP-1', '', 'D', '94444444', '4 Road', '444444', '', 'PNO-A', 1],
    ['F-5', '', '', '', '5 Road', '', '', 'PNO-A', ''],
    ['', '', 'E', '95555555', '6 Road', '555555', '', 'PNO-A', 1]];
  const ws = XLSX.utils.aoa_to_sheet(aoa); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
  const fd = new FormData(); fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'orders.xlsx');
  const pv = await J(await P(tok, '/api/portal/orders/new/preview', fd, true));
  assert.strictEqual(pv.status, 200, JSON.stringify(pv));
  const by = Object.fromEntries(pv.orders.map(o => [o.order_number || 'blank', o]));
  assert.ok(by['F-3'].ok);
  assert.match(by['F-1'].errors.join(' '), /duplicate order no in this file/);
  assert.match(by['F-2'].errors.join(' '), /Unknown SKU NOPE/);
  assert.match(by['PNO-DUP-1'].errors.join(' '), /already exists/);
  assert.match(by['F-5'].errors.join(' '), /Recipient name is required.*Phone is required|Phone is required/);
  assert.match(by['F-5'].errors.join(' '), /Qty is required/);
  assert.match(by.blank.errors.join(' '), /Order No is required/);
  assert.strictEqual(pv.valid, 1);
  // nothing written by preview
  const db0 = await dbSnap('PNO-DUP-1');
  assert.ok(!JSON.stringify(db0.batches).includes('"F-3"'));
  const sub = await J(await P(tok, '/api/portal/orders/new/submit', { mode: 'file', orders: pv.orders }));
  assert.strictEqual(sub.created, 1);
  assert.strictEqual(sub.results.find(r => r.ok).order_number, 'F-3');
  // failed rows CSV, one line per item row, with the reason
  const csv = await (await P(tok, '/api/portal/orders/new/failed-csv', { results: sub.results })).text();
  assert.ok(csv.includes('Error'));
  assert.ok(csv.includes('NOPE') && csv.includes('Unknown SKU'));
  assert.ok(!csv.includes('F-3,'));
  // CSV upload works too
  const csvFd = new FormData();
  csvFd.append('file', new Blob(['Order No,Recipient Name,Phone,Address,Postal Code,SKU,Qty\nC-1,X,91234567,1 Rd,123456,PNO-B,4\n']), 'o.csv');
  const pc = await J(await P(tok, '/api/portal/orders/new/preview', csvFd, true));
  assert.strictEqual(pc.valid, 1, JSON.stringify(pc));
  // wrong type
  const bad = new FormData(); bad.append('file', new Blob(['x']), 'o.pdf');
  assert.strictEqual((await P(tok, '/api/portal/orders/new/preview', bad, true)).status, 400);
});

test('step 2: label upload (PDF + image) through attachLabelPage, tracking entry, ownership', async () => {
  await J(await P(tok, '/api/portal/orders/new/submit', { mode: 'form', orders: [order('W-1'), order('W-2'), order('W-3')] }));
  const doc = await PDFDocument.create(); doc.addPage([288, 432]); const pdf = Buffer.from(await doc.save());
  let fd = new FormData(); fd.append('file', new Blob([pdf]), 'label.pdf');
  let r = await J(await P(tok, '/api/portal/orders/W-1/waybill', fd, true));
  assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.strictEqual(r.label, 'primary');
  const lab = await G(tok, '/api/portal/order/W-1/label');
  assert.strictEqual(lab.status, 200); assert.strictEqual(Buffer.from(await lab.arrayBuffer()).slice(0, 5).toString(), '%PDF-');
  // 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fd = new FormData(); fd.append('file', new Blob([png]), 'l.png'); fd.append('tracking', 'SPX123456');
  r = await J(await P(tok, '/api/portal/orders/W-2/waybill', fd, true));
  assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.strictEqual(r.tracking, 'SPX123456');
  fd = new FormData(); fd.append('tracking', 'TRK-0001');
  r = await J(await P(tok, '/api/portal/orders/W-3/waybill', fd, true));
  assert.strictEqual(r.status, 200); assert.strictEqual(r.label, undefined);
  fd = new FormData(); fd.append('tracking', 'TRK-0002');
  assert.strictEqual((await P(tok, '/api/portal/orders/W-3/waybill', fd, true)).status, 409, 'different tracking on an order that has one');
  const db = await dbSnap('TRK-0001');
  assert.strictEqual(db.batches.flatMap(b => b.orders).find(o => o.order_number === 'W-3').waybill_number, 'TRK-0001');
  assert.ok(db.orderLabels['W-2'] && db.orderLabels['W-2'].tracking === 'SPX123456');
  // multi-page PDF refused, bad type refused, nothing to attach refused
  const two = await PDFDocument.create(); two.addPage(); two.addPage();
  fd = new FormData(); fd.append('file', new Blob([Buffer.from(await two.save())]), 'two.pdf');
  assert.strictEqual((await P(tok, '/api/portal/orders/W-3/waybill', fd, true)).status, 400);
  fd = new FormData(); fd.append('file', new Blob(['hello']), 'x.txt');
  assert.strictEqual((await P(tok, '/api/portal/orders/W-3/waybill', fd, true)).status, 400);
  assert.strictEqual((await P(tok, '/api/portal/orders/W-3/waybill', new FormData(), true)).status, 400);
  // another client cannot touch it
  fd = new FormData(); fd.append('tracking', 'HACK0001');
  assert.strictEqual((await P(tokB, '/api/portal/orders/W-1/waybill', fd, true)).status, 404);
});

test('the JSON intake route still behaves as before (shared function)', async () => {
  const r = await J(await fetch(B + '/api/orders/intake', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': admin },
    body: JSON.stringify({ client: 'PNOCLIENT', orders: [{ order_number: 'API-1', customer_name: 'X', delivery_address: 'Y', lines: [{ sku: 'PNO-A', qty: 1 }] }] }) }));
  assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.strictEqual(r.created, 1);
  const again = await J(await fetch(B + '/api/orders/intake', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': admin },
    body: JSON.stringify({ client: 'PNOCLIENT', orders: [{ order_number: 'API-1', customer_name: 'X', delivery_address: 'Y', lines: [{ sku: 'PNO-A', qty: 1 }] }] }) }));
  assert.strictEqual(again.created, 0); assert.strictEqual(again.duplicates.length, 1);
  assert.strictEqual((await J(await fetch(B + '/api/orders/intake', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': admin }, body: '{}' }))).status, 400);
  const db = await dbSnap('API-1');
  assert.strictEqual(db.batches.find(b => b.orders.some(o => o.order_number === 'API-1')).source, 'api');
});

test('view-only login cannot create orders', async () => {
  const MH = { 'Content-Type': 'application/json', 'x-master-key': MASTER, 'x-auth-token': admin };
  const u = await J(await fetch(B + '/api/master/client-profiles/PNOCLIENT/portal-users', { method: 'POST', headers: MH, body: JSON.stringify({ name: 'viewer', access: 'view', password: 'Passw0rd!y' }) }));
  const l = await J(await fetch(B + '/api/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: 'PNOCLIENT', user: (u.user || u).id, password: 'Passw0rd!y' }) }));
  assert.ok(l.token);
  assert.strictEqual((await P(l.token, '/api/portal/orders/new/submit', { mode: 'form', orders: [order('V-1')] })).status, 403);
});
