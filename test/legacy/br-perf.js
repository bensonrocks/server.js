// The Health Check's new "Server thread" block renders on desktop and a Pixel 5,
// and the gzipped app still boots and logs in.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const S = __dirname, PORT = 4805, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'perf-br-data');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up'); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } await sleep(1500); }
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'perf-br-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, ctxOpts, tag] of [['Pixel 5', { ...devices['Pixel 5'] }, 'pixel5'], ['desktop', { viewport: { width: 1280, height: 900 } }, 'desktop']]) {
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
    const enc = [];
    page.on('response', r => { if (/\/app\.js$/.test(r.url())) enc.push(r.headers()['content-encoding'] || 'none'); });
    await page.goto(B + '/'); await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo'); await page.click('#loginBtn');
    await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
    await sleep(800);
    ok(enc[0] === 'gzip' || enc[0] === 'br', `the browser received app.js compressed (${enc[0]}) and the app signed in`);
    await domClick(page, '.tab-btn[data-tab="connections"]');
    await page.waitForFunction(() => !document.getElementById('logPasswordOverlay').classList.contains('hidden'), null, { timeout: 10000 });
    await page.fill('#logPasswordInput', '201432547E'); await domClick(page, '#logPasswordSubmitBtn');
    await sleep(800);
    await page.evaluate(() => { const d = document.getElementById('connHealthPanel')?.closest('details'); if (d) d.open = true; });
    await domClick(page, '#connHealthBtn');
    await page.waitForFunction(() => /Server thread/.test(document.getElementById('connHealthOut')?.innerText || ''), null, { timeout: 15000 });
    const txt = await page.evaluate(() => document.getElementById('connHealthOut').innerText);
    ok(/db\.json write: .*held the thread \d+ ms/.test(txt), 'the db.json write cost is on screen in words');
    ok(/PDF work: on a worker thread \(render yes\)/.test(txt), 'PDF work reads as on the worker thread');
    ok(/Responses gzipped/.test(txt), 'gzip is reported');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
    await page.screenshot({ path: path.join(S, `perf-${tag}-health.png`) });
    await ctx.close();
  }
  await browser.close(); await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
