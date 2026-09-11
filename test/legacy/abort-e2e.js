// Two faults reported live (System Outages, 10 Sep 2026), both fixed here.
//
// 1. `BadRequestError: request aborted` on /api/errors — a browser posted an
//    error report and went away before the body arrived. Nothing failed. The
//    error middleware filed it as a red office outage, and because /api/errors
//    IS the reporting route, the error reporter reported its own abort.
// 2. `TypeError: Cannot read properties of null (reading 'document')` in
//    printWaybillLabel — window.open returns null when a pop-up is blocked and
//    the next line reads .document off it. A packer (PACK3) pressed print and
//    got the full-screen tech-error dialog instead of a label.
//
// (1) is proven at the API, (2) in a real browser with window.open returning
// null, which is exactly what a pop-up blocker does. Both fail on the pre-fix
// build (IDEALONE_SERVER / IDEALONE_APPJS point the suite at another copy).
const fs = require('fs'); const path = require('path'); const http = require('http'); const { spawn } = require('child_process');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const S = __dirname;
const SERVER = process.env.IDEALONE_SERVER || '/home/user/server.js/server.js';
const PORT = 4809, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'abort-data'), MASTER = process.env.MASTER_KEY || '201432547E';
const LOG = path.join(S, 'abort-server.log');
const DBP = path.join(DDIR, 'tenants', 'default', 'db.json');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up'); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids.length = 0; await sleep(1500); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
let tok = '';
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': tok, 'x-master-key': MASTER });
async function login() { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) })); tok = d.token; }
function xlsxOf(rows) { const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S'); return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); }
const storedErrors = () => { try { return JSON.parse(fs.readFileSync(DBP, 'utf8')).systemErrors || []; } catch { return []; } };

// Promise more bytes than we send, then destroy the socket — exactly what a
// closed tab does to an in-flight POST.
function abortedPost(pathname) {
  return new Promise(resolve => {
    const req = http.request({ host: 'localhost', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '4000' } });
    req.on('error', () => resolve('socket-error'));
    req.write('{"message":"half a report');
    setTimeout(() => { req.destroy(); resolve('aborted'); }, 150);
  });
}
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.mkdirSync(DDIR, { recursive: true }); fs.rmSync(LOG, { force: true });
  spawnLogged([SERVER], { PORT: String(PORT), DATA_DIR: DDIR }, LOG);
  await waitUp(B + '/api/version'); await sleep(2500); await login();

  // ── 1. AN ABORTED REQUEST IS NOT AN OUTAGE ──────────────────────────────
  const before = storedErrors().length;
  await abortedPost('/api/errors');
  await abortedPost('/api/errors');
  await abortedPost('/api/scan/increment');      // any other body-parsing route
  await sleep(3000);
  const rows = storedErrors();
  ok(rows.length === before, `three aborted POSTs file NO System Outage row (${before} -> ${rows.length})`);
  ok(!rows.some(e => /request aborted/i.test(e.message || '')), 'nothing about "request aborted" is stored on disk');
  const log = fs.readFileSync(LOG, 'utf8');
  ok(/\[aborted\][^\n]*\/api\/errors/.test(log), 'each abort is still LOGGED, so it stays visible without being an outage');
  ok(!/\[unhandled\][^\n]*request aborted/.test(log), 'and it no longer goes down the unhandled-error path');

  // The exclusion must not be a blanket "stop recording errors".
  const rGood = await fetch(B + '/api/errors', { method: 'POST', headers: H(), body: JSON.stringify({ message: 'AbortSuiteRealFault', context: 'test', app: 'office' }) });
  ok(rGood.status < 500, `a COMPLETE error report is still accepted (${rGood.status})`);
  await sleep(2500);
  ok(storedErrors().some(e => /AbortSuiteRealFault/.test(e.message || '')), 'a real reported fault IS still recorded');

  // ── 2. A BLOCKED POP-UP MUST NOT CRASH THE PRINT BUTTON ─────────────────
  const fd = new FormData();
  fd.append('orderFile', new Blob([xlsxOf([{ 'Order No': 'ABRT-1', 'Waybill Ref': 'LZSGD1099000001', 'SKU Code': 'ABRT-SKU', 'Quantity': 1 }])]), 'abrt.xlsx');
  fd.append('client_name', 'ABRTCO'); fd.append('arrange_delivery', 'no');
  ok((await fetch(B + '/api/upload', { method: 'POST', headers: { 'x-auth-token': tok, 'x-master-key': MASTER }, body: fd })).status === 200, 'seed: one order with a waybill');
  await J(await fetch(B + '/api/scan/setqty', { method: 'POST', headers: H(), body: JSON.stringify({ orderNumber: 'ABRT-1', sku: 'ABRT-SKU', qty: 1 }) }));
  const done = await J(await fetch(B + '/api/scan/complete', { method: 'POST', headers: H(), body: JSON.stringify({ orderNumber: 'ABRT-1', startTime: new Date().toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) }));
  ok(done.ok === true, 'seed: the order is completed, so the row carries the reprint-label button');
  await sleep(2000);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, ctxOpts] of [['Pixel 5', { ...devices['Pixel 5'] }], ['desktop', { viewport: { width: 1280, height: 900 } }]]) {
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts);
    // EXACTLY what a pop-up blocker does: window.open returns null.
    await ctx.addInitScript(() => { window.open = () => null; });
    const page = await ctx.newPage();
    const alerts = []; page.on('dialog', d => { alerts.push(d.message()); d.dismiss().catch(() => {}); });
    const reported = []; page.on('request', r => { if (r.url().includes('/api/errors') && r.method() === 'POST') reported.push(r.postData() || ''); });
    await page.goto(B + '/'); await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo'); await page.click('#loginBtn');
    await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
    await sleep(1200);
    // The Active/Completed switcher is a data-oview SUB-TAB, not a filter chip.
    await domClick(page, '.tab-btn[data-tab="orders"]'); await sleep(800);
    await domClick(page, '[data-oview="completed"]'); await sleep(1500);
    await page.waitForSelector('.btn-reprint-label', { timeout: 15000 });

    // The REAL button a packer presses to reprint a label.
    await domClick(page, '.btn-reprint-label');
    await sleep(900);

    ok(alerts.some(a => /allow pop-ups/i.test(a)), `the packer is told to allow pop-ups (${JSON.stringify(alerts).slice(0, 90)})`);
    const techShown = await page.evaluate(() => {
      const ov = document.getElementById('techErrorOverlay');
      return !!(ov && getComputedStyle(ov).display !== 'none');
    });
    ok(!techShown, 'the full-screen technical error dialog is NOT shown');
    ok(!reported.some(b => /reading 'document'/.test(b)), 'nothing is filed to System Outages about it');
    ok(!storedErrors().some(e => /reading 'document'/.test(e.message || '')), 'and nothing lands on disk either');
    await ctx.close();
  }
  await browser.close(); await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
