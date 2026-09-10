const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  const reqs = [];
  p.on('request', r => { if (/\/api\/portal\//.test(r.url())) reqs.push({ t: Date.now(), u: r.url().replace(/.*\/api/, '/api') }); });
  p.on('pageerror', e => console.log('PAGE ERR:', String(e).slice(0, 200)));
  await p.goto('http://localhost:4636/portal'); await p.waitForTimeout(1200);
  await p.fill('#liClient', 'VisCo');
  if (await p.isVisible('#liUser').catch(() => false)) await p.fill('#liUser', 'vera');
  await p.fill('#liPass', 'visco123');
  await p.click('#liBtn'); await p.waitForTimeout(3500);
  const t0 = Date.now(); reqs.length = 0;
  console.log('state:', await p.evaluate(() => ({
    hasSection: !!document.getElementById('tab-overview'),
    hidden: document.getElementById('tab-overview')?.classList.contains('hidden'),
    vis: document.documentElement.ownerDocument.visibilityState,
  })));
  await p.waitForTimeout(38000);
  console.log('portal requests in 38s after load:', reqs.map(r => `${Math.round((r.t - t0)/1000)}s ${r.u}`).join(' | ') || 'NONE');
  await p.evaluate(() => fetch('/api/portal/logout', { method: 'POST', headers: { 'x-auth-token': localStorage.getItem('portal_token') } }));
  await b.close();
})();
