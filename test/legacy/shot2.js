const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 1240, height: 620 } })).newPage();
  await p.goto('http://localhost:4636/portal'); await p.waitForTimeout(1200);
  await p.fill('#liClient', 'VisCo');
  if (await p.isVisible('#liUser').catch(() => false)) await p.fill('#liUser', 'vera');
  await p.fill('#liPass', 'visco123');
  await p.click('#liBtn'); await p.waitForTimeout(3500);
  await p.evaluate(() => document.querySelector('nav button[data-tab="orders"]')?.click());
  await p.waitForTimeout(1500);
  await p.screenshot({ path: 'orders-after.png' });
  await p.evaluate(() => fetch('/api/portal/logout', { method: 'POST', headers: { 'x-auth-token': localStorage.getItem('portal_token') } }));
  await b.close();
})();
