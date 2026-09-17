// THE ALARM HAS TO BE ON A SCREEN SOMEBODY OPENS, or it is decorative — and a
// signal nobody sees is the exact failure this feature exists to prevent. The
// server count is asserted in tracx-automatch-e2e; this proves the row really
// renders in Administrator → System Outages, in amber, naming the file, and
// that the nav badge carries it so an admin knows to look without a banner
// (the standing no-top-banner rule).
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const { chromium, devices } = require('playwright');
const S = __dirname, PORT = 4807, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'lblunread-br-data');
const DBP = path.join(DDIR, 'tenants', 'default', 'db.json');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function boot() {
  const c = spawn('node', [path.join(__dirname, '../../server.js')],
    { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
      stdio: ['ignore', fs.openSync(path.join(S, 'lblunread-br.log'), 'a'), fs.openSync(path.join(S, 'lblunread-br.log'), 'a')],
      detached: true });
  kids.push(c); return c;
}
async function waitUp() { for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/version')).status < 500) return; } catch {} await sleep(500); } throw new Error('not up'); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } await sleep(1800); }
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  fs.rmSync(path.join(S, 'lblunread-br.log'), { force: true });
  boot(); await waitUp(); await sleep(2500); await stopAll();

  // One page read by everything we have and still carrying no identifier —
  // the state that means the extractor has a gap.
  const db = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  db.labelImports = [{
    id: 'imp-unreadable', filename: 'NewCarrier_labels.pdf', pageCount: 2,
    uploadedAt: new Date().toISOString(), uploadedBy: 'demo',
    pages: [
      { pageIndex: 0, matchStatus: 'unmatched', rawText: 'NEWCARRIER\nDeliver To: X',
        extracted: {}, ocrForFieldsStrategy: 'full-page-render-v1' },
      { pageIndex: 1, matchStatus: 'matched', matchedOrderNumber: 'ORD-1',
        rawText: 'x', extracted: { trackingNumber: 'AB123456789' } },
    ],
  }];
  fs.writeFileSync(DBP, JSON.stringify(db, null, 2));
  kids.length = 0; boot(); await waitUp(); await sleep(1200);

  const browser = await chromium.launch({ executablePath: (process.env.TEST_CHROMIUM || '/opt/pw-browsers/chromium') });
  for (const [label, ctxOpts, tag] of [
    ['Pixel 5', { ...devices['Pixel 5'] }, 'pixel5'],
    ['desktop', { viewport: { width: 1280, height: 900 } }, 'desktop'],
  ]) {
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
    await page.goto(B + '/');
    await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo'); await page.click('#loginBtn');
    await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });

    // The health poll's first pass is 4s after load — wait for it rather than
    // racing it, since the badge is what an admin notices first.
    await page.waitForFunction(() => {
      const b = document.getElementById('outagesBadge');
      return b && !b.classList.contains('hidden') && Number(b.textContent) > 0;
    }, null, { timeout: 20000 });
    ok(true, 'the System Outages nav badge counts it — noticed with no banner');

    await domClick(page, '#logAccessBtn');
    await page.waitForFunction(() => !document.getElementById('logPasswordOverlay').classList.contains('hidden'), null, { timeout: 10000 });
    await page.fill('#logPasswordInput', '201432547E'); await domClick(page, '#logPasswordSubmitBtn');
    await sleep(600);
    await domClick(page, '.admin-nav-btn[data-admin-tab="outages"]');
    await page.waitForFunction(() => /carry no identifier/.test(document.getElementById('sysHealthBlock')?.innerText || ''), null, { timeout: 15000 });

    const row = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#sysHealthBlock .user-row')]
        .find(d => /carry no identifier/.test(d.innerText));
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { text: el.innerText, border: cs.borderLeftColor, bg: cs.backgroundColor };
    });
    ok(!!row, 'the row is in System Outages');
    ok(/1 label page\(s\) carry no identifier we can read/.test(row.text), `it states the count (${(row.text || '').split('\n')[0]})`);
    ok(/NewCarrier_labels\.pdf/.test(row.text), 'it NAMES the file, so the label can be found');
    ok(/text layer and OCR/.test(row.text), 'it says both readers were tried — not "press Auto Match again"');
    // Amber, not red, by COMPUTED STYLE: a label shape we cannot read is work
    // for a human plus a gap to close, not an outage.
    ok(row.border === 'rgb(217, 119, 6)', `amber by computed style, not red (${row.border})`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
    await page.screenshot({ path: path.join(S, `lblunread-${tag}.png`), fullPage: false });
    await ctx.close();
  }
  await browser.close();
  await stopAll();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASSED'));
  fails.forEach(f => console.log('  x ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
