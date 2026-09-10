// BROWSER — the quick-period chips on Total Throughput Time.
// Desktop and a Pixel 5. Asserts the no-default rule still holds, each chip
// fills the two VISIBLE fields with the right SGT dates, the lit chip clears
// the moment a date is hand-edited, and the outgoing request carries them.
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/shots';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sg = d => (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

// The Administrator button is pinned to the bottom of a scrolling sidebar and
// can sit outside the viewport; dispatch the click directly rather than
// fighting the harness over it. The chips themselves are still clicked for
// real, which is what this test is actually about.
const clickHard = (page, sel) => page.$eval(sel, el => el.click());

async function openReports(page) {
  await page.goto('http://localhost:4731/');
  await page.waitForSelector('#loginName', { timeout: 20000 });
  await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo');
  await page.click('#loginBtn'); await page.waitForTimeout(1800);
  await clickHard(page, '#logAccessBtn'); await page.waitForTimeout(600);
  await page.fill('#logPasswordInput', '201432547E');
  await clickHard(page, '#logPasswordSubmitBtn'); await page.waitForTimeout(1400);
  await clickHard(page, '[data-admin-tab="reports"]'); await page.waitForTimeout(900);
}

(async () => {
  const TODAY = sg(), MONTH = TODAY.slice(0, 7) + '-01', YEAR = TODAY.slice(0, 4) + '-01-01';
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ── DESKTOP ──────────────────────────────────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await openReports(page);
    const P = '#adminTab-reports ';

    // The no-default rule is untouched: still blank on load.
    const f0 = await page.$eval(P + '.rep-throughput-from', el => el.value);
    const t0 = await page.$eval(P + '.rep-throughput-to', el => el.value);
    ok(f0 === '' && t0 === '', `fields still load BLANK — no default period (from=${JSON.stringify(f0)} to=${JSON.stringify(t0)})`);

    const chips = await page.$$eval(P + '.rep-quick .rep-quick-btn', els => els.map(e => e.textContent.trim()));
    ok(chips.length === 3, `three quick-period chips present: ${JSON.stringify(chips)}`);
    ok(chips.join('|') === 'Today|This month|This year', 'chips read Today / This month / This year');

    const row = await page.$(P + 'button[data-report="throughput"]');
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${S}/thruq-01-desktop-blank.png` });

    // TODAY
    await page.click(P + '.rep-quick-btn[data-quick="today"]');
    let f = await page.$eval(P + '.rep-throughput-from', el => el.value);
    let t = await page.$eval(P + '.rep-throughput-to', el => el.value);
    ok(f === TODAY && t === TODAY, `Today fills both fields with the SGT day (${f} → ${t}, expected ${TODAY})`);
    let lit = await page.$$eval(P + '.rep-quick-btn.on', els => els.map(e => e.textContent.trim()));
    ok(lit.length === 1 && lit[0] === 'Today', `exactly one chip lit, and it is the one pressed (${JSON.stringify(lit)})`);
    const bg = await page.$eval(P + '.rep-quick-btn[data-quick="today"]', el => getComputedStyle(el).backgroundColor);
    const bgOff = await page.$eval(P + '.rep-quick-btn[data-quick="year"]', el => getComputedStyle(el).backgroundColor);
    ok(bg !== bgOff, `the lit chip is visibly different by computed style (${bg} vs ${bgOff})`);
    await page.screenshot({ path: `${S}/thruq-02-desktop-today.png` });

    // THIS MONTH
    await page.click(P + '.rep-quick-btn[data-quick="month"]');
    f = await page.$eval(P + '.rep-throughput-from', el => el.value);
    t = await page.$eval(P + '.rep-throughput-to', el => el.value);
    ok(f === MONTH && t === TODAY, `This month = 1st to today (${f} → ${t}, expected ${MONTH} → ${TODAY})`);
    lit = await page.$$eval(P + '.rep-quick-btn.on', els => els.map(e => e.dataset.quick));
    ok(lit.length === 1 && lit[0] === 'month', 'the previous chip went out when another was pressed');

    // THIS YEAR
    await page.click(P + '.rep-quick-btn[data-quick="year"]');
    f = await page.$eval(P + '.rep-throughput-from', el => el.value);
    ok(f === YEAR, `This year = Jan 1 to today (${f}, expected ${YEAR})`);

    // HAND-EDIT CLEARS THE LIT CHIP — it must never claim a period that has
    // since been changed.
    await page.fill(P + '.rep-throughput-from', '2026-02-14');
    await page.waitForTimeout(200);
    lit = await page.$$eval(P + '.rep-quick-btn.on', els => els.length);
    ok(lit === 0, `hand-editing a date clears the lit chip (${lit} still lit)`);
    await page.screenshot({ path: `${S}/thruq-03-desktop-cleared.png` });

    // THE REQUEST ACTUALLY CARRIES THE CHIP'S DATES.
    let url = null;
    page.on('request', r => { if (r.url().includes('/api/master/report/throughput')) url = r.url(); });
    await page.click(P + '.rep-quick-btn[data-quick="today"]');
    await row.click();
    await page.waitForTimeout(1500);
    ok(!!url, 'pressing the report fired the request');
    ok(url && url.includes(`from=${TODAY}`) && url.includes(`to=${TODAY}`), `the outgoing request carries the chip's dates: ${url}`);
    await page.close();
  }

  // ── PIXEL 5 ──────────────────────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ ...devices['Pixel 5'] });
    const page = await ctx.newPage();
    await openReports(page);
    const P = '#adminTab-reports ';
    const btn = await page.$(P + '.rep-quick-btn[data-quick="month"]');
    await btn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const box = await btn.boundingBox();
    const vw = page.viewportSize().width;
    ok(box && box.x >= 0 && box.x + box.width <= vw + 1, `chip fully on a ${vw}px screen (x=${box && Math.round(box.x)} w=${box && Math.round(box.width)})`);
    ok(box && box.height >= 40, `chip is a real tap target (${box && Math.round(box.height)}px tall)`);
    await btn.click();
    const f = await page.$eval(P + '.rep-throughput-from', el => el.value);
    const t = await page.$eval(P + '.rep-throughput-to', el => el.value);
    ok(f === MONTH && t === TODAY, `chip works on the phone too (${f} → ${t})`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `no sideways scroll on the phone (overflow ${over}px)`);
    await page.screenshot({ path: `${S}/thruq-04-pixel5.png` });
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
