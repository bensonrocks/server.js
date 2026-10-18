// Portal drill-down Add AWB — the popup behind Orders > "N IN PROGRESS" > view.
//
// Bug (client screen video, StellarKBeauty): Orders tab -> tap 'view' under
// '6 IN PROGRESS' -> popup 'In progress - All recent' -> a Shopify pending
// order card reads 'No waybill yet' with its product table / 'Local Courier'
// detail on show, but there is NO 'Add AWB / Upload AWB' button anywhere and
// tapping the card body is a dead end. The same order in the main Orders list
// does offer the button (PR #98).
//
// Root causes proved here against the REAL server + the shipped portal.js:
//  1. WAYBILL BLANK CHECK DISAGREED WITH THE SERVER. The portal POST endpoint
//     treats a waybill as present only when String(waybill_number).trim() is
//     non-empty, so a whitespace-only waybill_number (as marketplace / file
//     imports can carry) is attachable server-side. But /drilldown, /orders
//     and /order/:n handed the raw string to the screen and portal.js gated
//     the button/form on simple truthiness (`!o.waybill`), so such an order
//     showed a blank "Waybill" pill, no Add AWB button, and a detail with no
//     attach form — in the popup and everywhere else.
//  2. THE POPUP BUTTON'S TAP DEPENDED ON THE NEW-ORDER WIZARD. The only
//     expand-and-focus helper was window.portalAttachWaybill, defined inside
//     setupNewOrder() (which returns early when the wizard markup is absent),
//     and the popup handler called it as `window.portalAttachWaybill && ...`
//     — a silent no-op when it was not there. The fix defines the expand
//     helper in the Orders scope itself and wires both click handlers to it.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 6100 + Math.floor(Math.random() * 800) + 43;
const B = `http://localhost:${PORT}`;
const MASTER = process.env.MASTER_KEY || '201432547E';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return { ...JSON.parse(t), status: r.status }; } catch { return { status: r.status, _raw: t }; } };
let kid, DDIR, tok, tokView, tokHidden, tokB;

function startServer() { kid = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR }, stdio: 'ignore', detached: true }); }
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await fetch(B + '/api/version')).ok) return; } catch {} await sleep(400); } throw new Error('server did not boot'); }
async function stopServer() { try { process.kill(-kid.pid, 'SIGTERM'); } catch {} await sleep(1200); }
function findDb(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const f = findDb(p); if (f) return f; } else if (e.name === 'db.json') return p; } return null; }

const D = '2026-10-18T04:00:00.000Z';
function seed(dbPath) {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const mk = (order_number, extra = {}) => ({ order_number, platform: 'Shopify', shopify_id: 'gid://shopify/Order/1',
    carrier: 'Local Courier', date: D, total_qty: 2, delivery_address: 'Singapore',
    lines: [{ sku: 'VM8_HM_TE350', description: 'VM8 HM TE350', qty: 2 }], ...extra });
  db.batches = [
    { id: 'b-stellar', idealscan_code: 'IS-DDAWB-1', client_name: 'StellarKBeauty', filename: 'shopify.xlsx', uploaded_at: D, uploaded_by: 'shopify-sync', source: 'shopify',
      orders: [
        mk('SK-WS', { waybill_number: '   ' }),          // whitespace-only waybill: blank, attachable
        mk('SK-OPEN'),                                    // no waybill field at all
        mk('SK-HAS', { waybill_number: 'SPXSG00011122233A' }),
        mk('SK-DONE'), mk('SK-CX'),
      ],
      orderStates: {
        'SK-WS': { status: 'pending', scanned: {} },
        'SK-OPEN': { status: 'pending', scanned: {} },
        'SK-HAS': { status: 'pending', scanned: {} },
        'SK-DONE': { status: 'done', endTime: D, scanned: { VM8_HM_TE350: 2 } },
        'SK-CX': { status: 'unprocessed', unprocessed_at: D, unprocessed_reason: 'cancelled', scanned: {} },
      } },
    { id: 'b-other', idealscan_code: 'IS-DDAWB-2', client_name: 'OTHERCO', filename: 'b.xlsx', uploaded_at: D, uploaded_by: 'demo',
      orders: [mk('OTH-1')], orderStates: { 'OTH-1': { status: 'pending', scanned: {} } } },
  ];
  fs.writeFileSync(dbPath, JSON.stringify(db));
}
const MH = { 'Content-Type': 'application/json', 'x-master-key': MASTER };
async function portalToken(client, id, opts = {}) {
  await fetch(B + '/api/master/client-profiles', { method: 'POST', headers: MH, body: JSON.stringify({ client }) });
  const body = { id, name: id, password: 'Passw0rd!x', access: opts.access || 'full', ...(opts.visibility ? { visibility: opts.visibility } : {}) };
  const u = await J(await fetch(B + `/api/master/client-profiles/${encodeURIComponent(client)}/portal-users`, { method: 'POST', headers: MH, body: JSON.stringify(body) }));
  const user = (u.user || u).id || id;
  const l = await J(await fetch(B + '/api/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, user, password: 'Passw0rd!x' }) }));
  if (!l.token) throw new Error(`login failed ${client}: ${JSON.stringify(l)}`);
  return l.token;
}
const G = (t, p) => fetch(B + p, { headers: { 'x-auth-token': t } });
const drill = async (t, bucket) => J(await G(t, `/api/portal/orders/drilldown?bucket=${bucket}`));
const postWb = (t, on, tracking) => { const fd = new FormData(); if (tracking) fd.append('tracking', tracking); return fetch(B + `/api/portal/orders/${encodeURIComponent(on)}/waybill`, { method: 'POST', headers: { 'x-auth-token': t }, body: fd }).then(J); };

test.before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pddawb-'));
  startServer(); await waitUp(); await sleep(2500); await stopServer();
  const dbp = findDb(DDIR); if (!dbp) throw new Error('no db.json after first boot');
  seed(dbp);
  startServer(); await waitUp();
  tok = await portalToken('StellarKBeauty', 'gena');
  tokView = await portalToken('StellarKBeauty', 'gena-view', { access: 'view' });
  tokHidden = await portalToken('StellarKBeauty', 'gena-nolist', { visibility: { orders: false } });
  tokB = await portalToken('OTHERCO', 'otherops');
});
test.after(async () => { await stopServer(); fs.rmSync(DDIR, { recursive: true, force: true }); });

test('drill-down (open bucket) hands the screen a trimmed-blank waybill for a whitespace-only waybill_number', async () => {
  const d = await drill(tok, 'open');
  assert.strictEqual(d.status, 200, JSON.stringify(d));
  const ws = d.orders.find(o => o.order_number === 'SK-WS');
  assert.ok(ws, 'whitespace-waybill order is in the In progress popup population');
  assert.strictEqual(ws.status, 'pending');
  assert.strictEqual(ws.waybill, '', `waybill must read blank so the popup offers Add AWB, got ${JSON.stringify(ws.waybill)}`);
  const open = d.orders.find(o => o.order_number === 'SK-OPEN');
  assert.strictEqual(open.waybill, '');
  const has = d.orders.find(o => o.order_number === 'SK-HAS');
  assert.strictEqual(has.waybill, 'SPXSG00011122233A', 'a real waybill is untouched');
});

test('list and detail agree: whitespace-only waybill reads blank there too', async () => {
  const rows = await (await G(tok, '/api/portal/orders')).json();
  assert.strictEqual(rows.find(o => o.order_number === 'SK-WS').waybill, '');
  const det = await J(await G(tok, '/api/portal/order/SK-WS'));
  assert.strictEqual(det.waybill, '', JSON.stringify(det));
  assert.strictEqual(det.carrier, 'Local Courier');
});

test('attach from the popup population works and the drill-down then shows the waybill (never overwrite after)', async () => {
  const r = await postWb(tok, 'SK-WS', 'SPXSG06870759966A');
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  const d = await drill(tok, 'open');
  assert.strictEqual(d.orders.find(o => o.order_number === 'SK-WS').waybill, 'SPXSG06870759966A');
  const again = await postWb(tok, 'SK-WS', 'SPXSG55544433322C');
  assert.strictEqual(again.status, 409, 'never overwrite');
});

test('isolation/read-only gates unchanged in the popup path', async () => {
  assert.strictEqual((await drill(tokB, 'open')).orders.some(o => o.order_number === 'SK-OPEN'), false, 'wrong client sees nothing of StellarKBeauty');
  assert.strictEqual((await postWb(tokB, 'SK-OPEN', 'SPXSG77766655544F')).status, 404);
  assert.strictEqual((await postWb(tokView, 'SK-OPEN', 'SPXSG77766655544F')).status, 403, 'view-only refused');
  const h = await postWb(tokHidden, 'SK-OPEN', 'SPXSG77766655544F');
  assert.strictEqual(h.status, 403); assert.strictEqual(h.hiddenSection, 'orders');
  assert.strictEqual((await postWb(tok, 'SK-DONE', 'SPXSG12121212121G')).status, 409, 'done refused');
  assert.strictEqual((await postWb(tok, 'SK-CX', 'SPXSG12121212121G')).status, 409, 'cancelled refused');
});

test('screen wiring: popup card, tap and button all reach the inline AWB form without the New-Order wizard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.js'), 'utf8');
  // One trimmed-blank rule on screen, matching the server's.
  assert.match(src, /const wbBlank = /, 'a shared trimmed-blank waybill helper exists');
  assert.match(src, /wbBlank\(o\.waybill\)/, 'drill-down card gates Add AWB on the trimmed-blank rule');
  // The expand helper lives in Orders scope (near toggleDrillOrder), not only
  // inside setupNewOrder(), and both click handlers call it directly — no
  // silent `window.portalAttachWaybill && ...` no-op in the popup.
  assert.match(src, /async function openAwbForm\(/, 'expand-to-AWB helper defined in Orders scope');
  const ddHandler = src.slice(src.indexOf("$('ddModal').addEventListener('click'"));
  assert.match(ddHandler, /openAwbForm\(aw\.dataset\.o\)/, 'popup Add AWB button expands the form in the popup');
  assert.match(src, /if \(e\.target\.closest\('\.detail'\)\) return;/, 'reading expanded detail does not collapse it (unchanged)');
  // Card tap expands full detail IN the popup (#96 design kept).
  assert.match(src, /if \(card\) toggleDrillOrder\(card\.dataset\.ddOrder\);/, 'popup card tap expands its full detail in the popup');
});
