const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const S = __dirname + '/shots';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, opts] of [['desktop', { viewport: { width: 1440, height: 900 } }],
                               ['Pixel 5', { ...devices['Pixel 5'] }]]) {
    const ctx = await browser.newContext(opts); const page = await ctx.newPage();
    await page.goto('http://localhost:4741/');
    await page.waitForSelector('#loginName', { timeout: 20000 });
    await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo');
    await page.click('#loginBtn'); await page.waitForTimeout(2500);
    await page.$eval('[data-tab="labels"]', el => el.click()); await page.waitForTimeout(1800);
    await page.waitForSelector('.lhi-review-btn', { timeout: 15000 });
    await page.$eval('.lhi-review-btn', el => el.click());
    await page.waitForSelector('.lri-row', { timeout: 15000 }); await page.waitForTimeout(1000);

    const r = await page.$$eval('.lri-row', els => els.map(e => ({
      badge: (e.querySelector('.lri-badge') || {}).textContent || '',
      badgeColor: e.querySelector('.lri-badge') ? getComputedStyle(e.querySelector('.lri-badge')).color : '',
      ambig: e.querySelector('.lri-ambig-note') ? e.querySelector('.lri-ambig-note').innerText.replace(/\s+/g,' ') : null,
      guess: e.querySelector('.lri-guess-note') ? e.querySelector('.lri-guess-note').innerText.replace(/\s+/g,' ') : null,
      cands: [...e.querySelectorAll('.lri-cand')].map(c => c.textContent),
    })));
    ok(r[2] && /ambiguous/i.test(r[2].badge), `${label}: page 3 badged ambiguous ("${r[2] && r[2].badge.trim()}")`);
    ok(r[2] && r[2].ambig && /no label was attached/i.test(r[2].ambig),
       `${label}: it says plainly that nothing was attached`);
    ok(r[2] && JSON.stringify(r[2].cands.sort()) === JSON.stringify(['CSC-200','CSC-300']),
       `${label}: both candidates on screen (${JSON.stringify(r[2] && r[2].cands)})`);
    const red = (r[2].badgeColor||'').match(/\d+/g);
    ok(red && +red[0] > 140 && +red[1] < 90 && +red[2] < 90, `${label}: red by computed style (${r[2].badgeColor})`);
    ok(r[3] && r[3].guess && /worth a look/i.test(r[3].guess), `${label}: the surviving scan match is flagged as a guess`);
    ok(r[0] && !r[0].guess, `${label}: the DISPLACED guess carries no note — it holds nothing now`);
    ok(r[1] && !r[1].guess && !r[1].ambig, `${label}: page 2, matched exactly, carries no warning`);
    const hdr = await page.$eval('#labelReviewSummary, .lri-summary, [id*=labelReview]', el => el.innerText.replace(/\s+/g,' ')).catch(async () => await page.$$eval('.lri-badge', els => els.map(e=>e.textContent).join(' ')));
    ok(/need a decision/i.test(hdr), `${label}: the header counts what needs a decision ("${(hdr||'').slice(0,80)}")`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `${label}: no sideways scroll (${over}px)`);
    await page.screenshot({ path: `${S}/cascade-${label.replace(/\s/g,'')}.png`, fullPage: true });
    await ctx.close();
  }
  await browser.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
