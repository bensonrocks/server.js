// Browser pass on Connections → 🛒 OneCart (Direct), desktop + Pixel 5.
// Through the real Administrator gate; the buttons drive the real routes
// against the mock (ONECART_BASE points the server at it).
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');

const S      = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT   = 4749, MPORT = 4750;
const B      = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
const DDIR   = path.join(S, 'oc-br-data');
const PDFDIR = path.join(S, 'oc-pdfs');
const MASTER = process.env.MASTER_KEY || '201432547E';
const KEY    = 'oc_test_key_123';
const SHOTS  = path.join(S, 'oc-shots'); fs.mkdirSync(SHOTS, { recursive: true });

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids.length = 0; await sleep(1200); }
const MH = { 'Content-Type': 'application/json', 'x-master-key': MASTER };

async function login(page, id, pw) {
  await page.goto(B + '/');
  await page.fill('#loginName', id); await page.fill('#loginIC', pw); await page.click('#loginBtn');
  await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
  await sleep(700);
}
const shown = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && !e.classList.contains('hidden') && r.width > 0 && r.height > 0; }, sel);
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
async function openConnections(page) {
  await domClick(page, '.tab-btn[data-tab="connections"]');
  // Either the Administrator gate appears (first time this session) or the
  // tab opens straight away (already unlocked). Handle both.
  try {
    await page.waitForFunction(() => {
      const o = document.getElementById('logPasswordOverlay');
      const gate = o && !o.classList.contains('hidden');
      const t = document.getElementById('tab-connections');
      const open = t && getComputedStyle(t).display !== 'none';
      return gate || open;
    }, null, { timeout: 10000 });
  } catch (e) {
    const diag = await page.evaluate(() => ({
      btn: !!document.querySelector('.tab-btn[data-tab="connections"]'),
      btnDisplay: document.querySelector('.tab-btn[data-tab="connections"]') ? getComputedStyle(document.querySelector('.tab-btn[data-tab="connections"]')).display : null,
      overlayCls: document.getElementById('logPasswordOverlay')?.className,
      tabDisplay: document.getElementById('tab-connections') ? getComputedStyle(document.getElementById('tab-connections')).display : null,
      user: localStorage.getItem('wms_user'),
      activeTab: document.querySelector('.tab-btn.active')?.dataset.tab,
    }));
    await page.screenshot({ path: path.join(SHOTS, 'gate-fail.png') });
    throw new Error('Connections did not open: ' + JSON.stringify(diag));
  }
  const gated = await page.evaluate(() => !document.getElementById('logPasswordOverlay').classList.contains('hidden'));
  if (gated) {
    await page.fill('#logPasswordInput', MASTER);
    await domClick(page, '#logPasswordSubmitBtn');
    // NOT waitForSelector — that waits for VISIBLE, and a hidden overlay never is.
    await page.waitForFunction(() => document.getElementById('logPasswordOverlay').classList.contains('hidden'), null, { timeout: 8000 });
  }
  await page.waitForFunction(() => { const t = document.getElementById('tab-connections'); return t && getComputedStyle(t).display !== 'none'; }, null, { timeout: 10000 });
  await sleep(800);
  await page.evaluate(() => { const d = document.getElementById('secOnecart'); if (d) d.open = true; });
  await sleep(400);
}
const status = page => page.evaluate(() => { const s = document.getElementById('onecartStoreStatus'); return s ? { cls: s.className, text: s.innerText } : null; });
async function waitStatus(page, re, ms = 20000) {
  await page.waitForFunction((src) => { const s = document.getElementById('onecartStoreStatus'); return s && !s.classList.contains('hidden') && !s.classList.contains('progress') && new RegExp(src, 'i').test(s.innerText); }, re.source, { timeout: ms });
  return status(page);
}

(async () => {
  for (const [label, ctxOpts, tag] of [['desktop', { viewport: { width: 1280, height: 900 } }, 'desktop'], ['Pixel 5', { ...devices['Pixel 5'] }, 'pixel5']]) {
    fs.rmSync(DDIR, { recursive: true, force: true });
    spawnLogged([path.join(S, 'onecart-mock.js')], { PORT: String(MPORT), OC_KEY: KEY, OC_PDF_DIR: PDFDIR }, path.join(S, 'oc-br-mock.log'));
    await waitUp(M + '/__ctl/calls');
    spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR, ONECART_BASE: M + '/api/v2' }, path.join(S, 'oc-br-server.log'));
    await waitUp(B + '/api/version'); await sleep(2500);
    await fetch(B + '/api/master/users', { method: 'POST', headers: MH, body: JSON.stringify({ id: 'whguy', name: 'WH', password: 'whguy123', role: 'warehouse' }) });

    console.log(`\n=== ${label} ===`);
    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await login(page, 'demo', 'demo');
    await openConnections(page);
    ok(await shown(page, '#secOnecart'), 'the OneCart (Direct) section is on the Connections tab');
    ok(await shown(page, '#onecartAddStoreBtn'), 'with its Connect button');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll');

    // Connect
    await domClick(page, '#onecartAddStoreBtn');
    ok(await shown(page, '#onecartStoreForm'), 'the connect form opens');
    await page.fill('#ocClient', 'Betime Online');
    await page.fill('#ocKey', KEY);
    await page.selectOption('#ocCompleteAction', 'ship');
    // The auto-label choice ASKS, and backing out puts it back to request-only.
    page.once('dialog', d => d.dismiss());
    await page.selectOption('#ocLabelSync', 'intake');
    await domClick(page, '#onecartSaveStoreBtn');
    await sleep(500);
    ok(await page.evaluate(() => document.getElementById('ocLabelSync').value) === 'off', 'declining the auto-label confirm reverts the choice to request-only');
    ok(await shown(page, '#onecartStoreForm'), 'and nothing was saved yet — the form is still open');
    await domClick(page, '#onecartSaveStoreBtn');
    await waitStatus(page, /Saved/);
    await page.waitForFunction(() => /Betime Online/.test(document.getElementById('onecartStoresTbody').innerText), null, { timeout: 8000 });
    const row = await page.evaluate(() => document.getElementById('onecartStoresTbody').innerText);
    ok(/Betime Online/.test(row) && /••••_123/.test(row) && !/oc_test_key_123/.test(row), 'the row names the client and shows only the key tail');
    ok(/Mark shipped/.test(row) && /on request/.test(row), `and the chosen completion action and label mode (${row.replace(/\s+/g, ' ').slice(0, 120)})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-1-connected.png`) });

    // Test
    await domClick(page, '[data-oc-test]');
    let st = await waitStatus(page, /Betime Online Pte Ltd/);
    ok(/success/.test(st.cls) && /IdealOne/.test(st.text), `Test names the company and the key (${st.text.slice(0, 90)})`);

    // Pull
    await domClick(page, '[data-oc-pull]');
    st = await waitStatus(page, /imported/);
    ok(/success/.test(st.cls) && /4 order\(s\) waiting/.test(st.text) && /3 imported/.test(st.text), `Pull reports the queue and the import (${st.text.slice(0, 120)})`);
    ok(/no product lines: NOLINES-1/.test(st.text), 'and names the order it skipped for having no lines');
    await page.screenshot({ path: path.join(SHOTS, `${tag}-2-pulled.png`) });
    const row2 = await page.evaluate(() => document.getElementById('onecartStoresTbody').innerText);
    ok(/3 in, 0 held/.test(row2), `the row's last-pull summary updated (${row2.replace(/\s+/g, ' ').slice(0, 140)})`);

    // Get Labels
    await domClick(page, '[data-oc-labels]');
    st = await waitStatus(page, /label\(s\) attached/, 30000);
    ok(/success/.test(st.cls) && /3 of 3 label\(s\) attached/.test(st.text), `Get Labels attached all three (${st.text.slice(0, 100)})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-3-labels.png`) });
    const row3 = await page.evaluate(() => document.getElementById('onecartStoresTbody').innerText);
    ok(/3\/3/.test(row3), 'the row shows the label tally');

    // The Orders tab shows the synced orders under the client
    await domClick(page, '.tab-btn[data-tab="orders"]');
    await page.waitForSelector('tr.orders-tr[data-order="585836014589150279"]', { timeout: 15000 });
    const r1 = await page.evaluate(() => document.querySelector('tr.orders-tr[data-order="585836014589150279"]').innerText);
    // The client cell is text-transform: uppercase and innerText returns the
    // RENDERED text (the documented .lri-lbl gotcha); the row shows the
    // carrier, not the platform word.
    ok(/betime online/i.test(r1) && /Label/.test(r1) && /3 items/.test(r1), `the TikTok order is on the Orders tab under Betime Online with its label and 3 lines (${r1.replace(/\s+/g, ' ').slice(0, 90)})`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Orders tab: no sideways scroll');
    await page.screenshot({ path: path.join(SHOTS, `${tag}-4-orders.png`) });

    // Edit → turn auto-label on for real, accepting the confirm
    await openConnections(page);
    await domClick(page, '[data-oc-edit]');
    ok(await page.evaluate(() => document.getElementById('ocClient').value) === 'Betime Online' && await page.evaluate(() => document.getElementById('ocKey').value) === '', 'Edit pre-fills the client and leaves the key blank (blank keeps it)');
    page.once('dialog', d => d.accept());
    await page.selectOption('#ocLabelSync', 'intake');
    await domClick(page, '#onecartSaveStoreBtn');
    await waitStatus(page, /Saved/);
    await page.waitForFunction(() => /auto at intake/.test(document.getElementById('onecartStoresTbody').innerText), null, { timeout: 8000 });
    ok(true, 'accepting the confirm saves auto-label at intake, and the key survived a blank field');
    await ctx.close();

    // Warehouse never sees Connections at all.
    const ctx2 = await browser.newContext(ctxOpts);
    const page2 = await ctx2.newPage();
    await login(page2, 'whguy', 'whguy123');
    ok(!(await shown(page2, '.tab-btn[data-tab="connections"]')), 'warehouse has no Connections tab');
    await ctx2.close();
    await browser.close();
    await stopAll();
  }
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error(e); await stopAll(); process.exit(1); });
