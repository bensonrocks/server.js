// BROWSER — the per-day total row on both Station Throughput tables, and the
// new Station Throughput report button.
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/shots';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

async function login(page) {
  await page.goto('http://localhost:4735/');
  await page.waitForSelector('#loginName', { timeout: 20000 });
  await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo');
  await page.click('#loginBtn'); await page.waitForTimeout(2200);
}
const grid = (page, sel) => page.$$eval(sel + ' tr', rows => rows.map(r => ({
  cells: [...r.children].map(c => c.textContent.trim()),
  tot: r.classList.contains('stp-tot'),
})));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  for (const [label, opts] of [['Pixel 5', { ...devices['Pixel 5'] }], ['desktop', { viewport: { width: 1440, height: 900 } }]]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await login(page);
    await page.$eval('#stationThroughputBtn', el => el.click());
    await page.waitForTimeout(1600);

    for (const [which, id] of [['Orders', '#stpOrdersBody'], ['Lines', '#stpLinesBody']]) {
      const rows = await grid(page, id);
      const tots = rows.filter(r => r.tot);
      ok(tots.length === 1, `${label} · ${which}: exactly one total row (${tots.length})`);
      ok(tots[0] && /all stations/i.test(tots[0].cells[0]),
         `${label} · ${which}: it says what it is — "${tots[0] && tots[0].cells[0]}"`);
      // Its per-day figures must equal the columns above it, computed here
      // from the rendered cells rather than trusted.
      const body = rows.filter(r => !r.tot);
      const nCols = tots[0].cells.length;
      let allMatch = true, detail = [];
      for (let c = 1; c < nCols; c++) {
        const want = body.reduce((n, r) => n + (Number(r.cells[c]) || 0), 0);
        const got = Number(tots[0].cells[c]) || 0;
        detail.push(`${got}/${want}`);
        if (want !== got) allMatch = false;
      }
      ok(allMatch, `${label} · ${which}: every total equals its own column (${detail.join(' ')})`);
    }

    // The ORDERS total row must agree with the tiles above it — same numbers,
    // two places on one screen.
    const tileVals = await page.$$eval('#stpTotalsGrid .dstat .dstat-val', els => els.map(e => Number(e.textContent.trim()) || 0));
    const ordTot = (await grid(page, '#stpOrdersBody')).find(r => r.tot);
    const rowVals = ordTot ? ordTot.cells.slice(1, 1 + tileVals.length).map(Number) : [];
    ok(JSON.stringify(tileVals) === JSON.stringify(rowVals),
       `${label}: the tiles and the Orders total row say the same thing (${JSON.stringify(tileVals)} vs ${JSON.stringify(rowVals)})`);

    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `${label}: no sideways scroll (${over}px)`);
    await page.screenshot({ path: `${S}/strep-${label.replace(/\s/g, '')}.png` });
    await ctx.close();
  }

  // ── THE REPORT BUTTON ────────────────────────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await login(page);
    await page.$eval('#logAccessBtn', el => el.click()); await page.waitForTimeout(600);
    await page.fill('#logPasswordInput', '201432547E');
    await page.$eval('#logPasswordSubmitBtn', el => el.click()); await page.waitForTimeout(1400);
    await page.$eval('[data-admin-tab="reports"]', el => el.click()); await page.waitForTimeout(900);

    const btn = await page.$('#adminTab-reports button[data-report="station-throughput"]');
    ok(!!btn, 'the Station Throughput report button is on the Reports pane');
    const txt = btn ? (await btn.textContent()).replace(/\s+/g, ' ').trim() : '';
    ok(/day, month and year/i.test(txt), `and says what it covers — "${txt.slice(0, 90)}"`);

    let url = null;
    page.on('request', r => { if (r.url().includes('/api/master/report/station-throughput')) url = r.url(); });
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await page.waitForTimeout(2500);
    ok(!!url, 'pressing it fires the request');
    ok(url && /from=\d{4}-\d{2}-\d{2}/.test(url) && /to=\d{4}-\d{2}-\d{2}/.test(url),
       `carrying the pane's own period: ${url}`);
    const st = await page.$eval('#adminTab-reports .report-status', el => el.textContent.trim()).catch(() => '');
    ok(/downloaded/i.test(st), `and it downloads rather than erroring — "${st}"`);
    await page.screenshot({ path: `${S}/strep-report.png` });
    await page.close();
  }

  await browser.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
