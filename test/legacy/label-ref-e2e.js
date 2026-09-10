// THE REPORTED SHAPE: a TraxLogics label prints the MARKETPLACE order number
// (Betime Online's reference copy) and the BETIME picking-list upload files
// the same shipment under its GI number with the same waybill. The label must
// land on the GI order — the one that gets scanned — never on the reference.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const { chromium } = require('/home/user/server.js/node_modules/playwright');

const S      = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT   = 4767, MPORT = 4768;
const B      = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
const DDIR   = path.join(S, 'lbl-ref-data');
const DBP    = path.join(DDIR, 'tenants', 'default', 'db.json');
const PDFDIR = path.join(S, 'oc-pdfs');
const MASTER = process.env.MASTER_KEY || '201432547E';
const KEY    = 'oc_test_key_123';
const PREFIX = process.env.PREFIX_MODE === '1';   // running against the pre-fix build: only the reproduction matters

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kids = [];
function spawnLogged(args, env, log) {
  const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true });
  kids.push(c); return c;
}
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up: ' + url); }
async function stopKid(c) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} }
async function stopAll() { for (const c of kids) await stopKid(c); kids = []; await sleep(1500); }
let serverKid = null;
async function bootServer() {
  serverKid = spawnLogged([process.env.SERVER_JS || '/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'lbl-ref-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
}
const MH = tok => ({ 'Content-Type': 'application/json', 'x-master-key': MASTER, 'x-auth-token': tok });
const J  = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
async function login(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); if (!d.token) throw new Error('login ' + id); return d.token; }
async function orders(tok) { const d = await J(await fetch(B + '/api/orders?range=all', { headers: { 'x-auth-token': tok } })); return Array.isArray(d) ? d : (d.orders || []); }
const byNo = (list, n) => list.find(o => o.order_number === n);
const mockCalls = async () => J(await fetch(M + '/__ctl/calls'));
const readDb = async () => { await sleep(1500); return JSON.parse(fs.readFileSync(DBP, 'utf8')); };
function xlsxOf(rows) { const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); }
async function upload(tok, buf, name, extra = {}) {
  const fd = new FormData(); fd.append('orderFile', new Blob([buf]), name); fd.append('client_name', 'BETIME'); fd.append('arrange_delivery', 'no');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = await fetch(B + '/api/upload', { method: 'POST', headers: { 'x-auth-token': tok }, body: fd });
  return { status: r.status, body: await J(r) };
}
async function importLabel(tok, pdf, name) {
  const fd = new FormData(); fd.append('labelPdf', new Blob([pdf], { type: 'application/pdf' }), name);
  const r = await fetch(B + '/api/label-imports', { method: 'POST', headers: { 'x-auth-token': tok }, body: fd });
  return { status: r.status, body: await J(r) };
}
const getImport = async (tok, id) => J(await fetch(B + `/api/label-imports/${id}`, { headers: { 'x-auth-token': tok } }));
async function scan(tok, orderNumber, sku) { return J(await fetch(B + '/api/scan/increment', { method: 'POST', headers: MH(tok), body: JSON.stringify({ orderNumber, sku, eventId: 'ev-' + Math.random().toString(36).slice(2) }) })); }
async function complete(tok, orderNumber) { const r = await fetch(B + '/api/scan/complete', { method: 'POST', headers: MH(tok), body: JSON.stringify({ orderNumber, startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) }); return { status: r.status, body: await J(r) }; }
async function pdfOf(pages) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  await page.setContent(pages.map((h, i) => `<div style="page-break-after:${i < pages.length - 1 ? 'always' : 'auto'};font:16px sans-serif">${h}</div>`).join(''));
  const pdf = await page.pdf({ format: 'A4' }); await browser.close(); return pdf;
}
// A TraxLogics-shaped label: tracking large, "ORDER NO." with the marketplace id
const labelHtml = (tracking, mpNo, who) => `<h1>${tracking}</h1><p>TRACX Logistics — Standard</p><p>ORDER NO. ${mpNo}</p><p>RECIPIENT ${who}</p><p>FROM Nuxe</p><p>${tracking}</p>`;

// mock 9003 = Lazada 172397910455623 (no tracking at seed); mock 9001 = TikTok 585836014589150279
const MP3 = '172397910455623', MP1 = '585836014589150279';
const GI3 = 'GI-141936', T3 = 'TXSGD03800975';
const GI1 = 'GI-141999', T1 = 'TXSGD03800976';

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  spawnLogged([path.join(S, 'onecart-mock.js')], { PORT: String(MPORT), OC_KEY: KEY, OC_PDF_DIR: PDFDIR }, path.join(S, 'lbl-ref-mock.log'));
  await waitUp(M + '/__ctl/calls');
  await bootServer();
  const admin = await login('demo', 'demo');

  console.log('\n=== the channel holds the marketplace copy, with its waybill ===');
  const st = await J(await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(admin),
    body: JSON.stringify({ clientName: 'Betime Online', apiKey: KEY, endpoint: M + '/api/v2', autoPullMinutes: 0, completeAction: 'ship', labelSync: 'off', enabled: true }) }));
  const SID = st.id;
  await fetch(M + `/__ctl/track/9003?no=${T3}`);
  const p1 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p1.ok && p1.imported === 3, `3 reference records imported (${p1.imported})`);
  let list = await orders(admin);
  ok(byNo(list, MP3)?.reference_only === true && byNo(list, MP3).waybill_number === T3, `the Lazada reference copy ${MP3} carries waybill ${T3}`);

  console.log('\n=== BETIME uploads the picking list: GI number + the same waybill ===');
  const u = await upload(admin, xlsxOf([{ 'GI No': GI3, 'Tracking No': T3, 'SKU Code': '8006', 'Quantity': 3 }]), 'gi-analysis.xlsx');
  ok(u.status === 200, `uploaded (${u.status} ${u.body.error || ''})`);
  list = await orders(admin);
  const w3 = byNo(list, GI3);
  ok(w3 && !w3.reference_only && w3.waybill_number === T3, `work order ${GI3} holds waybill ${T3} (${w3 && w3.waybill_number})`);
  ok(w3 && w3.reference_twin === 'Betime Online', `the work order carries the "also in Betime Online" twin pill, linked by WAYBILL (${w3 && JSON.stringify(w3.reference_twin)})`);

  console.log('\n=== the TraxLogics label prints the MARKETPLACE number ===');
  const pdf = await pdfOf([labelHtml(T3, MP3, 'Phang Chew Yen'), labelHtml('TXSGD03800999', MP1, 'Somebody Else')]);
  const li = await importLabel(admin, pdf, 'traxlogics.pdf');
  ok(li.status === 200, `label import accepted (${li.status})`);
  await sleep(1500);
  let imp = await getImport(admin, li.body.importId);
  const pg1 = imp.pages[0], pg2 = imp.pages[1];
  ok(pg1.extracted?.trackingNumber === T3 && pg1.extracted?.orderNumber === MP3, `page 1 read tracking ${pg1.extracted?.trackingNumber} and order no ${pg1.extracted?.orderNumber}`);
  ok(pg1.matchStatus === 'matched' && pg1.matchedOrderNumber === GI3, `page 1 is attached to the WORK order ${GI3}, not the reference copy (${pg1.matchStatus} → ${pg1.matchedOrderNumber})`);
  ok(/reference_copy$|^tracking_number$/.test(pg1.matchMethod || ''), `the method says how: ${pg1.matchMethod}`);
  ok(!pg1.identity || !pg1.identity.fields?.trackingNumber || pg1.identity.fields.trackingNumber.verdict === 'agrees', `no "matches no identifier on this order" note — the tracking agrees with the work order's waybill (${JSON.stringify(pg1.identity?.fields?.trackingNumber || null)})`);
  let db = await readDb();
  ok(!!db.orderLabels[GI3] && !db.orderLabels[MP3], `db.orderLabels holds it under ${GI3} and nothing under ${MP3}`);
  list = await orders(admin);
  ok(byNo(list, GI3).has_order_label === true, 'the Orders row shows the label chip on the GI order');
  const pdfRes = await fetch(B + `/api/order-label/${GI3}/pdf`, { headers: { 'x-auth-token': admin } });
  ok(pdfRes.status === 200 && (pdfRes.headers.get('content-type') || '').includes('pdf'), `the label comes out for ${GI3} at scanning (${pdfRes.status})`);
  const refPdf = await fetch(B + `/api/order-label/${MP3}/pdf`, { headers: { 'x-auth-token': admin } });
  ok(refPdf.status === 404, `and nothing is served for the reference copy (${refPdf.status})`);

  console.log('\n=== a label whose order exists ONLY as a reference copy ===');
  ok(pg2.matchStatus === 'unmatched' && !pg2.matchedOrderNumber, `page 2 (marketplace ${MP1}, no picking list yet) is NOT attached to the reference (${pg2.matchStatus})`);
  ok(pg2.referenceHint && pg2.referenceHint.order === MP1 && pg2.referenceHint.client === 'Betime Online', `and it says why: the number is held only by Betime Online's reference copy (${JSON.stringify(pg2.referenceHint)})`);
  const mm = await fetch(B + `/api/label-imports/${li.body.importId}/pages/1/match`, { method: 'POST', headers: MH(admin), body: JSON.stringify({ orderNumber: MP1 }) });
  const mmb = await J(mm);
  ok(mm.status === 409 && mmb.referenceOnly === true, `a hand match onto the reference copy is refused 409 (${mm.status}: ${String(mmb.error).slice(0, 60)}…)`);
  db = await readDb();
  ok(!db.orderLabels[MP1], 'and nothing was attached by the refusal');

  console.log('\n=== the picking list arrives later — the label finds it on its own ===');
  await fetch(M + `/__ctl/track/9001?no=${T1}`);
  await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  const u2 = await upload(admin, xlsxOf([{ 'GI No': GI1, 'Tracking No': T1, 'SKU Code': '8006', 'Quantity': 1 }]), 'gi-analysis-2.xlsx');
  ok(u2.status === 200, `second picking list uploaded (${u2.status})`);
  let matched2 = null;
  for (let i = 0; i < 12; i++) { await sleep(1500); imp = await getImport(admin, li.body.importId); if (imp.pages[1].matchStatus === 'matched') { matched2 = imp.pages[1]; break; } }
  ok(matched2 && matched2.matchedOrderNumber === GI1, `the late-orders sweep attached page 2 to ${GI1} by the marketplace number of its reference copy (${matched2 && matched2.matchedOrderNumber} via ${matched2 && matched2.matchMethod})`);
  ok(matched2 && matched2.referenceHint?.via === true && matched2.referenceHint.order === MP1 && matched2.referenceHint.client === 'Betime Online', `the "only a reference holds it" note becomes "matched via the reference copy" (${JSON.stringify(matched2 && matched2.referenceHint)})`);

  console.log('\n=== completion of the GI order reaches OneCart through the waybill twin ===');
  const before = (await mockCalls()).filter(c => c.method === 'PUT' && /\/orders\/9003$/.test(c.path)).length;
  for (let i = 0; i < 3; i++) await scan(admin, GI3, '8006');
  const cp = await complete(admin, GI3);
  ok(cp.status === 200 && cp.body.ok !== false, `completed ${GI3} (${cp.status} ${JSON.stringify(cp.body).slice(0, 60)})`);
  await sleep(8000);   // mark_as_shipped is async on the mock; the read-back confirms ~4.5s later
  const after = (await mockCalls()).filter(c => c.method === 'PUT' && /\/orders\/9003$/.test(c.path)).length;
  ok(after === before + 1, `OneCart was told "shipped" for its own order 9003 — the twin was found by waybill, not by number (PUTs ${before}→${after})`);
  db = await readDb();
  const rel = (db.auditLog || []).filter(e => e.type === 'onecart_completion_pushed' || e.type === 'onecart_completion_unconfirmed').filter(e => e.order === GI3 || e.orderNumber === GI3 || JSON.stringify(e).includes(GI3));
  ok(rel.length >= 1 && rel[0].viaReference === true && rel[0].twinVia === 'waybill' && rel[0].channelOrder === MP3, `audited on the work order: viaReference, twinVia=waybill, channelOrder=${MP3} (${JSON.stringify(rel[0] || null).slice(0, 160)})`);

  console.log('\n=== a label filed the OLD way (on the reference copy) is re-homed at boot ===');
  await stopKid(serverKid); await sleep(2500);
  db = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  // Put the label back where the old build left it: keyed on the reference number, page pointing at it.
  const lab = db.orderLabels[GI3]; delete db.orderLabels[GI3]; db.orderLabels[MP3] = lab;
  const impRec = db.labelImports.find(i => i.id === li.body.importId);
  impRec.pages[0].matchedOrderNumber = MP3; impRec.pages[0].matchMethod = 'order_number';
  db.orderLabels['260907ABCDEF01'] = { importId: 'gone', pageIndex: 0, pageFile: 'x.pdf' };   // a stray record on a reference with no page behind it
  fs.writeFileSync(DBP, JSON.stringify(db));
  try { fs.unlinkSync(path.join(DDIR, 'tenants', 'default', 'scan-journal.ndjson')); } catch {}
  await bootServer();
  const admin2 = await login('demo', 'demo');
  db = await readDb();
  ok(!!db.orderLabels[GI3] && !db.orderLabels[MP3], `boot moved the label off ${MP3} back onto ${GI3}`);
  ok(!db.orderLabels['260907ABCDEF01'], 'the stray label record on a reference number is gone');
  const pg = db.labelImports.find(i => i.id === li.body.importId).pages[0];
  ok(pg.matchedOrderNumber === GI3 && pg.rehomedFrom === MP3, `the page says it was re-homed from ${pg.rehomedFrom} (${pg.matchedOrderNumber})`);
  const ra = (db.auditLog || []).filter(e => e.type === 'labels_rehomed_from_reference');
  ok(ra.length === 1 && ra[0].moved === 1 && ra[0].freed === 1, `audited labels_rehomed_from_reference moved=1 freed=1 (${JSON.stringify(ra.map(e => [e.moved, e.freed]))})`);
  const pdf2 = await fetch(B + `/api/order-label/${GI3}/pdf`, { headers: { 'x-auth-token': admin2 } });
  ok(pdf2.status === 200, `and the label prints for ${GI3} again (${pdf2.status})`);
  await stopKid(serverKid); await sleep(2500);
  await bootServer();
  db = await readDb();
  ok((db.auditLog || []).filter(e => e.type === 'labels_rehomed_from_reference').length === 1, 'a second boot moves nothing and logs nothing');

  await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
