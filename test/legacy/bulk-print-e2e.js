// BULK WAYBILL PRINT — one PDF for a selection: the carrier label where one is
// attached, the batch waybill PDF where one was uploaded, else a SYSTEM label.
// Seeds a scratch server with every shape and drives the real route.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const { PDFDocument } = require('/home/user/server.js/node_modules/pdf-lib');
const pdfjs = require('/home/user/server.js/node_modules/pdfjs-dist/legacy/build/pdf.js');

const S      = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT   = 4771, B = `http://localhost:${PORT}`;
const DDIR   = path.join(S, 'bulk-print-data');
const DBP    = path.join(DDIR, 'tenants', 'default', 'db.json');
const MASTER = process.env.MASTER_KEY || '201432547E';
const SERVER = process.env.SERVER_JS || '/home/user/server.js/server.js';

const A = 'GI-200001', WB_A = 'TXSGD03800975';        // carrier label attached (1 parcel)
const A2 = 'GI-200002', WB_A2a = 'LZSGD1015417357', WB_A2b = 'LZSGD1015417039'; // two parcels
const Bn = 'GI-200003', WB_B = 'JT0000123456';        // batch waybill PDF on disk
const C = 'GI-200004', WB_C = 'SPXSG0412345678';      // nothing attached, has a waybill number → system label
const D = 'GI-200005';                                // nothing attached, NO waybill → system label barcoding the order number
const E = 'GI-200006', WB_E = 'TXSGD09999999';        // carrier label record whose FILE is corrupt → system label with the note
const R = '172397910455623';                          // a reference copy (OneCart) — fenced
const Z = '陈小明';                                   // a customer name outside WinAnsi

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up: ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids = []; await sleep(1500); }
async function boot() { spawnLogged([SERVER], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'bulk-print-server.log')); await waitUp(B + '/api/version'); await sleep(2500); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
async function login(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); if (!d.token) throw new Error('login ' + id); return d.token; }
const H = tok => ({ 'Content-Type': 'application/json', 'x-auth-token': tok });
const readDb = async () => { await sleep(1500); return JSON.parse(fs.readFileSync(DBP, 'utf8')); };
async function pdfOf(browser, pages) {
  const page = await browser.newPage();
  await page.setContent(pages.map((h, i) => `<div style="page-break-after:${i < pages.length - 1 ? 'always' : 'auto'};font:16px sans-serif">${h}</div>`).join(''));
  const pdf = await page.pdf({ width: '100mm', height: '150mm' }); await page.close(); return pdf;
}
async function pdfTexts(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i); const tc = await p.getTextContent();
    out.push({ text: tc.items.map(x => x.str).join(' '), size: p.getViewport({ scale: 1 }) });
  }
  await doc.destroy(); return out;
}
async function printCall(tok, body) {
  const r = await fetch(B + '/api/orders/print-labels', { method: 'POST', headers: H(tok), body: JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/pdf')) return { status: r.status, pdf: Buffer.from(await r.arrayBuffer()), summary: JSON.parse(decodeURIComponent(r.headers.get('x-print-summary') || '%7B%7D')), disp: r.headers.get('content-disposition') };
  return { status: r.status, body: await J(r) };
}

function seed(db) {
  const now = new Date().toISOString();
  const L = (sku, qty, description) => ({ sku, description, qty, uom: 'EACH', location: '', batch_number: '', serial_number: '', expiry_date: '', remarks_betime: '' });
  const O = (n, wb, extra = {}) => ({ order_number: n, customer_name: 'Tan Ah Kow', tel: '91234567', delivery_address: 'Blk 123 Bedok North Street 1 #05-67 Singapore 460123', carrier: 'TraxLogics', waybill_number: wb, issue_no: n, pick_ticket: '', po_number: '', platform: 'Lazada', shop_name: 'Betime Lazada', date: null, lines: [L('8006', 2, 'Betime Foldable Bed Rail'), L('5603', 1, 'Betime Pillow')], total_qty: 3, ...extra });
  db.batches = [
    { id: 'batch-work', filename: 'gi-analysis.xlsx', idealscan_code: 'IS-TEST-01', uploaded_at: now, uploaded_by: 'demo', client_name: 'BETIME', order_count: 6, row_count: 12, inventory_tracked: false,
      orders: [O(A, WB_A), O(A2, WB_A2a), O(Bn, WB_B), O(C, WB_C, { customer_name: Z, delivery_address: '' }), O(D, '', { carrier: '', platform: '', shop_name: '', lines: Array.from({ length: 30 }, (_, i) => L('SKU-' + (i + 1), 1, 'Item number ' + (i + 1))), total_qty: 30 }), O(E, WB_E)],
      orderStates: {} },
    { id: 'batch-ref', filename: 'onecart-Betime_Online', idealscan_code: 'IS-TEST-02', uploaded_at: now, uploaded_by: 'onecart-sync', onecart_store_id: 'store-1', reference_only: true, client_name: 'Betime Online', order_count: 1, row_count: 1, inventory_tracked: false,
      orders: [O(R, 'TXSGD00000001', { onecart_id: '9003', onecart_store_id: 'store-1' })], orderStates: {} },
  ];
  db.labelImports = [{ id: 'imp-1', filename: 'labels.pdf', uploadedAt: now, uploadedBy: 'demo', pageCount: 4, pages: [
    { pageIndex: 0, pageFile: 'page_1.pdf', rawText: WB_A, extracted: { trackingNumber: WB_A }, matchStatus: 'matched', matchedOrderNumber: A, matchMethod: 'tracking_number', matchConfidence: 'exact' },
    { pageIndex: 1, pageFile: 'page_2.pdf', rawText: WB_A2a, extracted: { trackingNumber: WB_A2a }, matchStatus: 'matched', matchedOrderNumber: A2, matchMethod: 'tracking_number', matchConfidence: 'exact' },
    { pageIndex: 2, pageFile: 'page_3.pdf', rawText: WB_A2b, extracted: { trackingNumber: WB_A2b }, matchStatus: 'matched', matchedOrderNumber: A2, matchMethod: 'order_number', matchConfidence: 'exact', parcel: true },
    { pageIndex: 3, pageFile: 'page_4.pdf', rawText: WB_E, extracted: { trackingNumber: WB_E }, matchStatus: 'matched', matchedOrderNumber: E, matchMethod: 'tracking_number', matchConfidence: 'exact' },
  ] }];
  db.orderLabels = {
    [A]:  { importId: 'imp-1', pageIndex: 0, pageFile: 'page_1.pdf', attachedAt: now, attachedBy: 'demo', tracking: WB_A },
    [A2]: { importId: 'imp-1', pageIndex: 1, pageFile: 'page_2.pdf', attachedAt: now, attachedBy: 'demo', tracking: WB_A2a, parcels: [{ importId: 'imp-1', pageIndex: 2, pageFile: 'page_3.pdf', attachedAt: now, attachedBy: 'demo', tracking: WB_A2b }] },
    [E]:  { importId: 'imp-1', pageIndex: 3, pageFile: 'page_4.pdf', attachedAt: now, attachedBy: 'demo', tracking: WB_E },
  };
  return db;
}

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.mkdirSync(DDIR, { recursive: true });
  await boot(); await stopAll();
  fs.writeFileSync(DBP, JSON.stringify(seed(JSON.parse(fs.readFileSync(DBP, 'utf8')))));
  try { fs.unlinkSync(path.join(DDIR, 'tenants', 'default', 'scan-journal.ndjson')); } catch {}
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const impDir = path.join(DDIR, 'label_imports', 'imp-1'); fs.mkdirSync(impDir, { recursive: true });
  fs.writeFileSync(path.join(impDir, 'page_1.pdf'), await pdfOf(browser, [`<h1>CARRIER LABEL ${WB_A}</h1><p>${A}</p>`]));
  fs.writeFileSync(path.join(impDir, 'page_2.pdf'), await pdfOf(browser, [`<h1>CARRIER LABEL ${WB_A2a}</h1><p>${A2} box 1</p>`]));
  fs.writeFileSync(path.join(impDir, 'page_3.pdf'), await pdfOf(browser, [`<h1>CARRIER LABEL ${WB_A2b}</h1><p>${A2} box 2</p>`]));
  fs.writeFileSync(path.join(impDir, 'page_4.pdf'), Buffer.from('%PDF-1.4 this is not a real pdf at all'));
  const wbDir = path.join(DDIR, 'waybills', 'batch-work'); fs.mkdirSync(wbDir, { recursive: true });
  fs.writeFileSync(path.join(wbDir, `${Bn}.pdf`), await pdfOf(browser, [`<h1>BATCH WAYBILL ${WB_B}</h1><p>${Bn}</p>`]));
  await browser.close();
  await boot();
  const tok = await login('demo', 'demo');
  await fetch(B + '/api/master/users', { method: 'POST', headers: { ...H(tok), 'x-master-key': MASTER }, body: JSON.stringify({ id: 'whguy', name: 'Floor', password: 'whpass1', role: 'warehouse' }) });
  const wtok = await login('whguy', 'whpass1');

  // ── The plan (dry) ───────────────────────────────────────────────────────
  const sel = [A, A2, Bn, C, D, E, 'GI-NOPE'];
  const dry = await printCall(tok, { orders: sel, dry: true });
  ok(dry.status === 200 && dry.body.ok, `dry run answers 200 (${dry.status})`);
  const src = Object.fromEntries((dry.body.plan || []).map(p => [p.order, p]));
  ok(src[A]?.source === 'carrier' && src[A].pages === 1, `${A}: carrier label, 1 page (${JSON.stringify(src[A])})`);
  ok(src[A2]?.source === 'carrier' && src[A2].pages === 2 && src[A2].parcels === 2, `${A2}: carrier label, BOTH parcels (${JSON.stringify(src[A2])})`);
  ok(src[Bn]?.source === 'waybill-pdf', `${Bn}: the batch waybill PDF (${src[Bn]?.source})`);
  ok(src[C]?.source === 'system' && src[C].waybill === WB_C, `${C}: system label, barcoding its waybill (${JSON.stringify(src[C])})`);
  ok(src[D]?.source === 'system' && src[D].waybill === '', `${D}: system label with NO waybill number (${JSON.stringify(src[D])})`);
  ok(src[E]?.source === 'carrier', `${E}: the PLAN reads the record and says carrier (the file is only read when printing) (${src[E]?.source})`);
  ok(src['GI-NOPE']?.source === 'missing' && /live order list/.test(src['GI-NOPE'].why), `an unknown number is 'missing' with a reason (${JSON.stringify(src['GI-NOPE'])})`);
  const s = dry.body.summary || {};
  ok(s.orders === 7 && s.carrier === 3 && s.waybillPdf === 1 && s.system === 2 && s.missing === 1 && s.pages === 7, `summary counts: ${JSON.stringify(s)}`);
  ok(dry.body.plan.map(p => p.order).join(',') === sel.join(','), 'the plan is in SELECTION order');
  let db = await readDb();
  ok(!(db.auditLog || []).some(e => e.type === 'labels_bulk_printed'), 'a dry run writes nothing to the trail');

  // ── The real run ─────────────────────────────────────────────────────────
  const run = await printCall(tok, { orders: sel });
  ok(run.status === 200 && run.pdf && run.pdf.slice(0, 4).toString() === '%PDF', `the real run answers a PDF (${run.status})`);
  ok(/inline/.test(run.disp || '') && /waybill_labels_7_orders/.test(run.disp || ''), `served inline, named for the run (${run.disp})`);
  ok(run.summary.carrier === 2 && run.summary.system === 3 && run.summary.waybillPdf === 1 && run.summary.pages === 7, `the REAL summary moves the corrupt carrier file to a system label: ${JSON.stringify(run.summary)}`);
  const pages = await pdfTexts(run.pdf);
  ok(pages.length === 7, `7 pages in the document (${pages.length})`);
  ok(pages[0].text.includes(WB_A) && /CARRIER LABEL/.test(pages[0].text), `page 1 is ${A}'s carrier label (${pages[0].text.slice(0, 60)})`);
  ok(pages[1].text.includes(WB_A2a) && pages[2].text.includes(WB_A2b), `pages 2-3 are ${A2}'s two parcels, in order`);
  ok(/BATCH WAYBILL/.test(pages[3].text) && pages[3].text.includes(WB_B), `page 4 is ${Bn}'s batch waybill PDF`);
  const pC = pages[4].text, pD = pages[5].text, pE = pages[6].text;
  ok(/SYSTEM LABEL/.test(pC) && /no carrier label attached/.test(pC), `page 5 says SYSTEM LABEL in words (${pC.slice(0, 80)})`);
  ok(pC.includes(WB_C) && /WAYBILL/.test(pC) && pC.includes(C) && /TRAXLOGICS/.test(pC), `${C}'s system label carries the waybill, the order number and the carrier header`);
  ok(/\?/.test(pC) && !/陈/.test(pC), `a name outside the PDF font's range prints as ? rather than crashing the run`);
  ok(/BETIME/.test(pC) && /Lazada \/ Betime Lazada/.test(pC) && /PIECES\s*3/.test(pC), 'client, channel and piece count on the system label');
  ok(/8006/.test(pC) && /Foldable Bed Rail/.test(pC) && /5603/.test(pC), 'the items are listed');
  ok(pD.includes(D) && /ORDER NO - no waybill number/.test(pD) && /IDEALONE/.test(pD), `${D}'s label barcodes the ORDER number and says there is no waybill; IDEALONE header when no carrier`);
  ok(/\+ \d+ more line/.test(pD) && /SKU-1 /.test(pD), `a 30-line order lists what fits and counts the rest (${(pD.match(/\+ \d+ more line\(s\)/) || [])[0]})`);
  ok(/SYSTEM LABEL - the attached carrier label could not be read/.test(pE) && pE.includes(WB_E), `${E}'s corrupt attachment falls back to a system label THAT SAYS WHY`);
  ok(Math.round(pages[4].size.width) === 283 && Math.round(pages[4].size.height) === 425, `system label page is 100x150mm by default (${Math.round(pages[4].size.width)}x${Math.round(pages[4].size.height)}pt)`);
  db = await readDb();
  const au = (db.auditLog || []).filter(e => e.type === 'labels_bulk_printed');
  ok(au.length === 1 && au[0].by === 'demo' && au[0].orders === 7 && au[0].system === 3 && au[0].carrier === 2 && (au[0].systemFor || []).includes(D), `one audit row with who and the counts (${JSON.stringify(au[0])})`);
  ok(!JSON.stringify(au).includes('Bedok'), 'no address on the trail');

  // ── Size preference ──────────────────────────────────────────────────────
  const big = await printCall(tok, { orders: [C], size: '100x160' });
  const bigPages = await pdfTexts(big.pdf);
  ok(Math.round(bigPages[0].size.height) === 454, `size 100x160 honoured on a system label (${Math.round(bigPages[0].size.height)}pt tall)`);
  const bad = await printCall(tok, { orders: [C], size: 'A3', dry: true });
  ok(bad.status === 200 && bad.body.size === '100x150', `an unknown size falls back to 100x150 (${bad.body.size})`);

  // ── Refusals ─────────────────────────────────────────────────────────────
  const fenced = await printCall(tok, { orders: [A, R] });
  ok(fenced.status === 409 && fenced.body.referenceOnly && fenced.body.orders.join() === R, `a reference copy in the selection is fenced, naming only the copy (${fenced.status} ${JSON.stringify(fenced.body.orders)})`);
  const none = await printCall(tok, { orders: [] });
  ok(none.status === 400, `an empty selection is 400 (${none.status})`);
  const many = await printCall(tok, { orders: Array.from({ length: 301 }, (_, i) => 'X' + i), dry: true });
  ok(many.status === 400 && /300/.test(many.body.error || ''), `301 orders refused naming the cap (${many.status})`);
  const gone = await printCall(tok, { orders: ['GI-NOPE', 'GI-NOPE2'] });
  ok(gone.status === 404 && gone.body.summary?.missing === 2, `all-missing is 404 with the plan (${gone.status})`);
  const noTok = await fetch(B + '/api/orders/print-labels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orders: [A] }) });
  ok(noTok.status === 401, `no token is 401 (${noTok.status})`);
  const wh = await printCall(wtok, { orders: [A, C] });
  ok(wh.status === 200 && wh.summary.pages === 2, `WAREHOUSE prints too — the floor prints labels (${wh.status})`);
  const dup = await printCall(tok, { orders: [A, A, ' ' + A + ' '], dry: true });
  ok(dup.body.summary?.orders === 1, `a number selected twice prints once (${dup.body.summary?.orders})`);

  await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
