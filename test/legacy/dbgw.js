const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await br.newPage({ viewport: { width: 393, height: 851 } });
  await p.goto('http://localhost:4712', { waitUntil: 'domcontentloaded' });
  await p.fill('#loginName','demo'); await p.fill('#loginIC','demo');
  await p.click('#loginBtn'); await p.waitForTimeout(2500);
  await p.locator('#sidebarToggleBtn').click(); await p.waitForTimeout(500);
  await p.locator('[data-tab="inventory"]').click({force:true}); await p.waitForTimeout(900);
  await p.getByRole('button',{name:/Open stock/i}).click(); await p.waitForTimeout(700);
  await p.fill('#invClient','MoveCo'); await p.locator('#invLoadBtn').click({force:true}); await p.waitForTimeout(1600);
  console.log('select box:', JSON.stringify(await p.locator('#invLocMode').boundingBox()));
  console.log('page h-scroll:', await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), await p.evaluate(()=>document.documentElement.scrollWidth));
  await br.close();
})();
