const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await br.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('http://localhost:4712', { waitUntil: 'domcontentloaded' });
  await p.fill('#loginName','demo'); await p.fill('#loginIC','demo');
  await p.click('#loginBtn'); await p.waitForTimeout(2500);
  await p.locator('[data-tab="inventory"]').click({force:true}); await p.waitForTimeout(1500);
  console.log(await p.evaluate(() => {
    const sec = document.getElementById('tab-inventory');
    const vis = [...sec.querySelectorAll('*')].filter(e => e.offsetParent !== null && ['BUTTON','INPUT','H2','H3','SELECT'].includes(e.tagName))
      .map(e => `${e.tagName}#${e.id||''} "${(e.textContent||e.placeholder||'').trim().slice(0,50)}"`);
    return vis.slice(0,25).join('\n') + '\n---\ninvClient offsetParent: ' + (document.getElementById('invClient')?.offsetParent ? 'yes':'no');
  }));
  await br.close();
})();
