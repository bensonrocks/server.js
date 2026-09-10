// BROWSER — Station Throughput on the phone the screenshot was taken on.
// Four tiles must fit 393px, today must be visibly the odd column out, and the
// modal must not scroll sideways.
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/shots';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sgToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

async function login(page) {
  await page.goto('http://localhost:4733/');
  await page.waitForSelector('#loginName', { timeout: 20000 });
  await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo');
  await page.click('#loginBtn'); await page.waitForTimeout(2000);
}
async function openStp(page) {
  await page.$eval('#stationThroughputBtn', el => el.click());
  await page.waitForTimeout(1500);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  for (const [label, opts] of [['Pixel 5', { ...devices['Pixel 5'] }], ['desktop', { viewport: { width: 1440, height: 900 } }]]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await login(page);
    await openStp(page);
    const vw = page.viewportSize().width;

    const tiles = await page.$$eval('#stpTotalsGrid .dstat', els => els.map(e => ({
      txt: e.textContent.replace(/\s+/g, ' ').trim(),
      today: e.classList.contains('dstat-today'),
      x: e.getBoundingClientRect().x, r: e.getBoundingClientRect().right,
      bg: getComputedStyle(e).backgroundColor,
    })));
    ok(tiles.length === 4, `${label}: FOUR tiles, today included (got ${tiles.length}) — ${JSON.stringify(tiles.map(t => t.txt))}`);
    ok(tiles.filter(t => t.today).length === 1, `${label}: exactly one tile marked as today`);
    ok(tiles[3]?.today, `${label}: it is the LAST tile`);
    ok(/so far today/i.test(tiles[3]?.txt || ''), `${label}: and it says "so far today" in words — "${tiles[3]?.txt}"`);
    ok(tiles[3]?.bg !== tiles[0]?.bg, `${label}: today's tile differs by computed style (${tiles[3]?.bg} vs ${tiles[0]?.bg})`);
    ok(tiles.every(t => t.x >= -1 && t.r <= vw + 1), `${label}: all four tiles fully on a ${vw}px screen`);

    const heads = await page.$$eval('#stpOrdersHead th', els => els.map(e => ({
      txt: e.textContent.replace(/\s+/g, ' ').trim(), today: e.classList.contains('stp-today'),
    })));
    ok(heads.length === 6, `${label}: Station + 4 days + Total = 6 columns (got ${heads.length})`);
    ok(heads.filter(h => h.today).length === 1 && /so far/i.test(heads[4]?.txt || ''),
       `${label}: today's column header marked and says "so far" — "${heads[4]?.txt}"`);
    const cellsToday = await page.$$eval('#stpOrdersBody tr', rows =>
      rows.map(r => [...r.children].findIndex(c => c.classList.contains('stp-today'))));
    ok(cellsToday.length > 0 && cellsToday.every(i => i === 4),
       `${label}: every body row marks the SAME column as today (indices ${JSON.stringify(cellsToday)})`);

    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `${label}: no sideways scroll on the page (overflow ${over}px)`);
    await page.screenshot({ path: `${S}/stp-${label.replace(/\s/g, '')}.png` });
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
