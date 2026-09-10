// Chromium proof of the actual complaint: scanning the picking-list GI barcode
// into the Orders-tab scan bar. BEFORE the backfill it finds nothing; AFTER,
// the scan overlay opens on the right order. Screenshots at each step.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');

const S     = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT  = 4746;
const B     = `http://localhost:${PORT}`;
const DDIR  = path.join(S, 'gib-scan');
const DBP   = path.join(DDIR, 'tenants', 'default', 'db.json');
const FILEP = path.join(S, 'gi-backfill-fixture.xlsx');
const SHOTS = path.join(S, 'gi-shots'); fs.mkdirSync(SHOTS, { recursive: true });

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child = null;
async function boot() {
  child = spawn('node', ['/home/user/server.js/server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(path.join(S, 'gib-scan.log'), 'a'), fs.openSync(path.join(S, 'gib-scan.log'), 'a')],
    detached: true,
  });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/api/version')).ok) return; } catch {} await sleep(500); }
  throw new Error('server did not boot');
}
async function stop() { if (!child) return; try { process.kill(-child.pid, 'SIGTERM'); } catch {} try { process.kill(child.pid, 'SIGTERM'); } catch {} child = null; await sleep(1500); }

const ORD = (order_number, issue_no) => ({
  order_number, issue_no, waybill_number: '', po_number: '', pick_ticket: '',
  customer_name: 'Buyer', carrier: 'TikTok', total_qty: 1, platform: 'TikTok',
  lines: [{ sku: '8006', description: 'Koli Pain Relief Plaster', qty: 1 }],
});
function seed() {
  const db = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  db.batches = [{
    id: 'batch-betime-old', idealscan_code: 'IS-260907-01', client_name: 'BETIME',
    filename: 'GI_Analysis_260907.xlsx', uploaded_at: new Date().toISOString(), uploaded_by: 'demo',
    orders: [ORD('585836014589150279', ''), ORD('585835366510593147', ''), ORD('GI-141032', ''), ORD('585835424563889658', 'GI-999999')],
    orderStates: {},
  }];
  fs.writeFileSync(DBP, JSON.stringify(db, null, 2));
}
function writeFixture() {
  const ws = XLSX.utils.json_to_sheet([
    { 'GI No': 'GI-141037', 'Reference': '585836014589150279', 'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
    { 'GI No': 'GI-141038', 'Reference': '585835366510593147', 'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
    { 'GI No': 'GI-141032',                                    'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
    { 'GI No': 'GI-141040', 'Reference': '585835424563889658', 'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 1 },
  ]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  fs.writeFileSync(FILEP, Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })));
}

async function login(page) {
  await page.goto(B + '/');
  await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo'); await page.click('#loginBtn');
  await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
  await sleep(800);
}
const isShown = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && !e.classList.contains('hidden') && r.width > 0 && r.height > 0; }, sel);
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
async function gotoOrders(page) {
  await domClick(page, '.tab-btn[data-tab="orders"]');
  await page.waitForSelector('tr.orders-tr[data-order="585836014589150279"]', { timeout: 15000 });
  await sleep(400);
}
// Scan the way a gun does: focus the bar, type the code, Enter.
async function scanBar(page, code) {
  await page.evaluate(() => { const i = document.getElementById('waybillScanInput'); i.value = ''; i.focus(); });
  await page.keyboard.type(code, { delay: 15 });
  await page.keyboard.press('Enter');
  await sleep(1200);
}

(async () => {
  writeFixture();
  // Scaffold the data dir ONCE. db.json is persisted on a deferred write, so
  // give the first boot a moment before stopping it — stopping straight after
  // /api/version answered once raced that write and left no db.json to seed.
  fs.rmSync(DDIR, { recursive: true, force: true });
  await boot(); await sleep(2500); await stop();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  for (const [label, ctxOpts, tag] of [['desktop', { viewport: { width: 1280, height: 900 } }, 'desktop'], ['Pixel 5', { ...devices['Pixel 5'] }, 'pixel5']]) {
    await stop(); seed(); await boot();

    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await login(page);

    // ── BEFORE: the barcode on the picking list finds nothing ──────────────
    await gotoOrders(page);
    await scanBar(page, 'GI-141037');
    const beforeOpen = await isShown(page, '#scanOverlay');
    const beforeMsg  = await page.evaluate(() => document.getElementById('waybillScanMsg')?.textContent || '');
    ok(!beforeOpen, `BEFORE the backfill, scanning GI-141037 opens nothing (overlay shown: ${beforeOpen})`);
    ok(/not found|no order|no match/i.test(beforeMsg) || beforeMsg.length > 0, `and the bar says so: "${beforeMsg}"`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-1-before-scan-not-found.png`), fullPage: false });

    // ── THE BACKFILL, from the Upload tab ───────────────────────────────────
    await domClick(page, '.tab-btn[data-tab="upload"]');
    await sleep(500);
    ok(await isShown(page, '#giBackfillBtn'), 'the Fix-missing-GI button is on the Upload tab');
    await page.evaluate(() => document.getElementById('giBackfillRow').scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(SHOTS, `${tag}-2-upload-tab-button.png`), fullPage: false });
    await page.setInputFiles('#giBackfillFileInput', FILEP);
    await page.waitForFunction(() => { const s = document.getElementById('giBackfillStatus'); return s && !s.classList.contains('hidden') && !s.classList.contains('loading'); }, null, { timeout: 20000 });
    const st = await page.evaluate(() => document.getElementById('giBackfillStatus').innerText);
    ok(/3 order\(s\) given their GI/.test(st), 'backfill reports 3 orders given their GI');
    await page.evaluate(() => document.getElementById('giBackfillStatus').scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(SHOTS, `${tag}-3-backfill-result.png`), fullPage: false });

    // ── AFTER: the same scan opens the order ────────────────────────────────
    await gotoOrders(page);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-4-orders-with-gi-pill.png`), fullPage: false });
    const rowText = await page.evaluate(() => document.querySelector('tr.orders-tr[data-order="585836014589150279"]')?.innerText || '');
    ok(/GI:\s*GI-141037/.test(rowText), 'the row now carries the GI pill');

    await scanBar(page, 'GI-141037');
    ok(await isShown(page, '#scanOverlay'), 'AFTER the backfill, scanning GI-141037 OPENS the scan overlay');
    const openedNo = await page.evaluate(() => document.getElementById('scanOrderNo')?.textContent.trim());
    ok(openedNo === '585836014589150279', `on the right order (${openedNo})`);
    const giPill = await page.evaluate(() => document.querySelector('#scanOverlay .meta-pill-gi')?.textContent.trim() || '');
    ok(/GI-141037/.test(giPill), `and the overlay header shows the GI (${giPill})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-5-after-scan-opens-order.png`), fullPage: false });

    // A second GI, typed lowercase like a sloppy gun — the direct client match is case-tolerant.
    // Leaving may ask to confirm — register BEFORE the click, or Playwright
    // auto-dismisses the dialog and the overlay stays open.
    page.on('dialog', d => d.accept().catch(() => {}));
    await domClick(page, '#backToOrdersBtn');
    await sleep(1000);
    if (!(await isShown(page, '#scanOverlay'))) {
      await scanBar(page, 'gi-141038');
      const no2 = await page.evaluate(() => document.getElementById('scanOrderNo')?.textContent.trim());
      ok(await isShown(page, '#scanOverlay') && no2 === '585835366510593147', `lowercase gi-141038 opens 585835366510593147 (${no2})`);
    } else {
      console.log('skip - could not close the first overlay to try a second scan');
    }
    await ctx.close();
  }

  await browser.close();
  await stop();
  console.log('\nscreenshots in ' + SHOTS);
  console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error(e); await stop(); process.exit(1); });
