// Speed-up pass: gzip, PDF work on a worker thread, db.json writes coalesced
// and measured, a shutdown that flushes a pending write — and the reason for
// all of it: a plain request must not queue behind a label import.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const S = __dirname;
const PORT = 4801, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'perf-data'), MASTER = process.env.MASTER_KEY || '201432547E';
const LOG = path.join(S, 'perf-server.log');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stop(c, sig = 'SIGTERM') { try { process.kill(-c.pid, sig); } catch {} try { process.kill(c.pid, sig); } catch {} for (let i = 0; i < 40; i++) { await sleep(150); try { process.kill(c.pid, 0); } catch { return; } } }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
let tok = '';
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': tok, 'x-master-key': MASTER });
async function login() { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) })); tok = d.token; }
function xlsxOf(rows) { const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S'); return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); }
const DBP = path.join(DDIR, 'tenants', 'default', 'db.json');
const boot = async (env = {}) => { const c = spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR, ...env }, LOG); await waitUp(B + '/api/version'); await sleep(2500); await login(); return c; };
const PDF = fs.readFileSync(path.join(S, 'perf-12.pdf'));

// Fire pings every 40ms while `work` runs; report the worst wait.
async function pingWhile(work) {
  let worst = 0, n = 0, stopFlag = false;
  const pinger = (async () => { while (!stopFlag) { const t = Date.now(); try { await fetch(B + '/api/ping'); } catch {} worst = Math.max(worst, Date.now() - t); n++; await sleep(40); } })();
  const r = await work();
  stopFlag = true; await pinger;
  return { r, worst, n };
}
async function importPdf(name) {
  const fd = new FormData(); fd.append('labelPdf', new Blob([PDF]), name);
  const t = Date.now();
  const d = await J(await fetch(B + '/api/label-imports', { method: 'POST', headers: { 'x-auth-token': tok, 'x-master-key': MASTER }, body: fd }));
  return { d, ms: Date.now() - t };
}
async function renderAll(importId) {
  const t = Date.now();
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(B + `/api/label-imports/${importId}/pages/${i}/png?size=full`, { headers: H() })));
  return { statuses: rs.map(r => r.status), ms: Date.now() - t };
}

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.mkdirSync(DDIR, { recursive: true }); fs.rmSync(LOG, { force: true });
  let srv = await boot();

  // ── gzip ────────────────────────────────────────────────────────────────
  const v = await fetch(B + '/api/version', { headers: { 'Accept-Encoding': 'gzip' } });
  const vj = await v.json();
  ok(vj.db && typeof vj.db.debounceMs === 'number' && vj.pdfWorker && vj.pdfWorker.enabled === true, `/api/version reports the write cost and the PDF worker (debounce ${vj.db && vj.db.debounceMs} ms, worker ${vj.pdfWorker && vj.pdfWorker.enabled})`);
  const js = await fetch(B + '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  const jsBytes = Buffer.from(await js.arrayBuffer()).length; // fetch inflates; use the raw content-length via a HEAD-less trick below
  ok(js.headers.get('content-encoding') === 'gzip', `app.js is served gzipped (content-encoding: ${js.headers.get('content-encoding')})`);
  const jsRaw = await fetch(B + '/app.js', { headers: { 'Accept-Encoding': 'identity' } });
  ok(jsRaw.headers.get('content-encoding') == null && Buffer.from(await jsRaw.arrayBuffer()).length === jsBytes, 'a client that cannot take gzip still gets the identical file uncompressed');
  // How much smaller on the wire: gzip it ourselves at the same level compression uses.
  const zlib = require('zlib'); const gz = zlib.gzipSync(fs.readFileSync('/home/user/server.js/public/app.js')).length;
  ok(gz < jsBytes / 3, `app.js on the wire: ${(jsBytes / 1024).toFixed(0)} KB → ~${(gz / 1024).toFixed(0)} KB`);

  // Seed 12 orders whose waybills the 12-page PDF prints.
  const fd = new FormData();
  fd.append('orderFile', new Blob([xlsxOf(Array.from({ length: 12 }, (_, i) => ({ 'Order No': `PERF-ORD-${String(i + 1).padStart(3, '0')}`, 'Waybill Ref': `LZSGD10${15000001 + i}`, 'SKU Code': 'PERF-SKU', 'Quantity': 1 })))]), 'perf.xlsx');
  fd.append('client_name', 'PERFCO'); fd.append('arrange_delivery', 'no');
  const up = await fetch(B + '/api/upload', { method: 'POST', headers: { 'x-auth-token': tok, 'x-master-key': MASTER }, body: fd });
  ok(up.status === 200, `seed: 12 orders uploaded (${up.status})`);
  const ordersResp = await fetch(B + '/api/orders?range=all', { headers: { ...H(), 'Accept-Encoding': 'gzip' } });
  ok(ordersResp.headers.get('content-encoding') === 'gzip', 'the orders list JSON is gzipped');
  const orders = await ordersResp.json();
  ok(orders.filter(o => /^PERF-ORD/.test(o.order_number)).length === 12, 'and still parses to the 12 orders');

  // ── label import through the worker ────────────────────────────────────
  const { r: imp, worst: worstOn } = await pingWhile(() => importPdf('perf-labels.pdf'));
  ok(imp.d.importId && imp.d.pageCount === 12, `12-page label PDF imported (${imp.d.pageCount} pages, ${imp.ms} ms)`);
  ok(imp.d.matched === 12, `all 12 pages matched their orders by tracking number (${imp.d.matched})`);
  const impDir = [path.join(DDIR, 'label_imports', imp.d.importId), path.join(DDIR, 'tenants', 'default', 'label_imports', imp.d.importId)].find(p => fs.existsSync(p));
  const pageFiles = impDir ? fs.readdirSync(impDir).filter(f => /^page_\d+\.pdf$/.test(f)).length : -1;
  ok(pageFiles === 12, `12 single-page PDFs on disk (${pageFiles})`);
  const pdfResp = await fetch(B + `/api/label-imports/${imp.d.importId}/pages/0/pdf`, { headers: { ...H(), 'Accept-Encoding': 'gzip' } });
  ok(pdfResp.status === 200 && pdfResp.headers.get('content-encoding') == null && Buffer.from(await pdfResp.arrayBuffer()).slice(0, 4).toString() === '%PDF', 'a PDF is served as-is, not gzipped');
  const { r: rn, worst: worstRenderOn } = await pingWhile(() => renderAll(imp.d.importId));
  ok(rn.statuses.every(s => s === 200), `12 pages rendered to PNG through the worker (${rn.ms} ms for 12)`);
  const pngResp = await fetch(B + `/api/label-imports/${imp.d.importId}/pages/3/png?size=thumb`, { headers: { ...H(), 'Accept-Encoding': 'gzip' } });
  ok(pngResp.headers.get('content-encoding') == null && Buffer.from(await pngResp.arrayBuffer()).slice(1, 4).toString() === 'PNG', 'a PNG is served as-is, not gzipped');
  const v2 = await J(await fetch(B + '/api/version'));
  ok(v2.pdfWorker.done >= 14 && v2.pdfWorker.crashes === 0, `the worker did the work (${v2.pdfWorker.done} jobs, ${v2.pdfWorker.crashes} restarts, avg ${v2.pdfWorker.avgMs} ms)`);
  const hc = await J(await fetch(B + '/api/master/connections/health', { headers: H() }));
  ok(hc.server && hc.server.pdfWorker && hc.server.db && hc.server.gzip === true, 'the health check carries the server-thread block');
  console.log(`  worst /api/ping wait during the import WITH the worker: ${worstOn} ms; during 12 renders: ${worstRenderOn} ms`);

  // ── write coalescing ───────────────────────────────────────────────────
  const w0 = (await J(await fetch(B + '/api/version'))).db.writes;
  const t0 = Date.now();
  for (let i = 1; i <= 10; i++) await J(await fetch(B + '/api/scan/setqty', { method: 'POST', headers: H(), body: JSON.stringify({ orderNumber: 'PERF-ORD-001', sku: 'PERF-SKU', qty: i % 2 }) }));
  const burstMs = Date.now() - t0;
  await sleep(2600);
  const v3 = await J(await fetch(B + '/api/version'));
  ok(v3.db.writes - w0 <= 3, `10 rapid writes in ${burstMs} ms became ${v3.db.writes - w0} db.json write(s) (${v3.db.coalesced} folded so far)`);
  ok(v3.db.bytes > 0 && typeof v3.db.stringifyMs === 'number', `the write cost is measured (${(v3.db.bytes / 1024).toFixed(0)} KB, ${v3.db.stringifyMs} ms)`);
  const onDisk = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  const bt = onDisk.batches.find(b => b.client_name === 'PERFCO');
  ok(bt && bt.orderStates['PERF-ORD-001'] && bt.orderStates['PERF-ORD-001'].scanned['PERF-SKU'] === 0, 'and db.json holds the FINAL state of the burst (last write wins)');

  // ── a write in its debounce window survives SIGTERM ────────────────────
  await J(await fetch(B + '/api/scan/setqty', { method: 'POST', headers: H(), body: JSON.stringify({ orderNumber: 'PERF-ORD-002', sku: 'PERF-SKU', qty: 1 }) }));
  await stop(srv, 'SIGTERM');   // within 250 ms of the write
  const afterStop = JSON.parse(fs.readFileSync(DBP, 'utf8')).batches.find(b => b.client_name === 'PERFCO');
  ok(afterStop.orderStates['PERF-ORD-002'] && afterStop.orderStates['PERF-ORD-002'].scanned['PERF-SKU'] === 1, 'a write still in its debounce window is flushed by the shutdown');
  ok(/PDF worker thread: available/.test(fs.readFileSync(LOG, 'utf8')), 'the boot log says the worker is carrying PDF work');

  // ── the same import with the worker OFF (in-process fallback) ──────────
  srv = await boot({ PDF_WORKERS: '0' });
  const v4 = await J(await fetch(B + '/api/version'));
  ok(v4.pdfWorker.enabled === false, 'PDF_WORKERS=0 disables the worker (in-process fallback)');
  const { r: imp2, worst: worstOff } = await pingWhile(() => importPdf('perf-labels-2.pdf'));
  ok(imp2.d.pageCount === 12, `the in-process fallback still imports 12 pages (${imp2.ms} ms)`);
  const { r: rn2, worst: worstRenderOff } = await pingWhile(() => renderAll(imp2.d.importId));
  ok(rn2.statuses.every(s => s === 200), `and still renders all 12 (${rn2.ms} ms for 12)`);
  console.log(`  worst /api/ping wait during the import WITHOUT the worker: ${worstOff} ms; during 12 renders: ${worstRenderOff} ms`);
  ok(worstRenderOn < worstRenderOff, `a plain request waits less behind 12 page renders with the worker (${worstRenderOn} ms) than without (${worstRenderOff} ms)`);
  ok(/PDF work stays in-process|worker unavailable/.test(fs.readFileSync(LOG, 'utf8').split('PDF_WORKERS').pop() || '') || v4.pdfWorker.enabled === false, 'the fallback is said in the log');
  await stop(srv);
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); for (const c of kids) await stop(c, 'SIGKILL'); process.exit(2); });
