// THE CLIENT TYPES THE ORDER NUMBER AND FINDS IT — the reported complaint,
// driven through the real portal in Chromium, desktop and a Pixel 5.
//
// Also asserts the thing the user asked for explicitly: the everyday view is
// NOT affected. The tiles, the day table and the list are byte-identical
// before the search and after clearing it, and no request is made while a
// term still matches something already on the page.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium, devices } = require('playwright');

const S      = __dirname;
const PORT   = 4768;
const B      = `http://localhost:${PORT}`;
const DDIR   = path.join(S, 'psearch-br-data');
const DBP    = path.join(DDIR, 'tenants', 'default', 'db.json');
const LOG    = path.join(S, 'psearch-br.log');
const SHOTS  = path.join(S, 'psearch-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const MASTER = process.env.MASTER_KEY || '201432547E';

const CLIENT = 'SEARCHCO';
const TOTAL  = 340;
const OLDEST = '172636325960072';
const OLD_WB = 'LZSGD1015417137';

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child = null;
async function boot() {
  child = spawn('node', [path.join(__dirname, '../../server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')],
    detached: true,
  });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/api/version')).ok) return; } catch {} await sleep(500); }
  throw new Error('server did not boot');
}
async function stop() {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  child = null; await sleep(1500);
}
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };

function seed() {
  const db = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  const orders = [], states = {};
  for (let i = 0; i < TOTAL; i++) {
    const oldest = i === TOTAL - 1;
    const n = oldest ? OLDEST : `ORD-${String(1000 + i)}`;
    orders.push({
      order_number: n, waybill_number: oldest ? OLD_WB : `WB${String(900000 + i)}`,
      customer_name: 'Tan Wei Qing', carrier: 'Lazada', platform: 'Lazada',
      date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), total_qty: 1,
      lines: [{ sku: 'AYMMGAF539DXXXXXXDGMY', description: 'Mayer 5.5L Air Fryer', qty: 1 }],
    });
    states[n] = { status: 'done', endTime: new Date(Date.now() - i * 86400000).toISOString(),
                  scanned: { AYMMGAF539DXXXXXXDGMY: 1 } };
  }
  db.batches = [{
    id: 'batch-psearch-br', idealscan_code: 'IS-260909-18', client_name: CLIENT,
    filename: 'orders.xlsx', uploaded_at: new Date().toISOString(), uploaded_by: 'demo',
    orders, orderStates: states,
  }];
  fs.writeFileSync(DBP, JSON.stringify(db, null, 2));
}
const MH = { 'Content-Type': 'application/json', 'x-master-key': MASTER };
async function makeLogin(id) {
  await fetch(`${B}/api/master/client-profiles/${encodeURIComponent(CLIENT)}/portal-users`,
    { method: 'POST', headers: MH, body: JSON.stringify({ id, name: id, password: 'pw123456', access: 'full' }) });
}

async function signIn(page, user) {
  await page.goto(B + '/portal');
  await page.fill('#liClient', CLIENT);
  await page.fill('#liUser', user);
  await page.fill('#liPass', 'pw123456');
  await page.click('#liBtn');
  await page.waitForFunction(() => {
    const v = document.getElementById('loginView');
    return !v || getComputedStyle(v).display === 'none' || v.classList.contains('hidden');
  }, null, { timeout: 20000 });
  await sleep(1200);
}
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
const txt  = (page, sel) => page.evaluate(s => (document.querySelector(s)?.innerText || ''), sel);
const cards = page => page.evaluate(() => document.querySelectorAll('#orList .card.exp').length);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.rmSync(LOG, { force: true });
  await boot(); await sleep(2500); await stop();
  seed(); await boot();
  // ONE DEVICE AT A TIME per portal login (standing gotcha) — a login each.
  await makeLogin('deskuser'); await makeLogin('phoneuser');

  const browser = await chromium.launch({ executablePath: (process.env.TEST_CHROMIUM || '/opt/pw-browsers/chromium') });

  for (const [label, ctxOpts, user, tag] of [
    ['desktop', { viewport: { width: 1280, height: 900 } }, 'deskuser', 'desktop'],
    ['Pixel 5', { ...devices['Pixel 5'] }, 'phoneuser', 'pixel5'],
  ]) {
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    // Count the order requests so "the everyday view is unaffected" is
    // measured, not assumed.
    let listCalls = 0, searchCalls = 0;
    page.on('request', r => {
      const u = r.url();
      if (!u.includes('/api/portal/orders')) return;
      if (u.includes('?q=')) searchCalls++; else listCalls++;
    });

    await signIn(page, user);
    await domClick(page, '[data-tab="orders"]');
    await sleep(1500);

    // ── 1. THE EVERYDAY VIEW ────────────────────────────────────────────
    const summaryBefore = await txt(page, '#orSummary');
    const nBefore = await cards(page);
    ok(nBefore > 0, `the orders list renders (${nBefore} cards)`);
    ok(/most recent order/i.test(summaryBefore),
       'the summary says what is actually shown, not a 90-day window it does not apply');
    ok(!/last 90 days/i.test(summaryBefore), 'the old misleading line is gone');
    const searchesAfterLoad = searchCalls;
    ok(searchesAfterLoad === 0, 'loading the tab makes NO search request');
    await page.screenshot({ path: path.join(SHOTS, `${tag}-1-list.png`) });

    // ── 2. A TERM THAT MATCHES ON THE PAGE STAYS LOCAL ──────────────────
    const onPage = await page.evaluate(() =>
      document.querySelector('#orList .card.exp')?.getAttribute('data-order') || '');
    await page.fill('#orSearch', onPage);
    await sleep(900);
    ok(searchCalls === searchesAfterLoad,
       'a term that matches on the page makes NO server request — the everyday path is untouched');
    ok(await cards(page) === 1, 'and filters locally to that one order');

    // ── 3. THE REPORTED ORDER — past the page ───────────────────────────
    await page.fill('#orSearch', OLDEST);
    await page.waitForFunction(o => (document.getElementById('orList')?.innerText || '').includes(o),
      OLDEST, { timeout: 20000 });
    ok(searchCalls > searchesAfterLoad, 'it asked the server only once the page had nothing');
    const list = await txt(page, '#orList');
    ok(list.includes(OLDEST), `the reported order ${OLDEST} is FOUND`);
    ok(/full order history/i.test(list), 'and the result says where it came from');
    ok(list.includes(OLD_WB), 'the card carries its waybill');
    ok(await cards(page) === 1, 'exactly one card');
    await page.screenshot({ path: path.join(SHOTS, `${tag}-2-found.png`) });

    // ── 4. THE TILES AND DAY TABLE DID NOT MOVE ─────────────────────────
    ok(await txt(page, '#orSummary') === summaryBefore,
       'the tiles and day table are UNCHANGED by the search — they describe the page, not the result');

    // ── 5. CLEARING RESTORES EXACTLY WHAT WAS THERE ─────────────────────
    await page.fill('#orSearch', '');
    await sleep(700);
    ok(await cards(page) === nBefore, `clearing the search restores the list (${nBefore})`);
    ok(await txt(page, '#orSummary') === summaryBefore, 'and the summary is identical');

    // ── 6. AN UNKNOWN TERM SAYS SO, AND DOES NOT HANG ───────────────────
    await page.fill('#orSearch', 'ZZZNOSUCHORDER');
    await page.waitForFunction(() => /Nothing matches/i.test(document.getElementById('orList')?.innerText || ''),
      null, { timeout: 20000 });
    ok(/history/i.test(await txt(page, '#orList')),
       'an unknown term says the whole history was searched, not just the page');

    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
       'no sideways scroll');
    await ctx.close();
  }

  await browser.close(); await stop();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASSED'));
  fails.forEach(f => console.log('  x ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stop(); process.exit(2); });
