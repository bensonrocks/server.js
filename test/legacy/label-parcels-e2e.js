// A split order gets BOTH its labels. Driven with the user's own 2-page ZORT
// print (two parcels, two tracking numbers, one order number) through the real
// upload + label-import + OCR + print endpoints.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const { PDFDocument } = require('/home/user/server.js/node_modules/pdf-lib');
const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const UP = '/root/.claude/uploads/c6f7f812-7f43-5071-90d1-eb00f9dd51b6';
const PORT = 4761, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'lbl-parcel-data'), DBP = path.join(DDIR, 'tenants', 'default', 'db.json');
const MASTER = process.env.MASTER_KEY || '201432547E';
const ORDER = '171067267872131', T1 = 'LZSGD1015417357', T2 = 'LZSGD1015417039';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids.length = 0; await sleep(1200); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
const H = tok => ({ 'x-auth-token': tok, 'x-master-key': MASTER });
async function login(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); return d.token; }
const readDb = async () => { await sleep(1200); return JSON.parse(fs.readFileSync(DBP, 'utf8')); };
function xlsxOf(rows) { const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S'); return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); }
async function importLabels(tok, file, name) {
  const fd = new FormData(); fd.append('labelPdf', new Blob([fs.readFileSync(file)]), name);
  const r = await fetch(B + '/api/label-imports', { method: 'POST', headers: H(tok), body: fd }); return { status: r.status, body: await J(r) };
}
async function imp(tok, id) { return J(await fetch(B + `/api/label-imports/${id}`, { headers: H(tok) })); }
async function waitOcr(tok, id, want, ms = 120000) { const t0 = Date.now(); let d; while (Date.now() - t0 < ms) { d = await imp(tok, id); const m = (d.pages || []).filter(p => p.matchStatus === 'matched').length; if (m >= want || (d.pages || []).every(p => p.ocr || p.ocrFailed || p.matchStatus === 'matched')) return d; await sleep(2000); } return d; }
async function orders(tok) { const d = await J(await fetch(B + '/api/orders?range=all', { headers: H(tok) })); return Array.isArray(d) ? d : (d.orders || []); }
async function pdfPages(buf) { return (await PDFDocument.load(buf)).getPageCount(); }

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'lbl-parcel-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
  const tok = await login('demo', 'demo');

  console.log('\n=== the order, with the FIRST parcel\'s tracking number as its waybill (what ZORT sync stores) ===');
  const fd = new FormData(); fd.append('orderFile', new Blob([xlsxOf([{ 'Order No': ORDER, 'Waybill Ref': T1, 'SKU Code': '8006', 'Quantity': 5 }])]), 'mayer.xlsx'); fd.append('client_name', 'MAYER2026'); fd.append('arrange_delivery', 'no');
  const up = await fetch(B + '/api/upload', { method: 'POST', headers: H(tok), body: fd });
  ok(up.status === 200, `order uploaded (${up.status})`);
  let list = await orders(tok); let o = list.find(x => x.order_number === ORDER);
  ok(o && o.waybill_number === T1 && !o.has_order_label && o.label_pages === 0, `order holds waybill ${T1}, no label yet (label_pages=${o && o.label_pages})`);

  console.log('\n=== the user\'s 2-page ZORT print: two parcels, two tracking numbers, one order ===');
  const li = await importLabels(tok, path.join(UP, '71fbf9ce-DisplayPdfByUrl_42.pdf'), 'DisplayPdfByUrl_42.pdf');
  ok(li.status === 200 && li.body.importId, `label PDF imported (${li.status} ${JSON.stringify(li.body).slice(0,80)})`);
  const IMP = li.body.importId;
  const d1 = await waitOcr(tok, IMP, 2);
  const p = d1.pages || [];
  console.log('   pages:', p.map(x => `${x.pageIndex + 1}:${x.matchStatus}/${x.matchMethod}/${x.extracted?.trackingNumber}${x.parcel ? '/parcel' : ''}`).join('  '));
  ok(p.length === 2, `2 pages read (${p.length})`);
  ok(p[0].matchStatus === 'matched' && p[0].matchedOrderNumber === ORDER, `page 1 (${p[0].extracted?.trackingNumber}) matched to ${ORDER}`);
  ok(p[1].matchStatus === 'matched' && p[1].matchedOrderNumber === ORDER, `page 2 (${p[1].extracted?.trackingNumber}) ALSO matched to ${ORDER} — not filed duplicate (${p[1].matchStatus})`);
  ok(new Set([p[0].extracted?.trackingNumber, p[1].extracted?.trackingNumber]).size === 2 && [T1, T2].every(t => p.some(x => x.extracted?.trackingNumber === t)), `the two tracking numbers read back as ${T1} and ${T2}`);
  ok(p.filter(x => x.parcel).length === 1, 'exactly one page flagged as another parcel');
  ok(!p.some(x => x.matchStatus === 'duplicate'), 'nothing filed as a duplicate');
  const db1 = await readDb();
  const ref = db1.orderLabels[ORDER];
  ok(ref && Array.isArray(ref.parcels) && ref.parcels.length === 1 && ref.importId === IMP, `db.orderLabels holds a primary page + 1 parcel (${ref && (ref.parcels || []).length})`);
  ok(ref && new Set([ref.tracking, ref.parcels[0].tracking]).size === 2, `each page carries its own tracking (${ref && ref.tracking} / ${ref && ref.parcels[0].tracking})`);
  list = await orders(tok); o = list.find(x => x.order_number === ORDER);
  ok(o.has_order_label && o.label_pages === 2, `the Orders list says Label ×2 (label_pages=${o.label_pages})`);
  ok(Array.isArray(o.waybills) && o.waybills.length === 2 && o.waybills.includes(T1) && o.waybills.includes(T2), `the order is known by BOTH waybills (${(o.waybills || []).join(', ')})`);
  ok(o.waybill_number === T1, 'the stored waybill_number itself is untouched');
  const wl2 = await J(await fetch(B + '/api/waybill-lookup', { method: 'POST', headers: { ...H(tok), 'Content-Type': 'application/json' }, body: JSON.stringify({ waybill: T2 }) }));
  ok(wl2.order_number === ORDER, `scanning the SECOND parcel's barcode ${T2} opens the order`);

  console.log('\n=== printing gives BOTH labels ===');
  const pr = await fetch(B + `/api/order-label/${ORDER}/pdf`, { headers: H(tok) });
  const prBuf = Buffer.from(await pr.arrayBuffer());
  ok(pr.status === 200 && pr.headers.get('content-type') === 'application/pdf', `print route 200 pdf (${pr.status})`);
  ok(await pdfPages(prBuf) === 2, `the printed document has 2 pages (${await pdfPages(prBuf)})`);
  const p2 = await fetch(B + `/api/order-label/${ORDER}/pdf?parcel=2`, { headers: H(tok) });
  ok(p2.status === 200 && await pdfPages(Buffer.from(await p2.arrayBuffer())) === 1, 'parcel=2 serves just the second box');
  const p9 = await fetch(B + `/api/order-label/${ORDER}/pdf?parcel=9`, { headers: H(tok) });
  ok(p9.status === 404, `a parcel that does not exist is 404 (${p9.status})`);

  console.log('\n=== the SAME label again is still a duplicate, not a third parcel ===');
  const li2 = await importLabels(tok, path.join(UP, '78c2f0d7-171067267872131_label.pdf'), 'again_' + ORDER + '.pdf');
  const d2 = await waitOcr(tok, li2.body.importId, 1);
  const q = d2.pages[0];
  console.log('   page:', q.matchStatus, q.matchMethod, q.extracted?.trackingNumber, q.parcel ? 'parcel' : '');
  ok(q.extracted?.trackingNumber === T1, `it reads the first parcel's number ${T1}`);
  list = await orders(tok); o = list.find(x => x.order_number === ORDER);
  ok(o.label_pages === 2 && !q.parcel, `same tracking → NOT a third parcel: still 2 labels (label_pages=${o.label_pages}, parcel=${!!q.parcel})`);
  const db2 = await readDb();
  const trk = new Set([db2.orderLabels[ORDER].tracking, ...(db2.orderLabels[ORDER].parcels || []).map(x => x.tracking)]);
  ok(trk.size === 2 && trk.has(T1) && trk.has(T2), `the record still holds exactly ${T1} + ${T2}`);
  const pr2 = await fetch(B + `/api/order-label/${ORDER}/pdf`, { headers: H(tok) });
  ok(await pdfPages(Buffer.from(await pr2.arrayBuffer())) === 2, 'printing still gives exactly 2 pages');

  console.log('\n=== unmatching ONE page keeps the other parcel ===');
  const parcelPage = p.find(x => x.parcel);
  const um = await fetch(B + `/api/label-imports/${IMP}/pages/${parcelPage.pageIndex}/match`, { method: 'DELETE', headers: H(tok) });
  ok(um.status === 200, `unmatch page ${parcelPage.pageIndex + 1} (${um.status})`);
  list = await orders(tok); o = list.find(x => x.order_number === ORDER);
  ok(o.has_order_label && o.label_pages === 1, `one label left on the order (label_pages=${o.label_pages})`);
  const pr3 = await fetch(B + `/api/order-label/${ORDER}/pdf`, { headers: H(tok) });
  ok(await pdfPages(Buffer.from(await pr3.arrayBuffer())) === 1, 'printing gives 1 page now');

  console.log('\n=== a hand match of that page puts the parcel back ===');
  const mm = await J(await fetch(B + `/api/label-imports/${IMP}/pages/${parcelPage.pageIndex}/match`, { method: 'POST', headers: { ...H(tok), 'Content-Type': 'application/json' }, body: JSON.stringify({ orderNumber: ORDER }) }));
  ok(mm.ok && mm.role === 'parcel' && mm.labelPages === 2, `manual match answers role=parcel, 2 labels (${mm.role}, ${mm.labelPages})`);
  list = await orders(tok); o = list.find(x => x.order_number === ORDER);
  ok(o.label_pages === 2, `Label ×2 again (${o.label_pages})`);

  console.log('\n=== ↻ Rematch All keeps both parcels ===');
  const rm = await J(await fetch(B + `/api/label-imports/${IMP}/rematch`, { method: 'POST', headers: { ...H(tok), 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) }));
  const d3 = await imp(tok, IMP);
  ok(d3.pages.every(x => x.matchStatus === 'matched' && x.matchedOrderNumber === ORDER) && d3.pages.filter(x => x.parcel).length === 1, `after rematch: both matched, one a parcel (${d3.pages.map(x => x.matchStatus + (x.parcel ? '/parcel' : '')).join(', ')})`);
  list = await orders(tok); o = list.find(x => x.order_number === ORDER);
  ok(o.label_pages === 2, `still Label ×2 (${o.label_pages})`);

  console.log('\n=== deleting the import takes BOTH parcels off ===');
  const del = await fetch(B + `/api/label-imports/${IMP}`, { method: 'DELETE', headers: H(tok) });
  ok(del.status === 200, `import deleted (${del.status})`);
  const db3 = await readDb();
  ok(!db3.orderLabels[ORDER] || (db3.orderLabels[ORDER].importId !== IMP && !(db3.orderLabels[ORDER].parcels || []).some(x => x.importId === IMP)), 'no page of the deleted import is left on the order');

  await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
