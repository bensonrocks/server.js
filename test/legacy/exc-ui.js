const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636', MK = '201432547E';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  // ── THE OFFICE
  for (const [label, vp] of [['desktop', { width: 1440, height: 950 }], ['Pixel 5', { width: 393, height: 851 }]]) {
    const p = await (await b.newContext({ viewport: vp })).newPage();
    await p.goto(BASE); await p.waitForTimeout(1500);
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(3500);
    await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
    await p.waitForTimeout(2500);
    await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
    await p.waitForTimeout(2000);
    const chip = await p.evaluate(() => {
      const c = document.querySelector('.chip-hub-exception');
      if (!c) return null;
      const s = getComputedStyle(c);
      return { text: c.textContent.trim(), bg: s.backgroundColor, title: c.getAttribute('title') || '' };
    });
    ok(!!chip, `[${label}] the returned parcel carries a chip on its row`);
    ok(!!chip && /Returned to us|Shipment failed/.test(chip.text), `[${label}] saying what happened (${chip?.text})`);
    ok(!!chip && chip.bg === 'rgb(254, 226, 226)', `[${label}] red — the order otherwise reads as shipped (${chip?.bg})`);
    ok(!!chip && /channel reported/.test(chip.title), `[${label}] with when the channel reported it, in the tooltip`);
    const never = await p.evaluate(() => [...document.querySelectorAll('.chip-hub-exception')]
      .some(c => /never shipped here/.test(c.textContent)));
    ok(never, `[${label}] and the one we never shipped says so on the chip itself`);
    ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1,
       `[${label}] no sideways scroll`);
    await p.screenshot({ path: `exc-office-${vp.width}.png` });
    await p.context().close();
  }
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
