// BROWSER — the Labels review screen, on the exact reported shape.
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const S = __dirname + '/shots';
require('fs').mkdirSync(S, { recursive: true });
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, opts] of [['desktop', { viewport: { width: 1440, height: 900 } }],
                               ['Pixel 5', { ...devices['Pixel 5'] }]]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.goto('http://localhost:4741/');
    await page.waitForSelector('#loginName', { timeout: 20000 });
    await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo');
    await page.click('#loginBtn'); await page.waitForTimeout(2500);

    await page.$eval('[data-tab="labels"]', el => el.click());
    await page.waitForTimeout(1800);
    await page.waitForSelector('.lhi-review-btn', { timeout: 15000 });
    await page.$eval('.lhi-review-btn', el => el.click());
    await page.waitForSelector('.lri-row', { timeout: 15000 });
    await page.waitForTimeout(1200);

    const rows = await page.$$('.lri-row');
    ok(rows.length === 3, `${label}: three label rows on the review screen (${rows.length})`);

    // ── PAGE 1 — the reported one ────────────────────────────────────────────
    const r1 = await page.$$eval('.lri-row', els => {
      const r = els[0];
      const note = r.querySelector('.lri-field-note');
      const off  = r.querySelector('.lri-val-off');
      return {
        text: r.innerText.replace(/\s+/g, ' '),
        note: note ? note.innerText.replace(/\s+/g, ' ') : null,
        offVal: off ? off.textContent.trim() : null,
        offColor: off ? getComputedStyle(off).color : null,
        noteVisible: note ? note.getBoundingClientRect().height > 0 : false,
      };
    });
    ok(!!r1.note, `${label}: the misread is explained in words`);
    ok(r1.note && /almost certainly a misread/i.test(r1.note), `${label}: it says misread, not mismatch`);
    ok(r1.note && r1.note.includes('172429924275375'), `${label}: naming this order's real number`);
    ok(r1.note && /1 character different/.test(r1.note), `${label}: and how far out — "${(r1.note||'').slice(0,110)}"`);
    ok(r1.offVal === '172428924275375', `${label}: the flagged value is the READ one (${r1.offVal})`);
    ok(r1.noteVisible, `${label}: the note is actually visible, not collapsed`);
    // Amber by computed style, not by class name.
    const amber = (r1.offColor || '').match(/\d+/g);
    ok(amber && +amber[0] > 140 && +amber[1] > 50 && +amber[1] < 150 && +amber[2] < 60,
       `${label}: flagged amber by computed style (${r1.offColor})`);
    // The tracking number AGREES, so it must carry no note at all.
    const trackNoted = await page.$$eval('.lri-row', els =>
      [...els[0].querySelectorAll('.lri-field')].some(f =>
        /Tracking/i.test(f.textContent) && f.querySelector('.lri-field-note')));
    ok(!trackNoted, `${label}: the tracking number, which agrees, is left clean`);

    // ── PAGE 2 — GI page, nothing flagged ────────────────────────────────────
    // NOTE: .lri-lbl is text-transform:uppercase and innerText returns the
    // RENDERED text, so the field caption reads "GI NO." on screen — assert on
    // the label element, not a case-sensitive match against the whole row.
    const r2 = await page.$$eval('.lri-row', els => ({
      text: els[1].innerText.replace(/\s+/g, ' '),
      labels: [...els[1].querySelectorAll('.lri-lbl')].map(e => e.textContent.trim()),
      notes: els[1].querySelectorAll('.lri-field-note').length,
    }));
    ok(r2.labels.includes('GI No.'), `${label}: the GI is its own field, captioned "GI No." (${r2.labels.join(' / ')})`);
    ok(/GI-9931/.test(r2.text), `${label}: with the GI on it`);
    ok(/via gi number/i.test(r2.text), `${label}: and it says it matched via the GI`);
    ok(r2.notes === 0, `${label}: a page where everything agrees raises no note`);

    // ── PAGE 3 — foreign ────────────────────────────────────────────────────
    const r3 = await page.$$eval('.lri-row', els => {
      const n = els[2].querySelector('.lri-field-note');
      return n ? n.innerText.replace(/\s+/g, ' ') : null;
    });
    ok(!!r3 && /matches no identifier on this order/i.test(r3),
       `${label}: an unrelated number is flagged differently — "${(r3||'').slice(0,80)}"`);

    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `${label}: no sideways scroll (${over}px)`);

    await page.screenshot({ path: `${S}/identity-${label.replace(/\s/g, '')}.png`, fullPage: true });
    await ctx.close();
  }
  await browser.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
