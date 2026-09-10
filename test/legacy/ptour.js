// Walk every portal tab and photograph it, so the review is of what a client
// actually sees rather than of the source.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const BASE = 'http://localhost:4636';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const tag = process.argv[2] || 'now';
  for (const [label, vp] of [['d', { width: 1100, height: 1400 }], ['m', { width: 393, height: 900 }]]) {
    const p = await (await b.newContext({ viewport: vp })).newPage();
    await p.goto(BASE + '/portal'); await p.waitForTimeout(1200);
    await p.fill('#liClient', 'VisCo');
    if (await p.isVisible('#liUser').catch(() => false)) await p.fill('#liUser', 'vera');
    await p.fill('#liPass', 'visco123');
    await p.click('#liBtn'); await p.waitForTimeout(3500);
    for (const t of ['overview', 'stock', 'orders', 'inbound', 'send', 'help']) {
      await p.evaluate(x => document.querySelector(`nav button[data-tab="${x}"]`)?.click(), t);
      await p.waitForTimeout(1200);
      await p.screenshot({ path: `ptour-${tag}-${label}-${t}.png`, fullPage: label === 'd' });
    }
    await p.evaluate(() => fetch('/api/portal/logout', { method: 'POST',
      headers: { 'x-auth-token': localStorage.getItem('portal_token') } }));
    await p.context().close();
  }
  await b.close(); console.log('tour done: ' + tag);
})();
