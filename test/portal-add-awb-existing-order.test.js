// Portal Add AWB on an EXISTING order (not portal-created) — POST
// /api/portal/orders/:orderNumber/waybill as used by the new inline
// "Add AWB / Upload AWB" form in order detail.
// Proved through the REAL server on a throwaway DATA_DIR with db.json seeded
// directly (Shopify-source batch, like StellarKBeauty's order):
//   number-only (SPX ending in a letter), file-only (label text fills the
//   waybill), both-agree, both-mismatch (nothing written), already-has-waybill
//   (never overwritten, label-only too), duplicate tracking, done/cancelled
//   refused, wrong-client 404, view-only 403, Orders-section-off 403, and
//   status untouched (pending stays pending — packing moves it, not AWB).
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const PORT = 6000 + Math.floor(Math.random() * 800) + 41;
const B = `http://localhost:${PORT}`;
const MASTER = process.env.MASTER_KEY || '201432547E';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return { ...JSON.parse(t), status: r.status }; } catch { return { status: r.status, _raw: t }; } };
let kid, DDIR, tok, tokB, tokView, tokHidden;

function startServer() { kid = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR }, stdio: 'ignore', detached: true }); }
async function waitUp() { for (let i = 0; i < 80; i++) { try { if ((await fetch(B + '/api/version')).ok) return; } catch {} await sleep(400); } throw new Error('server did not boot'); }
async function stopServer() { try { process.kill(-kid.pid, 'SIGTERM'); } catch {} await sleep(1200); }
function findDb(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const f = findDb(p); if (f) return f; } else if (e.name === 'db.json') return p; } return null; }

const D = '2026-10-18T04:00:00.000Z'; // 18 Oct 2026, SGT afternoon
function seed(dbPath) {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const mk = (order_number, extra = {}) => ({ order_number, platform: 'Shopify', channel: 'Shopify', date: D, total_qty: 2,
    lines: [{ sku: 'VM8_HM_TE350', description: 'VM8 HM TE350', qty: 2 }], ...extra });
  db.batches = [
    { id: 'b-stellar', idealscan_code: 'IS-AWB-1', client_name: 'StellarKBeauty', filename: 'shopify.xlsx', uploaded_at: D, uploaded_by: 'shopify-sync', source: 'shopify',
      orders: [
        mk('189418501860'),
        mk('SK-FILE'), mk('SK-BOTH'), mk('SK-MISMATCH'), mk('SK-DUP'),
        mk('SK-HAS', { waybill_number: 'SPXSG00011122233A' }),
        mk('SK-DONE'), mk('SK-CX'),
      ],
      orderStates: {
        '189418501860': { status: 'pending', scanned: {} },
        'SK-FILE': { status: 'pending', scanned: {} }, 'SK-BOTH': { status: 'pending', scanned: {} },
        'SK-MISMATCH': { status: 'pending', scanned: {} }, 'SK-DUP': { status: 'pending', scanned: {} },
        'SK-HAS': { status: 'pending', scanned: {} },
        'SK-DONE': { status: 'done', endTime: D, scanned: { VM8_HM_TE350: 2 } },
        'SK-CX': { status: 'unprocessed', unprocessed_at: D, unprocessed_reason: 'cancelled', scanned: {} },
      } },
    { id: 'b-other', idealscan_code: 'IS-AWB-2', client_name: 'OTHERCO', filename: 'b.xlsx', uploaded_at: D, uploaded_by: 'demo',
      orders: [mk('OTH-1', { waybill_number: 'SPXSG99988877766B' })],
      orderStates: { 'OTH-1': { status: 'pending', scanned: {} } } },
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
  if (!l.token) throw new Error(`login failed ${client}: ${JSON.stringify(l)} / ${JSON.stringify(u)}`);
  return l.token;
}
const G = (t, p) => fetch(B + p, { headers: { 'x-auth-token': t } });
const postWb = (t, on, fd) => fetch(B + `/api/portal/orders/${encodeURIComponent(on)}/waybill`, { method: 'POST', headers: { 'x-auth-token': t }, body: fd }).then(J);
const form = (tracking, fileBuf, name = 'label.pdf') => { const fd = new FormData(); if (tracking) fd.append('tracking', tracking); if (fileBuf) fd.append('file', new Blob([fileBuf], { type: 'application/pdf' }), name); return fd; };
async function labelPdf(tracking) {
  const doc = await PDFDocument.create(); const page = doc.addPage([288, 432]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Shopee Express AWB', { x: 20, y: 380, size: 14, font });
  page.drawText(tracking, { x: 20, y: 340, size: 16, font });
  page.drawText('Order 189418501860', { x: 20, y: 300, size: 10, font });
  return Buffer.from(await doc.save());
}
const detailRaw = async (t, on) => { const r = await G(t, '/api/portal/order/' + encodeURIComponent(on)); return { http: r.status, body: await r.json().catch(() => ({})) }; };
const detail = async (t, on) => (await detailRaw(t, on)).body;

test.before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pawb-'));
  startServer(); await waitUp(); await sleep(2500); await stopServer();
  const dbp = findDb(DDIR); if (!dbp) throw new Error('no db.json after first boot');
  seed(dbp);
  startServer(); await waitUp();
  tok = await portalToken('StellarKBeauty', 'gena');
  tokB = await portalToken('OTHERCO', 'otherops');
  tokView = await portalToken('StellarKBeauty', 'gena-view', { access: 'view' });
  tokHidden = await portalToken('StellarKBeauty', 'gena-nolist', { visibility: { orders: false } });
});
test.after(async () => { await stopServer(); fs.rmSync(DDIR, { recursive: true, force: true }); });

test('existing Shopify order shows in list with no waybill, pending', async () => {
  const listRes = await G(tok, '/api/portal/orders');
  const rows = await listRes.json();
  const o = rows.find(x => x.order_number === '189418501860');
  assert.ok(o, 'seeded Shopify order visible'); assert.strictEqual(o.waybill, ''); assert.strictEqual(o.status, 'pending');
});

test('number-only: SPX number ending in a letter fills waybill; status stays pending', async () => {
  const r = await postWb(tok, '189418501860', form('SPXSG06870759966A'));
  assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.strictEqual(r.tracking, 'SPXSG06870759966A'); assert.strictEqual(r.waybill, 'SPXSG06870759966A');
  const d = await detail(tok, '189418501860');
  assert.strictEqual(d.waybill, 'SPXSG06870759966A'); assert.strictEqual(d.has_label, false); assert.strictEqual(d.status, 'pending', 'AWB alone must not move status — packing does');
});

test('already-has-waybill: a different number AND a label-only attach are both refused, nothing overwritten', async () => {
  for (const on of ['189418501860', 'SK-HAS']) {
    let r = await postWb(tok, on, form('SPXSG55544433322C'));
    assert.strictEqual(r.status, 409, on); assert.match(r.error, /already has tracking number/);
    r = await postWb(tok, on, form(null, await labelPdf('SPXSG55544433322C')));
    assert.strictEqual(r.status, 409, on + ' label-only');
  }
  assert.strictEqual((await detail(tok, 'SK-HAS')).waybill, 'SPXSG00011122233A');
  assert.strictEqual((await detail(tok, 'SK-HAS')).has_label, false, 'refused label was not attached');
});

test('file-only: tracking read off the label fills the blank waybill and attaches the label', async () => {
  const r = await postWb(tok, 'SK-FILE', form(null, await labelPdf('SPXSG12345678901B')));
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(r.label_tracking, 'SPXSG12345678901B'); assert.strictEqual(r.tracking, 'SPXSG12345678901B'); assert.ok(r.label);
  const d = await detail(tok, 'SK-FILE');
  assert.strictEqual(d.waybill, 'SPXSG12345678901B'); assert.strictEqual(d.has_label, true);
  const lab = await G(tok, '/api/portal/order/SK-FILE/label');
  assert.strictEqual(lab.status, 200); assert.strictEqual(Buffer.from(await lab.arrayBuffer()).slice(0, 5).toString(), '%PDF-');
});

test('both given and agreeing succeeds', async () => {
  const r = await postWb(tok, 'SK-BOTH', form('SPXSG22233344455C', await labelPdf('SPXSG22233344455C')));
  assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.strictEqual(r.tracking, 'SPXSG22233344455C');
  assert.strictEqual((await detail(tok, 'SK-BOTH')).has_label, true);
});

test('both given but mismatching: 409, nothing attached, waybill stays blank', async () => {
  const r = await postWb(tok, 'SK-MISMATCH', form('SPXSG11100011100D', await labelPdf('SPXSG99900099900E')));
  assert.strictEqual(r.status, 409, JSON.stringify(r)); assert.match(r.error, /does not match/);
  const d = await detail(tok, 'SK-MISMATCH');
  assert.strictEqual(d.waybill, ''); assert.strictEqual(d.has_label, false);
});

test('duplicate tracking held by another (client\'s) order is refused without naming it', async () => {
  const r = await postWb(tok, 'SK-DUP', form('SPXSG99988877766B'));
  assert.strictEqual(r.status, 409); assert.match(r.error, /already used by another order/); assert.ok(!/OTH-1/.test(r.error));
  assert.strictEqual((await detail(tok, 'SK-DUP')).waybill, '');
});

test('wrong client cannot attach to (or see a way into) another client\'s order', async () => {
  const r = await postWb(tokB, 'SK-DUP', form('SPXSG77766655544F'));
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await detailRaw(tokB, 'SK-DUP')).http, 404);
});

test('done and cancelled orders refuse a waybill from the portal', async () => {
  assert.strictEqual((await postWb(tok, 'SK-DONE', form('SPXSG12121212121G'))).status, 409);
  assert.strictEqual((await postWb(tok, 'SK-CX', form('SPXSG12121212121G'))).status, 409);
});

test('view-only refused; Orders-section-off refused; bad tracking refused', async () => {
  assert.strictEqual((await postWb(tokView, 'SK-DUP', form('SPXSG77766655544F'))).status, 403);
  const h = await postWb(tokHidden, 'SK-DUP', form('SPXSG77766655544F'));
  assert.strictEqual(h.status, 403); assert.strictEqual(h.hiddenSection, 'orders');
  assert.strictEqual((await postWb(tok, 'SK-DUP', form('!!bad!!'))).status, 400);
  assert.strictEqual((await postWb(tok, 'SK-DUP', new FormData())).status, 400);
});

test('screen wiring: detail form, list + drill-down Add AWB buttons, no-waybill wording', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.js'), 'utf8');
  assert.match(src, /Add AWB \/ Upload AWB/, 'clear action wording');
  assert.match(src, /class="add-awb"/, 'inline form in order detail');
  assert.match(src, /addAwbTrk/, 'AWB number input');
  assert.match(src, /addAwbFile/, 'AWB label file input');
  assert.match(src, /AWB attached/, 'success confirmation');
  assert.match(src, /No waybill yet/, 'no-waybill state shown');
});
