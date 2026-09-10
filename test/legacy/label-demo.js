// The full carton flow, photographed at every step.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const OUT = __dirname, ORD = '24944949';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept().catch(() => {}));
  await ctx.addInitScript(() => { window.print = function () {}; });

  await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(1500);
  await p.evaluate((o) => {
    const tr = [...document.querySelectorAll('tr')].find(t => new RegExp(o).test(t.textContent));
    tr?.querySelector('.btn-scan-now')?.click();
  }, ORD);
  await p.waitForTimeout(3000);
  // STEP 1 — order open: no prompt, no print, carton badge reads 1.
  await p.screenshot({ path: `${OUT}/demo-1-open.png` });

  // STEP 2 — pack box 1 (3 × K4925).
  for (let i = 0; i < 3; i++) {
    await p.click('#itemScanInput');
    await p.keyboard.type('K4925', { delay: 15 });
    await p.keyboard.press('Enter');
    await p.waitForTimeout(700);
  }
  await p.screenshot({ path: `${OUT}/demo-2-box1-packed.png` });

  // STEP 3 — + New Carton: box 1 closes, box 2 opens. Nothing prints.
  await p.click('#newCartonBtn');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/demo-3-carton2-open.png` });

  // STEP 4 — pack box 2 (3 × K5008); the last scan auto-completes.
  for (let i = 0; i < 3; i++) {
    await p.click('#itemScanInput');
    await p.keyboard.type('K5008', { delay: 15 });
    await p.keyboard.press('Enter');
    await p.waitForTimeout(700);
  }
  await p.waitForTimeout(3000);
  if (await p.isVisible('#completeOrderBtn').catch(() => false)) await p.click('#completeOrderBtn').catch(() => {});
  await p.waitForTimeout(4000);

  // STEP 5 — the labels, exactly as the printer receives them.
  await p.evaluate(() => {
    const f = document.getElementById('cartonLabelFrame');
    if (f) f.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:940px;border:1px solid #ccc;background:#fff;z-index:99999;overflow:auto';
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/demo-5-labels.png`, clip: { x: 0, y: 0, width: 420, height: 940 } });
  await b.close();
  console.log('done');
})();
