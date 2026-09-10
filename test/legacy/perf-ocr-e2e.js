// The OCR path with the worker: an image-only label PDF (no text layer) must
// still render (worker) → OCR (Tesseract) → match, exactly as before.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const S = __dirname;
const PORT = 4803, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'perf-ocr-data'), MASTER = process.env.MASTER_KEY || '201432547E';
const LOG = path.join(S, 'perf-ocr-server.log');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stop(c) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} await sleep(2000); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
let tok = '';
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': tok, 'x-master-key': MASTER });
async function login() { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) })); tok = d.token; }
function xlsxOf(rows) { const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S'); return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); }
(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.mkdirSync(DDIR, { recursive: true }); fs.rmSync(LOG, { force: true });
  const srv = spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, LOG);
  await waitUp(B + '/api/version'); await sleep(2500); await login();
  const fd = new FormData();
  fd.append('orderFile', new Blob([xlsxOf([1, 2, 3].map(i => ({ 'Order No': `PERF-ORD-${String(i).padStart(3, '0')}`, 'Waybill Ref': `LZSGD10${15000000 + i}`, 'SKU Code': 'PERF-SKU', 'Quantity': 1 })))]), 'perf.xlsx');
  fd.append('client_name', 'PERFCO'); fd.append('arrange_delivery', 'no');
  ok((await fetch(B + '/api/upload', { method: 'POST', headers: { 'x-auth-token': tok, 'x-master-key': MASTER }, body: fd })).status === 200, 'seed: 3 orders');
  const lf = new FormData(); lf.append('labelPdf', new Blob([fs.readFileSync(path.join(S, 'perf-scan3.pdf'))]), 'scanned-awb.pdf');
  const t = Date.now();
  const d = await J(await fetch(B + '/api/label-imports', { method: 'POST', headers: { 'x-auth-token': tok, 'x-master-key': MASTER }, body: lf }));
  ok(d.pageCount === 3, `image-only 3-page PDF imported (${d.pageCount} pages, ${Date.now() - t} ms)`);
  ok(d.ocrPages === 3, `all 3 pages were OCR'd in the first pass (${d.ocrPages})`);
  ok(d.matched === 3, `all 3 matched their orders from the OCR text (${d.matched})`);
  const v = await J(await fetch(B + '/api/version'));
  ok(v.pdfWorker.done >= 4 && v.pdfWorker.crashes === 0, `the worker rendered them (${v.pdfWorker.done} jobs, ${v.pdfWorker.crashes} restarts)`);
  const orders = await J(await fetch(B + '/api/orders?range=all', { headers: H() }));
  ok(orders.filter(o => /^PERF-ORD/.test(o.order_number) && o.has_order_label).length === 3, 'every order carries its label');
  await stop(srv);
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); for (const c of kids) await stop(c); process.exit(2); });
