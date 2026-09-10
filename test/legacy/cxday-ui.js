const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, vp] of [['desktop', { width: 1440, height: 950 }], ['Pixel 5', { width: 393, height: 851 }]]) {
    const p = await (await b.newContext({ viewport: vp })).newPage();
    p.on('dialog', d => d.accept().catch(() => {}));
    await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(3500);
    await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
    await p.waitForTimeout(2500);
    await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /today/i.test(c.textContent))?.click());
    await p.waitForTimeout(2000);
    await p.evaluate(() => document.querySelector('[data-oview="cancelled"]')?.click());
    await p.waitForTimeout(1500);
    const cnt = await p.evaluate(() => document.querySelector('[data-oview="cancelled"] .subtab-count')?.textContent?.trim());
    ok(cnt === '9', `[${label}] the Cancelled tab under Today counts all 9 (${cnt})`);
    const txt = await p.evaluate(() => document.body.innerText);
    ok(['CX-D','CX-E','CX-F','CX-G','CX-H','CX-I'].every(n => txt.includes(n)),
       `[${label}] the older-upload pair, both withdrawals AND both marketplace voids are listed`);
    // WHO cancelled it is on the row, in words, and amber rather than red.
    const chip = await p.evaluate(() => {
      const c = document.querySelector('.chip-client-withdrew');
      if (!c) return null;
      const s = getComputedStyle(c);
      return { text: c.textContent.trim(), bg: s.backgroundColor, title: c.getAttribute('title') || '' };
    });
    ok(!!chip && /withdrawn by client/i.test(chip.text), `[${label}] the withdrawal says who did it (${chip?.text})`);
    ok(!!chip && chip.bg === 'rgb(254, 243, 199)', `[${label}] amber by computed style, not the red of a cancellation (${chip?.bg})`);
    ok(!!chip && /portal/i.test(chip.title) && /Reason/.test(chip.title),
       `[${label}] with where it came from and their reason in the tooltip`);
    const cw = await p.evaluate(() => document.querySelectorAll('.chip-client-withdrew').length);
    ok(cw === 2, `[${label}] exactly the two withdrawals are marked, not every cancellation (${cw})`);
    ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1,
       `[${label}] no sideways scroll`);
    await p.screenshot({ path: `cxday-${vp.width}.png`, fullPage: false });
  }
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
