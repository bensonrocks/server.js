// Step 5 of the picked-up demo — the CLIENT'S portal view of PU-1, now that
// the courier scan has closed it. Correct login ids this time (liClient/
// liUser/liPass/liBtn) and the portal's own data-tab="orders".
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const OUT = __dirname;
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  await p.goto('http://localhost:4636/portal'); await p.waitForTimeout(1500);
  await p.fill('#liClient', 'ChaseCo');
  await p.fill('#liUser', 'pu-demo');
  await p.fill('#liPass', 'pudemo1');
  await p.click('#liBtn');
  await p.waitForTimeout(3000);
  const inApp = await p.evaluate(() => !document.getElementById('appView')?.classList.contains('hidden'));
  ok(inApp, 'the client is signed in');
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  const row = await p.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(x => /PU-1/.test(x.textContent) && x.textContent.length < 600 && /Picked Up/i.test(x.textContent));
    if (el) el.scrollIntoView({ block: 'center' });
    return el ? el.textContent.replace(/\s+/g, ' ').slice(0, 300) : '';
  });
  ok(/Picked Up/i.test(row), `PU-1 shows Picked Up on the client's own screen ("${row.slice(0, 120)}")`);
  await p.evaluate(() => {
    const tag = document.createElement('div');
    tag.textContent = "3. The client sees it too — 📦 Picked Up, collected by the platform's courier. Automatic, same moment.";
    tag.style.cssText = 'position:fixed;left:20px;top:14px;background:#dc2626;color:#fff;font:800 16px -apple-system,Arial;padding:8px 12px;border-radius:8px;z-index:999999;max-width:600px;box-shadow:0 4px 14px rgba(0,0,0,.35)';
    document.body.appendChild(tag);
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/pu-3-portal.png`, clip: { x: 0, y: 0, width: 1400, height: 720 } });
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
