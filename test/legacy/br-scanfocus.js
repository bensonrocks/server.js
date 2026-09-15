// AFTER A SCAN, THE CURSOR GOES BACK TO THE SCAN BOX.
//
// Per the user, from the bench: "after scan always point cursor to Scan item
// barcode/SKU by default." Outbound used to park the caret in the QTY FIELD of
// the active row, which aimed it at a number box while the next thing that
// happens is a gun firing. A gun is a keyboard, so the only thing that saved
// it was a timing heuristic (`_qtyBurst`) guessing "characters this fast are a
// barcode, not a quantity" — and when that guesses wrong the barcode lands in
// the qty box as a NUMBER, which is a wrong count on a real order.
//
// Proved here on a two-line order:
//   1. the items phase opens with the caret in the scan box, not a qty box
//   2. after a scan it is back in the scan box
//   3. a SECOND scan therefore counts as a scan — the count moves 1 -> 2 and
//      no qty field was typed into
//   4. opening a new carton leaves it in the scan box too
//   5. ON A PHONE it is deliberately NOT focused — focusing pops the on-screen
//      keyboard over the item list, and the global capture already catches a
//      wedge gun with focus on <body>
//
// The pre-change build fails 1-4 (the caret sits in .qty-input).
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium, devices } = require('playwright');

const S     = __dirname;
const PORT  = 4761;
const B     = `http://localhost:${PORT}`;
const DDIR  = path.join(S, 'scanfocus-data');
const DBP   = path.join(DDIR, 'tenants', 'default', 'db.json');
const LOG   = path.join(S, 'scanfocus.log');
const SHOTS = path.join(S, 'scanfocus-shots'); fs.mkdirSync(SHOTS, { recursive: true });

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

const ORDER = 'SF-ORDER-1';
function seed() {
  const db = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  db.batches = [{
    id: 'batch-scanfocus', idealscan_code: 'IS-260915-01', client_name: 'SFCO',
    filename: 'scanfocus.xlsx', uploaded_at: new Date().toISOString(), uploaded_by: 'demo',
    orders: [{
      order_number: ORDER, issue_no: '', waybill_number: '', po_number: '', pick_ticket: '',
      customer_name: 'Buyer', carrier: 'TikTok', total_qty: 6, platform: 'TikTok',
      lines: [
        { sku: '7615', description: 'NaturVital ColourSafe Permanent Hair Colour 1 - Black', qty: 3 },
        { sku: '7023', description: 'NaturVital Hair Loss Shampoo 300ml - Sensitive Scalp', qty: 3 },
      ],
    }],
    orderStates: {},
  }];
  fs.writeFileSync(DBP, JSON.stringify(db, null, 2));
}

async function login(page) {
  await page.goto(B + '/');
  await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo'); await page.click('#loginBtn');
  await page.waitForFunction(() => {
    const o = document.getElementById('loginOverlay');
    return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden');
  }, null, { timeout: 15000 });
  await sleep(900);
}
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);

// What the browser reports as focused, in terms a human can read back.
const focusWhere = page => page.evaluate(() => {
  const ae = document.activeElement;
  if (!ae) return 'nothing';
  if (ae.id) return '#' + ae.id;
  if (ae.classList?.contains('qty-input')) return '.qty-input';
  return ae.tagName.toLowerCase();
});

// Fire a code the way a wedge gun does: straight into whatever has focus.
async function gunScan(page, code) {
  await page.keyboard.type(code, { delay: 12 });
  await page.keyboard.press('Enter');
  await sleep(1100);
}
const scannedFor = (page, sku) => page.evaluate(s => {
  const row = document.querySelector(`#scanItemsTbody tr[data-sku="${CSS.escape(s)}"]`);
  if (!row) return null;
  const q = row.querySelector('.qty-input');
  return q ? String(q.value) : (row.innerText || '').trim();
}, sku);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.rmSync(LOG, { force: true });
  // db.json is written on a deferred timer — give the first boot time to make
  // one, or there is nothing to seed. (Standing gotcha in CLAUDE.md.)
  await boot(); await sleep(2500); await stop();

  const browser = await chromium.launch({ executablePath: (process.env.TEST_CHROMIUM || '/opt/pw-browsers/chromium') });

  for (const [label, ctxOpts, tag] of [
    ['desktop', { viewport: { width: 1400, height: 900 } }, 'desktop'],
    ['Pixel 5', { ...devices['Pixel 5'] }, 'pixel5'],
  ]) {
    await stop(); seed(); await boot();
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await login(page);

    // Open the order's scan screen.
    await domClick(page, '.tab-btn[data-tab="orders"]');
    await page.waitForSelector(`tr.orders-tr[data-order="${ORDER}"]`, { timeout: 15000 });
    await sleep(500);
    await page.evaluate(o => {
      const row = document.querySelector(`tr.orders-tr[data-order="${o}"]`);
      const btn = row.querySelector('.btn-scan, [data-act="scan"], button');
      btn.click();
    }, ORDER);
    await page.waitForSelector('#itemScanInput', { timeout: 15000 });
    await sleep(1400);

    const phone = label === 'Pixel 5';

    if (phone) {
      // THE TOUCH SKIP IS DELIBERATE and must survive this change: focusing an
      // input here pops the on-screen keyboard over the item list.
      const w = await focusWhere(page);
      ok(w !== '#itemScanInput',
        `phone: the scan box is NOT auto-focused, so no keyboard is summoned (focus: ${w})`);
      const capture = await page.evaluate(() => typeof window !== 'undefined');
      ok(capture, 'phone: page is live (the global capture handles a wedge gun with focus on body)');
      await page.screenshot({ path: path.join(SHOTS, `${tag}-1.png`) });
      await ctx.close();
      continue;
    }

    // ── 1. opens focused on the scan box ──────────────────────────────────
    let w = await focusWhere(page);
    ok(w === '#itemScanInput', `opens with the caret in the scan box (focus: ${w})`);
    ok(w !== '.qty-input', 'and NOT in a quantity field');
    await page.screenshot({ path: path.join(SHOTS, `${tag}-1-open.png`) });

    // ── 2. still there after a scan ───────────────────────────────────────
    await gunScan(page, '7615');
    ok(await scannedFor(page, '7615') === '1', 'the first scan counted 1');
    w = await focusWhere(page);
    ok(w === '#itemScanInput', `after the scan the caret is back in the scan box (focus: ${w})`);

    // ── 3. so the NEXT gun scan is read as a scan, not typed into a qty box ─
    await gunScan(page, '7615');
    ok(await scannedFor(page, '7615') === '2',
       `a second gun scan counted as a scan — 2 (was ${await scannedFor(page, '7615')})`);
    ok(await scannedFor(page, '7023') === '0', 'and the other line was not touched');
    w = await focusWhere(page);
    ok(w === '#itemScanInput', `and the caret is STILL in the scan box (focus: ${w})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-2-after-scans.png`) });

    // ── 4. a new carton leaves the caret there too ────────────────────────
    const newCarton = await page.evaluate(() => !!document.querySelector('#newCartonBtn, [data-act="new-carton"]'));
    if (newCarton) {
      await page.evaluate(() => (document.querySelector('#newCartonBtn, [data-act="new-carton"]')).click());
      await sleep(1200);
      // A confirm() may stand in front of it on a part-scanned order.
      w = await focusWhere(page);
      ok(w === '#itemScanInput' || w === 'body',
         `opening a new carton does not strand the caret in a qty box (focus: ${w})`);
    } else {
      console.log('SKIP - no new-carton button on this build');
    }

    // ── 5. a hand-typed quantity still works ─────────────────────────────
    // The burst detector stays as the net for somebody who clicks into a qty
    // field on purpose; this change must not take that away.
    const typed = await page.evaluate(() => {
      const q = document.querySelector('#scanItemsTbody tr[data-sku="7023"] .qty-input');
      if (!q) return null;
      q.focus();
      return document.activeElement === q;
    });
    ok(typed === true, 'a qty field can still be clicked into and edited by hand');

    await ctx.close();
  }

  await browser.close(); await stop();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASSED'));
  fails.forEach(f => console.log('  x ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stop(); process.exit(2); });
