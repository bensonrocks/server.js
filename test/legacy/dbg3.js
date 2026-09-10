const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGE ERR:', String(e).slice(0, 300)));
  p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 200)); });
  p.on('dialog', async d => { console.log('DIALOG:', d.message().slice(0, 120)); await d.accept().catch(()=>{}); });
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
  await p.waitForTimeout(3500);
  console.log(await p.evaluate(() => ({
    overlayOpen: !document.getElementById('cartonLabelOverlay')?.classList.contains('hidden'),
    frame: !!document.getElementById('cartonLabelFrame'),
    note: document.getElementById('cartonLabelAutoNote')?.textContent || '',
    noteHidden: document.getElementById('cartonLabelAutoNote')?.classList.contains('hidden'),
    scanOpen: !!document.getElementById('itemScanInput'),
  })));
  await b.close();
})();
