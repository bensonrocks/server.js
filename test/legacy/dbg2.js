const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept().catch(() => {}));
  await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(2000);
  await p.evaluate(() => {
    const tr = [...document.querySelectorAll('tr')].find(t => /24944949/.test(t.textContent));
    tr?.querySelector('.btn-scan-now')?.click();
  });
  await p.waitForTimeout(2500);
  await p.evaluate(() => document.getElementById('cartonLabelConfirmBtn')?.click());
  await p.waitForTimeout(600);
  await p.screenshot({ path: 'dbg2-before.png' });
  console.log('state:', await p.evaluate(() => {
    const i = document.getElementById('itemScanInput');
    const r = i?.getBoundingClientRect();
    return { rect: r && { w: Math.round(r.width), h: Math.round(r.height) },
             overlays: [...document.querySelectorAll('.modal-overlay:not(.hidden)')].map(x => x.id),
             scanPhase: document.getElementById('scanOverlay')?.className };
  }));
  for (const [sku, n] of [['K4925', 3], ['K5008', 3]]) {
    for (let i = 0; i < n; i++) {
      await p.click('#itemScanInput'); await p.fill('#itemScanInput', '');
      await p.type('#itemScanInput', sku, { delay: 15 });
      await p.keyboard.press('Enter'); await p.waitForTimeout(600);
    }
  }
  console.log(await p.evaluate(() => {
    const el = document.getElementById('printCartonLabelBtn');
    return { exists: !!el, visible: !!(el && (el.offsetWidth || el.offsetHeight)),
             overlayOpen: !!document.getElementById('itemScanInput'),
             sealOpen: !document.getElementById('sealCartonOverlay')?.classList.contains('hidden'),
             labelOpen: !document.getElementById('cartonLabelOverlay')?.classList.contains('hidden') };
  }));
  await p.screenshot({ path: 'dbg2.png' });
  await b.close();
})();
