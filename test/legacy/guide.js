// The Guide has to answer the questions a client will actually have — and the
// glossary must never say something different from the pills on other tabs.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, vp] of [['desktop', { width: 1100, height: 1000 }], ['Pixel 5', { width: 393, height: 851 }]]) {
    const p = await (await b.newContext({ viewport: vp })).newPage();
    await p.goto(BASE + '/portal'); await p.waitForTimeout(1200);
    await p.fill('#liClient', 'VisCo');
    if (await p.isVisible('#liUser').catch(() => false)) await p.fill('#liUser', 'vera');
    await p.fill('#liPass', 'visco123');
    await p.click('#liBtn'); await p.waitForTimeout(3500);
    await p.evaluate(() => document.querySelector('nav button[data-tab="help"]')?.click());
    await p.waitForTimeout(2000);

    const g = await p.evaluate(() => {
      const grps = [...document.querySelectorAll('#glossary .gl-grp')].map(x => ({
        title: x.querySelector('.gl-hd')?.textContent?.trim(),
        rows: [...x.querySelectorAll('.gl-row')].map(r => ({
          pill: r.querySelector('.gl-pill')?.textContent?.trim(),
          what: r.querySelector('.gl-what')?.textContent?.trim(),
          bg: getComputedStyle(r.querySelector('.gl-pill')).backgroundColor,
        })),
      }));
      return { grps, headings: [...document.querySelectorAll('#tab-help h2')].map(h => h.textContent.trim()) };
    });
    ok(g.grps.length === 4, `[${label}] the glossary has all four groups (${g.grps.map(x => x.title).join(', ')})`);
    const rows = g.grps.flatMap(x => x.rows);
    ok(rows.length >= 18, `[${label}] and covers every label a client will meet (${rows.length})`);
    ok(rows.every(r => r.pill && r.what), `[${label}] each one is a real pill beside plain English`);
    ok(rows.every(r => r.bg && r.bg !== 'rgba(0, 0, 0, 0)'),
       `[${label}] the pills are actually coloured, not bare text — that is what makes them findable`);
    ok(rows.every(r => !/undefined|\[object/.test(r.pill + r.what)), `[${label}] nothing rendered as undefined`);

    // THE GLOSSARY MUST MATCH THE SCREENS. These come from the same server
    // constants, so a wording change moves both.
    for (const want of ['Pending Processing', 'Being packed', 'Completed', 'Cancelled',
                        'Ready for Collection', 'Picked Up', 'Not collected']) {
      ok(rows.some(r => r.pill === want), `[${label}] "${want}" is explained`);
    }
    ok(rows.some(r => /working days/.test(r.pill)), `[${label}] and so is the receiving promise`);
    ok(rows.some(r => /cut-off/.test(r.what)), `[${label}] with the real daily cut-off, not a made-up one`);

    ok(g.headings.length >= 5,
       `[${label}] the Guide covers using it, the labels, downloads, problems and who we are (${g.headings.length} sections)`);
    ok(g.headings.some(h => /not right/i.test(h)), `[${label}] including what to do when something is wrong`);
    ok(g.headings.some(h => /figures out/i.test(h)), `[${label}] and how to get the figures out`);

    const rn = await p.evaluate(() => document.getElementById('rangeNote')?.textContent || '');
    ok(/\d+ days/.test(rn), `[${label}] the on-screen vs download window is stated in real numbers (${rn.slice(0, 60)})`);

    ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1,
       `[${label}] no sideways scroll`);
    await p.screenshot({ path: `guide-${vp.width}.png`, fullPage: label === 'desktop' });
    await p.evaluate(() => fetch('/api/portal/logout', { method: 'POST',
      headers: { 'x-auth-token': localStorage.getItem('portal_token') } }));
    await p.context().close();
  }
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
