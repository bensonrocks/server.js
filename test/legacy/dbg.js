const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text().slice(0, 200)); });
  p.on('pageerror', e => console.log('PAGE ERR:', String(e).slice(0, 300)));
  p.on('dialog', async d => { console.log('DIALOG:', d.type(), d.message().slice(0, 80)); await d.dismiss().catch(()=>{}); });
  await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="connections"]')?.click());
  await p.waitForTimeout(700);
  if (await p.isVisible('#logPasswordOverlay').catch(() => false)) {
    await p.fill('#logPasswordInput', '201432547E'); await p.click('#logPasswordSubmitBtn'); await p.waitForTimeout(2000);
  }
  await p.evaluate(() => { const s = document.getElementById('secStores'); if (s) s.open = true; });
  await p.waitForTimeout(1500);
  console.log(await p.evaluate(() => [...document.querySelectorAll('tr')]
    .map((t, i) => ({ i, hook: !!t.querySelector('.z-hook'), txt: t.textContent.replace(/\s+/g,' ').trim().slice(0, 30) }))
    .filter(x => x.txt)));
  await p.evaluate(() => document.querySelector('.z-hook')?.click());
  await p.waitForTimeout(4000);
  console.log('after click, disabled =', await p.evaluate(() => document.querySelector('.z-hook')?.disabled));
  await b.close();
})();
