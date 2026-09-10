// Browser check for the "Fix missing GI numbers" control on the Upload tab.
// Same seed as gi-backfill-e2e.js. Desktop + Pixel 5. Admin sees and uses it;
// the Orders list then shows the GI pill on the healed row and NO pill on the
// row whose GI merely echoes its order number; warehouse never sees the row.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');

const S     = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT  = 4745;
const B     = `http://localhost:${PORT}`;
const DDIR  = path.join(S, 'gib-br');
const DBP   = path.join(DDIR, 'tenants', 'default', 'db.json');
const MASTER = process.env.MASTER_KEY || '201432547E';
const FILEP = path.join(S, 'gi-backfill-fixture.xlsx');

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child = null;
async function boot() {
  child = spawn('node', ['/home/user/server.js/server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(path.join(S, 'gib-br.log'), 'a'), fs.openSync(path.join(S, 'gib-br.log'), 'a')],
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

async function login(page, id, pw) {
  await page.goto(B + '/');
  await page.fill('#loginName', id);
  await page.fill('#loginIC', pw);
  await page.click('#loginBtn');
  await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
  await sleep(800);
}
const visible = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; }, sel);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  await boot(); await stop(); seed(); writeFixture(); await boot();
  const mk = await fetch(B + '/api/master/users', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-master-key': MASTER },
    body: JSON.stringify({ id: 'whguy', name: 'WH Guy', password: 'whguy123', role: 'warehouse' }) });
  ok(mk.ok, `warehouse user created (${mk.status})`);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  for (const [label, ctxOpts] of [['desktop', { viewport: { width: 1280, height: 900 } }], ['Pixel 5', { ...devices['Pixel 5'] }]]) {
    console.log(`\n=== ${label} — admin ===`);
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await login(page, 'demo', 'demo');
    ok(await visible(page, '#giBackfillRow'), 'the "Fix missing GI numbers" row is visible on the Upload tab');
    ok(await visible(page, '#giBackfillBtn'), 'and its button is rendered');
    const fits = await page.evaluate(() => { const r = document.getElementById('giBackfillBtn').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
    ok(fits, 'the button is fully on screen');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll');

    await page.setInputFiles('#giBackfillFileInput', FILEP);
    await page.waitForFunction(() => { const s = document.getElementById('giBackfillStatus'); return s && !s.classList.contains('hidden') && !s.classList.contains('loading'); }, null, { timeout: 20000 });
    const st = await page.evaluate(() => ({ cls: document.getElementById('giBackfillStatus').className, text: document.getElementById('giBackfillStatus').innerText }));
    ok(/success/.test(st.cls), `status is green (${st.cls})`);
    ok(/3 order\(s\) given their GI/.test(st.text), 'says 3 orders were given their GI');
    ok(/GI-141037/.test(st.text) && /GI-141038/.test(st.text), 'names the GIs it filled');
    ok(/Left alone/.test(st.text) && /GI-999999/.test(st.text) && /GI-141040/.test(st.text), 'the conflict is shown with both values');
    ok(/1 conflict\(s\) left alone/.test(st.text), 'and counted');
    ok(!(await page.evaluate(() => document.getElementById('giBackfillBtn').disabled)), 'the button is re-enabled afterwards');

    // The Orders list shows the pill on the healed row, and NOT on the echo row.
    // On a phone the sidebar tabs sit behind the hamburger drawer, so a
    // viewport click cannot reach them — a DOM click is what the drawer's own
    // handler ends up doing anyway.
    await page.evaluate(() => document.querySelector('.tab-btn[data-tab="orders"]').click());
    await page.waitForSelector('tr.orders-tr[data-order="585836014589150279"]', { timeout: 15000 });
    await sleep(500);
    const pill = await page.evaluate(() => document.querySelector('tr.orders-tr[data-order="585836014589150279"]')?.innerText || '');
    ok(/GI:\s*GI-141037/.test(pill), 'the healed row carries a "GI: GI-141037" pill');
    const echoRow = await page.evaluate(() => document.querySelector('tr.orders-tr[data-order="GI-141032"]')?.innerText || '');
    ok(echoRow.includes('GI-141032') && !/GI:\s*GI-141032/.test(echoRow), 'the GI-only row shows its number ONCE — no echoing pill');
    const confl = await page.evaluate(() => document.querySelector('tr.orders-tr[data-order="585835424563889658"]')?.innerText || '');
    ok(/GI:\s*GI-999999/.test(confl) && !/GI-141040/.test(confl), 'the conflict row still shows its STORED GI, not the file\'s');
    await ctx.close();

    console.log(`=== ${label} — warehouse ===`);
    const ctx2 = await browser.newContext(ctxOpts);
    const page2 = await ctx2.newPage();
    await login(page2, 'whguy', 'whguy123');
    ok(!(await visible(page2, '#giBackfillRow')), 'warehouse does NOT see the row');
    await ctx2.close();

    // Reset for the second viewport: restore the blank GIs directly (server holds the db, so via a second seed cycle).
    if (label === 'desktop') { await stop(); seed(); await boot(); }
  }

  await browser.close();
  await stop();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error(e); await stop(); process.exit(1); });
