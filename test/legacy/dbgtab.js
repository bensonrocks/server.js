const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await br.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('console', m => { if (m.type()==='error') console.log('CONSOLE ERR:', m.text().slice(0,200)); });
  await p.goto('http://localhost:4712', { waitUntil: 'domcontentloaded' });
  await p.fill('#loginName','demo'); await p.fill('#loginIC','demo');
  await p.click('#loginBtn'); await p.waitForTimeout(2500);
  const btn = p.locator('[data-tab="inventory"]');
  console.log('tab btn visible:', await btn.isVisible(), 'count:', await btn.count());
  await btn.click({ force: true }); await p.waitForTimeout(1500);
  console.log('active tab:', await p.evaluate(() => document.querySelector('.tab-btn.active')?.dataset.tab));
  console.log('#tab-inventory display:', await p.evaluate(() => { const e=document.getElementById('tab-inventory'); return e ? getComputedStyle(e).display : 'MISSING'; }));
  console.log('invLocMode visible:', await p.locator('#invLocMode').isVisible());
  await br.close();
})();
