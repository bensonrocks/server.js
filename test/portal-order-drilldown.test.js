// Portal Orders drill-down — GET /api/portal/orders/drilldown?bucket=&day=
//
// Per the user: a client taps a count in the Orders tab's day table (or one of
// the In progress / Completed / Cancelled tiles) and sees the orders behind it.
// Proved through the REAL server on a throwaway DATA_DIR:
//   - every count the screen derives from /api/portal/orders opens EXACTLY the
//     orders it counted (same population, same cap, same day rule)
//   - each row carries order no, channel, date, status, waybill and item lines
//   - a cancellation carries its reason, time and whether it was automatic
//   - CLIENT ISOLATION, enforced on the server: another client's orders never
//     appear — not by bucket, not by day, not via a shared order number, not
//     via a smuggled ?client= — and no token / a staff token is refused
//   - the Orders section switched off refuses the drill-down too
//   - the 300-row cap is honoured, so "Completed 300" opens 300, not 305
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 5000 + Math.floor(Math.random() * 800) + 37;
const B = `http://localhost:${PORT}`;
const MASTER = process.env.MASTER_KEY || '201432547E';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
let kid, DDIR, tokA, tokB, tokC, tokHidden, staff;

const SGT = { timeZone: 'Asia/Singapore' };
const sgDay = v => { if (!v) return ''; const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('en-CA', SGT); };
// Noon SGT, N days from today — never near a midnight edge, whatever time the
// suite runs.
const sgDayOffset = n => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', SGT);
const noon = n => new Date(`${sgDayOffset(n)}T12:00:00+08:00`).toISOString();
const TODAY = sgDayOffset(0), YDAY = sgDayOffset(-1), D2 = sgDayOffset(-2);

// MIRROR of orderDay() in public/portal.js — the rule the screen counts by.
function orderDay(o) {
  if (o.status === 'unprocessed') return sgDay(o.cancelled?.at || o.date);
  if (o.status === 'done') return sgDay(o.completed_at || o.date);
  return sgDay(o.date);
}
const bucketOf = s => s === 'unprocessed' ? 'cancelled' : s === 'done' ? 'done' : 'open';

function startServer() {
  kid = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR }, stdio: 'ignore', detached: true });
}
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await fetch(B + '/api/version')).ok) return; } catch {} await sleep(400); } throw new Error('server did not boot'); }
async function stopServer() { try { process.kill(-kid.pid, 'SIGTERM'); } catch {} await sleep(1500); }
function findDb(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const f = findDb(p); if (f) return f; } else if (e.name === 'db.json') return p; } return null; }

const line = (sku, description, qty) => ({ sku, description, qty });
function seed(dbPath) {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const A = {
    id: 'b-acme', idealscan_code: 'IS-DD-1', client_name: 'ACMECO', filename: 'a.xlsx',
    uploaded_at: noon(-2), uploaded_by: 'demo',
    orders: [
      { order_number: 'A-OPEN-1', platform: 'Shopee', waybill_number: 'SPXSG0001', date: noon(0), total_qty: 3,
        lines: [line('ACM-TEA', 'Jasmine Tea 50g', 2), line('ACM-CUP', 'Glass Cup', 1)] },
      { order_number: 'A-OPEN-2', keyed_in_portal: true, order_source: 'portal', date: TODAY, total_qty: 1,
        lines: [line('ACM-CUP', 'Glass Cup', 1)] },
      { order_number: 'A-DONE-1', platform: 'TikTok', shop_name: 'Acme Official', waybill_number: 'TT778899',
        date: noon(-1), total_qty: 4, lines: [line('ACM-TEA', 'Jasmine Tea 50g', 4)] },
      { order_number: 'A-DONE-2', platform: 'Lazada', waybill_number: 'LZ555', date: noon(-3), total_qty: 1,
        lines: [line('ACM-POT', 'Clay Teapot', 1)] },
      { order_number: 'A-CX-AUTO', platform: 'Shopee', date: noon(-1), total_qty: 2,
        lines: [line('ACM-POT', 'Clay Teapot', 2)] },
      { order_number: 'A-CX-MAN', platform: 'Shopee', date: noon(-2), total_qty: 1,
        lines: [line('ACM-TEA', 'Jasmine Tea 50g', 1)] },
      { order_number: 'A-WITHDRAWN', date: noon(0), total_qty: 1, lines: [line('ACM-TEA', 'Jasmine Tea 50g', 1)] },
      { order_number: 'SHARED-1', date: noon(0), total_qty: 1, lines: [line('ACM-CUP', 'Glass Cup', 1)] },
    ],
    orderStates: {
      'A-OPEN-1': { status: 'pending', scanned: {} },
      'A-OPEN-2': { status: 'processing', scanned: {} },
      'A-DONE-1': { status: 'done', endTime: noon(0), scanned: { 'ACM-TEA': 4 } },
      'A-DONE-2': { status: 'done', endTime: noon(-2), scanned: { 'ACM-POT': 1 } },
      'A-CX-AUTO': { status: 'unprocessed', unprocessed_at: noon(0),
        unprocessed_reason: 'No stock available — cancelled automatically',
        auto_cancelled: { at: noon(0), why: 'no_stock', short: [{ sku: 'ACM-POT', need: 2, have: 0 }] }, scanned: {} },
      'A-CX-MAN': { status: 'unprocessed', unprocessed_at: noon(-1), unprocessed_reason: 'Customer asked to cancel', scanned: {} },
      'A-WITHDRAWN': { status: 'pending', client_cancelled: { at: noon(0), by: 'portal:ops' }, scanned: {} },
      'SHARED-1': { status: 'pending', scanned: {} },
    },
  };
  const Bt = {
    id: 'b-other', idealscan_code: 'IS-DD-2', client_name: 'OTHERCO', filename: 'b.xlsx',
    uploaded_at: noon(0), uploaded_by: 'demo',
    orders: [
      { order_number: 'B-OPEN-1', platform: 'Shopee', waybill_number: 'SPXOTHER', date: noon(0), total_qty: 9,
        lines: [line('B-SECRET', 'Other Client Secret Product', 9)] },
      { order_number: 'SHARED-1', date: noon(0), total_qty: 5, lines: [line('B-SECRET', 'Other Client Secret Product', 5)] },
      { order_number: 'B-CX-1', date: noon(0), total_qty: 1, lines: [line('B-SECRET', 'Other Client Secret Product', 1)] },
    ],
    orderStates: {
      'B-OPEN-1': { status: 'pending', scanned: {} },
      'SHARED-1': { status: 'done', endTime: noon(0), scanned: { 'B-SECRET': 5 } },
      'B-CX-1': { status: 'unprocessed', unprocessed_at: noon(0), unprocessed_reason: 'OTHERCO internal reason', scanned: {} },
    },
  };
  // CAPCO: more completed orders than the list cap (300), oldest ones fall off.
  const capOrders = [], capStates = {};
  for (let i = 0; i < 305; i++) {
    const n = `CAP-${1000 + i}`;
    capOrders.push({ order_number: n, date: new Date(Date.now() - (i + 1) * 3600000).toISOString(), total_qty: 1, lines: [line('CAP-X', 'Cap item', 1)] });
    capStates[n] = { status: 'done', endTime: new Date(Date.now() - (i + 1) * 3600000).toISOString(), scanned: { 'CAP-X': 1 } };
  }
  const C = { id: 'b-cap', idealscan_code: 'IS-DD-3', client_name: 'CAPCO', filename: 'c.xlsx', uploaded_at: noon(0),
              uploaded_by: 'demo', orders: capOrders, orderStates: capStates };
  db.batches = [A, Bt, C];
  fs.writeFileSync(dbPath, JSON.stringify(db));
}

const MH = { 'Content-Type': 'application/json', 'x-master-key': MASTER };
async function portalToken(client, id, visibility) {
  await fetch(B + '/api/master/client-profiles', { method: 'POST', headers: MH, body: JSON.stringify({ client }) });
  const body = { id, name: id, password: 'Passw0rd!x', access: 'full' };
  if (visibility) body.visibility = visibility;
  const u = await fetch(B + `/api/master/client-profiles/${encodeURIComponent(client)}/portal-users`, { method: 'POST', headers: MH, body: JSON.stringify(body) });
  const ud = await J(u);
  const user = (ud.user || ud).id || id;
  const l = await J(await fetch(B + '/api/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, user, password: 'Passw0rd!x' }) }));
  if (!l.token) throw new Error(`portal login failed for ${client}: ${JSON.stringify(l)} / ${JSON.stringify(ud)}`);
  return l.token;
}
const G = (t, p) => fetch(B + p, { headers: t ? { 'x-auth-token': t } : {} });
const drill = async (t, bucket, day, extra = '') => {
  const r = await G(t, `/api/portal/orders/drilldown?bucket=${bucket}${day ? `&day=${day}` : ''}${extra}`);
  return { status: r.status, ...(await J(r)) };
};
const nums = d => (d.orders || []).map(o => o.order_number).sort();

test.before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-'));
  startServer(); await waitUp(); await sleep(2500); await stopServer();   // let it write db.json
  const dbp = findDb(DDIR);
  if (!dbp) throw new Error('no db.json after first boot');
  seed(dbp);
  startServer(); await waitUp();
  tokA = await portalToken('ACMECO', 'acmeops');
  tokB = await portalToken('OTHERCO', 'otherops');
  tokC = await portalToken('CAPCO', 'capops');
  tokHidden = await portalToken('ACMECO', 'nolist', { orders: false });
  staff = (await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }))).token;
});
test.after(async () => { await stopServer(); fs.rmSync(DDIR, { recursive: true, force: true }); });

test('every count the screen shows opens exactly the orders it counted', async () => {
  const list = await J(await G(tokA, '/api/portal/orders'));
  assert.ok(Array.isArray(list) && list.length, 'list loads');
  // Rebuild the day table and the tiles the way portal.js does.
  const cells = new Map(), tiles = { open: [], done: [], cancelled: [] };
  for (const o of list) {
    const k = `${bucketOf(o.status)}|${orderDay(o)}`;
    cells.set(k, [...(cells.get(k) || []), o.order_number]);
    tiles[bucketOf(o.status)].push(o.order_number);
  }
  assert.ok(cells.size >= 5, 'several non-zero cells to check');
  for (const [k, want] of cells) {
    const [bucket, day] = k.split('|');
    const d = await drill(tokA, bucket, day);
    assert.strictEqual(d.status, 200);
    assert.deepStrictEqual(nums(d), want.sort(), `cell ${k}`);
    assert.strictEqual(d.total, want.length);
  }
  for (const [bucket, want] of Object.entries(tiles)) {
    const d = await drill(tokA, bucket, '');
    assert.deepStrictEqual(nums(d), want.sort(), `tile ${bucket}`);
  }
});

test('the example from the brief: today reads 2 in progress / 1 completed… and opens them', async () => {
  const open = await drill(tokA, 'open', TODAY);
  assert.deepStrictEqual(nums(open), ['A-OPEN-1', 'A-OPEN-2', 'SHARED-1']);
  const done = await drill(tokA, 'done', TODAY);
  assert.deepStrictEqual(nums(done), ['A-DONE-1'], 'counted on the day it was COMPLETED, not ordered');
  const cx = await drill(tokA, 'cancelled', TODAY);
  assert.deepStrictEqual(nums(cx), ['A-CX-AUTO'], 'counted on the day it was CANCELLED');
  assert.deepStrictEqual(nums(await drill(tokA, 'cancelled', YDAY)), ['A-CX-MAN']);
  assert.deepStrictEqual(nums(await drill(tokA, 'done', D2)), ['A-DONE-2']);
});

test('each row carries order no, channel, date, status, waybill and item lines', async () => {
  const open = await drill(tokA, 'open', TODAY);
  const o1 = open.orders.find(o => o.order_number === 'A-OPEN-1');
  assert.strictEqual(o1.channel, 'Shopee');
  assert.strictEqual(o1.status, 'pending');
  assert.strictEqual(o1.waybill, 'SPXSG0001');
  assert.strictEqual(sgDay(o1.date), TODAY);
  assert.deepStrictEqual(o1.lines.map(l => [l.sku, l.name, l.qty]), [['ACM-TEA', 'Jasmine Tea 50g', 2], ['ACM-CUP', 'Glass Cup', 1]]);
  assert.strictEqual(o1.total_qty, 3);
  assert.strictEqual(o1.cancelled, null);
  const o2 = open.orders.find(o => o.order_number === 'A-OPEN-2');
  assert.strictEqual(o2.channel, 'Client portal', 'a keyed-in order says where it came from');
  assert.strictEqual(o2.status, 'processing');
  assert.strictEqual(o2.waybill, '');
  const d1 = (await drill(tokA, 'done', TODAY)).orders[0];
  assert.strictEqual(d1.channel, 'TikTok · Acme Official');
  assert.ok(d1.completed_at);
});

test('a cancellation carries its reason, its time and whether it was automatic', async () => {
  const auto = (await drill(tokA, 'cancelled', TODAY)).orders[0];
  assert.strictEqual(auto.cancelled.reason, 'No stock available — cancelled automatically');
  assert.strictEqual(auto.cancelled.automatic, true);
  assert.strictEqual(auto.cancelled.why, 'no_stock');
  assert.strictEqual(auto.cancelled.at, noon(0));
  const man = (await drill(tokA, 'cancelled', YDAY)).orders[0];
  assert.strictEqual(man.cancelled.reason, 'Customer asked to cancel');
  assert.strictEqual(man.cancelled.automatic, false);
  assert.strictEqual(man.cancelled.at, noon(-1));
});

test('an order the client withdrew themselves is not in any bucket (it is not in the list either)', async () => {
  for (const b of ['open', 'done', 'cancelled']) {
    assert.ok(!nums(await drill(tokA, b, '')).includes('A-WITHDRAWN'));
  }
});

test('CLIENT ISOLATION: another client\'s orders never appear, however asked', async () => {
  const everyA = [];
  for (const b of ['open', 'done', 'cancelled']) everyA.push(...(await drill(tokA, b, '')).orders);
  const blobA = JSON.stringify(everyA);
  for (const foreign of ['B-OPEN-1', 'B-CX-1', 'B-SECRET', 'Other Client Secret Product', 'SPXOTHER', 'OTHERCO internal reason', 'CAP-1000'])
    assert.ok(!blobA.includes(foreign), `ACMECO must not see ${foreign}`);
  // A SHARED order number resolves to each client's OWN order.
  const sharedA = everyA.filter(o => o.order_number === 'SHARED-1');
  assert.strictEqual(sharedA.length, 1);
  assert.strictEqual(sharedA[0].status, 'pending');
  assert.deepStrictEqual(sharedA[0].lines.map(l => l.sku), ['ACM-CUP']);
  const doneB = await drill(tokB, 'done', TODAY);
  assert.deepStrictEqual(nums(doneB), ['SHARED-1']);
  assert.deepStrictEqual(doneB.orders[0].lines.map(l => l.sku), ['B-SECRET']);
  const blobB = JSON.stringify([...(await drill(tokB, 'open', '')).orders, ...(await drill(tokB, 'cancelled', '')).orders, ...doneB.orders]);
  for (const mine of ['A-OPEN-1', 'A-DONE-1', 'A-CX-AUTO', 'ACM-TEA', 'Jasmine Tea'])
    assert.ok(!blobB.includes(mine), `OTHERCO must not see ${mine}`);
  // There is no client parameter to tamper with — a smuggled one is ignored.
  const smuggled = await drill(tokA, 'open', TODAY, '&client=OTHERCO&client_name=OTHERCO');
  assert.deepStrictEqual(nums(smuggled), ['A-OPEN-1', 'A-OPEN-2', 'SHARED-1']);
});

test('no token, a bogus token, and a STAFF token are all refused', async () => {
  assert.strictEqual((await drill(null, 'open', '')).status, 401);
  assert.strictEqual((await drill('not-a-token', 'open', '')).status, 401);
  assert.ok(staff, 'staff login works');
  assert.strictEqual((await drill(staff, 'open', '')).status, 401, 'a staff session is not a portal session');
});

test('a login with the Orders section switched off cannot drill down either', async () => {
  const d = await drill(tokHidden, 'open', '');
  assert.strictEqual(d.status, 403);
  assert.strictEqual(d.hiddenSection, 'orders');
});

test('bad input is refused rather than guessed at', async () => {
  assert.strictEqual((await drill(tokA, 'everything', '')).status, 400);
  assert.strictEqual((await drill(tokA, '', '')).status, 400);
  assert.strictEqual((await drill(tokA, 'open', '17-10-2026')).status, 400);
  assert.strictEqual((await drill(tokA, 'open', "2026-10-17' OR 1=1")).status, 400);
});

test('the list cap is honoured: Completed reads 300 and opens 300', async () => {
  const list = await J(await G(tokC, '/api/portal/orders'));
  const doneInList = list.filter(o => o.status === 'done').map(o => o.order_number).sort();
  assert.strictEqual(doneInList.length, 300);
  const d = await drill(tokC, 'done', '');
  assert.strictEqual(d.total, 300);
  assert.deepStrictEqual(nums(d), doneInList);
  assert.ok(!nums(d).includes('CAP-1304'), 'the oldest, off the page, is not in the drill-down');
});

test('the screen mirrors the server: orderDay() in portal.js uses the same rule', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.js'), 'utf8');
  assert.match(src, /if \(o\.status === 'unprocessed'\) return sgDay\(o\.cancelled\?\.at \|\| o\.date\);/);
  assert.match(src, /if \(o\.status === 'done'\)\s+return sgDay\(o\.completed_at \|\| o\.date\);/);
  assert.match(src, /\/api\/portal\/orders\/drilldown\?bucket=/, 'the sheet asks the server, not the cached list');
  assert.match(src, /class="dd-n"/, 'day-table counts are buttons');
  assert.match(src, /class="dd-tile"/, 'status tiles are buttons');
});
