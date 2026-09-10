// The customer name on the SCAN screen — the name a packer checks the box
// against — read at a glance rather than at reference size.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, vp] of [['desktop', { width: 1400, height: 900 }], ['Pixel 5', { width: 393, height: 851 }]]) {
    const p = await (await b.newContext({ viewport: vp })).newPage();
    p.on('dialog', d => d.accept().catch(() => {}));
    await p.goto(BASE); await p.waitForTimeout(1500);
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(3000);
    await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
    await p.waitForTimeout(2500);
    await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
    await p.waitForTimeout(2000);
    // Any order still open — we only need the scan header.
    const opened = await p.evaluate(() => {
      const btn = document.querySelector('.btn-scan-now');
      if (!btn) return false;
      btn.click(); return true;
    });
    ok(opened, `[${label}] an order opened into the scan screen`);
    await p.waitForTimeout(2500);
    // The mandatory carton-label prompt covers the header — dismiss it.
    if (await p.isVisible('#cartonLabelOverlay').catch(() => false)) {
      await p.evaluate(() => [...document.querySelectorAll('#cartonLabelOverlay button')]
        .find(x => /hand/i.test(x.textContent))?.click());
      await p.waitForTimeout(700);
    }

    const m = await p.evaluate(() => {
      const cust = document.querySelector('.meta-pill-customer');
      const others = [...document.querySelectorAll('.scan-meta-primary .meta-pill')]
        .filter(e => !e.classList.contains('meta-pill-customer'));
      const px = e => parseFloat(getComputedStyle(e).fontSize);
      return cust ? {
        text: cust.textContent.trim(), px: px(cust),
        weight: getComputedStyle(cust).fontWeight,
        otherPx: others.length ? Math.max(...others.map(px)) : 0,
        right: cust.getBoundingClientRect().right,
        visible: !!(cust.offsetWidth || cust.offsetHeight),
      } : null;
    });
    ok(!!m, `[${label}] the customer pill is on the scan header`);
    ok(m && m.visible, `[${label}] and on screen (${m?.text})`);
    ok(m && m.px > m.otherPx * 1.2,
       `[${label}] noticeably larger than the other pills — ${m?.px}px against ${m?.otherPx}px`);
    ok(m && Number(m.weight) >= 700, `[${label}] and bolder (${m?.weight})`);
    ok(m && m.right <= vp.width + 1, `[${label}] not pushed off the edge (${Math.round(m?.right || 0)} of ${vp.width})`);
    ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1,
       `[${label}] no sideways scroll`);
    // The other pills must still be reachable, not shoved out of the row.
    const still = await p.evaluate(() => [...document.querySelectorAll('.scan-meta-primary .meta-pill')]
      .filter(e => e.offsetWidth || e.offsetHeight).length);
    ok(still >= 3, `[${label}] the rest of the header survives (${still} pills showing)`);
    await p.screenshot({ path: `cust-${vp.width}.png`, clip: { x: 0, y: 0, width: vp.width, height: Math.min(240, vp.height) } });
    await p.context().close();
  }
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
