// On screen: opening a synced order no longer waits on the label browser —
// the scan overlay is up within seconds, the pill settles to "no label yet —
// tap" (no dialog), and when the label lands in the background the pill and
// the Label button repaint by themselves, with no reload and no tap.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const S = __dirname;
const PORT = 4793, MPORT = 4794, B = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
const DDIR = path.join(S, 'lag-br-data'), MASTER = process.env.MASTER_KEY || '201432547E';
const SHOTS = path.join(S, 'lag-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids.length = 0; await sleep(1200); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
const H = tok => ({ 'Content-Type': 'application/json', 'x-auth-token': tok, 'x-master-key': MASTER });
async function apiLogin(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); return d.token; }
async function login(page, id, pw) {
  await page.goto(B + '/'); await page.fill('#loginName', id); await page.fill('#loginIC', pw); await page.click('#loginBtn');
  await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
  await sleep(900);
}
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
const pillText = page => page.evaluate(() => document.getElementById('scanWaybillPill')?.innerText.replace(/\s+/g, ' ').trim() || '');

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  spawnLogged([path.join(S, 'lag-mock.js'), String(MPORT)], {}, path.join(S, 'lag-br-mock.log'));
  await waitUp(M + '/_hits');
  // Cap 0: the background never opens the browser, so a label only lands when
  // the harness taps for it — which is what proves the screen's own poll.
  spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR, ZORT_WEB_BASE: M, ZORT_LABEL_RETRY_MS: '2000', ZORT_BACKOFF_MS: '2000', ZORT_OUTBOX_MS: '3000',
    ZORT_WEB_PROBE_DELAY_MS: '1500', ZORT_WEB_PDF_WAIT_MS: '1500', ZORT_WEB_NAV_TIMEOUT: '8000', ZORT_BROWSER_PATH: '/opt/pw-browsers/chromium', ZORT_WEB_MAX_PER_PASS: '0', ZORT_WEB_RETRY_MS: '600000' }, path.join(S, 'lag-br-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
  // The API side signs in as a DIFFERENT user — one active device per user,
  // and the browser below is demo.
  const dtok = await apiLogin('demo', 'demo');
  await fetch(B + '/api/master/users', { method: 'POST', headers: H(dtok), body: JSON.stringify({ id: 'whguy', name: 'Floor', password: 'whpass1', role: 'warehouse' }) });
  const tok = await apiLogin('whguy', 'whpass1');
  ok(!!tok, 'seed: API session as whguy');
  const st = await J(await fetch(B + '/api/master/zort/stores', { method: 'POST', headers: H(tok), body: JSON.stringify({ clientName: 'LG', storename: 'lg', apikey: 'k', apisecret: 's', endpoint: M, enabled: true, labelSync: true, webEmail: 'lg@example.com', webPassword: 'pw' }) }));
  await J(await fetch(B + `/api/master/zort/stores/${st.id}/pull`, { method: 'POST', headers: H(tok), body: '{}' }));
  await sleep(2500);
  const orders = await J(await fetch(B + '/api/orders?range=all', { headers: H(tok) }));
  ok(Array.isArray(orders) && orders.filter(o => /^LG-/.test(o.order_number)).length === 4, 'seed: four synced orders');

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, ctxOpts, tag, openOrder] of [['desktop', { viewport: { width: 1280, height: 900 } }, 'desktop', 'LG-PDF'], ['Pixel 5', { ...devices['Pixel 5'] }, 'pixel5', 'LG-NOPDF3']]) {
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
    const dialogs = []; page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
    await login(page, 'demo', 'demo');
    await domClick(page, '.tab-btn[data-tab="orders"]');
    await page.waitForFunction(no => document.querySelector(`tr[data-order="${no}"]`), openOrder, { timeout: 15000 }); await sleep(400);
    // OPEN THE ORDER — the thing reported as taking 20–30 seconds.
    const t0 = Date.now();
    await page.evaluate(no => document.querySelector(`tr[data-order="${no}"] .btn-scan-now`).click(), openOrder);
    await page.waitForFunction(() => { const o = document.getElementById('scanOverlay'); return o && !o.classList.contains('hidden') && getComputedStyle(o).display !== 'none'; }, null, { timeout: 15000 });
    const openMs = Date.now() - t0;
    ok(openMs < 5000, `the scan overlay is open ${openMs}ms after the tap`);
    // The pill: briefly "Asking the channel…", then settles — no browser session behind it.
    await page.waitForFunction(() => !/Asking the channel/.test(document.getElementById('scanWaybillPill')?.innerText || ''), null, { timeout: 8000 }).catch(() => {});
    const settledMs = Date.now() - t0;
    const p1 = await pillText(page);
    ok(/no label yet/.test(p1) && settledMs < 9000, `the pill settled to "${p1}" ${settledMs}ms after the tap`);
    ok(dialogs.length === 0, 'opening the order raised no dialog');
    const btnHidden1 = await page.evaluate(() => document.getElementById('scanWaybillPdfBtn')?.classList.contains('hidden'));
    ok(btnHidden1 === true, 'no Label button yet');
    await page.screenshot({ path: path.join(SHOTS, `${tag}-open.png`) });
    if (openOrder === 'LG-PDF') {
      // The label lands in the background (the harness taps for it, exempt
      // from the cap) — and the SCREEN notices by itself.
      await sleep(9000);   // the route's own 8s per-order cooldown — the open just asked
      const tapped = await J(await fetch(B + `/api/orders/${openOrder}/waybill-now`, { method: 'POST', headers: H(tok), body: '{}' }));
      ok(/fetched and attached|fetching the label right now|busy with another/.test((tapped.steps || []).join(' ')), `harness tap: ${(tapped.steps || []).join(' | ').slice(0, 120)}`);
      const t1 = Date.now();
      await page.waitForFunction(() => /✓/.test(document.getElementById('scanWaybillPill')?.innerText || ''), null, { timeout: 60000 }).catch(() => {});
      const p2 = await pillText(page);
      const btnHidden2 = await page.evaluate(() => document.getElementById('scanWaybillPdfBtn')?.classList.contains('hidden'));
      const btnText = await page.evaluate(() => document.getElementById('scanWaybillPdfBtn')?.innerText.replace(/\s+/g, ' ').trim() || '');
      ok(/LZLG002/.test(p2) && /✓/.test(p2), `the pill repainted by itself to "${p2}" ${Math.round((Date.now() - t1) / 1000)}s later, with no reload and no tap`);
      ok(btnHidden2 === false && /Label/.test(btnText), `the Label button appeared by itself ("${btnText}")`);
      ok(dialogs.length === 0, 'still no dialog');
      await page.screenshot({ path: path.join(SHOTS, `${tag}-landed.png`) });
    } else {
      const sw = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      ok(sw, 'no sideways scroll on the phone');
    }
    await ctx.close();
  }
  await browser.close(); await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
