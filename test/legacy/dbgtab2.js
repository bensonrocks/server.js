const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await br.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto('http://localhost:4712', { waitUntil: 'domcontentloaded' });
  await p.fill('#loginName','demo'); await p.fill('#loginIC','demo');
  await p.click('#loginBtn'); await p.waitForTimeout(2500);
  await p.locator('[data-tab="inventory"]').click({force:true}); await p.waitForTimeout(1500);
  console.log(await p.evaluate(() => {
    let e = document.getElementById('invLocMode'); const out=[];
    while (e && e !== document.body) {
      const cs = getComputedStyle(e);
      out.push(`${e.tagName}#${e.id||''}.${(e.className||'').toString().split(' ').filter(Boolean).slice(0,3).join('.')} display=${cs.display} vis=${cs.visibility} h=${e.getBoundingClientRect().height}`);
      e = e.parentElement;
    }
    return out.join('\n');
  }));
  await br.close();
})();
