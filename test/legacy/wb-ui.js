// The store row has to SAY what it could not fill. A blank waybill with no
// explanation is what turned this into a support question in the first place.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const vp of [{ width: 1400, height: 950, name: 'desktop' }, { width: 393, height: 851, name: 'Pixel 5' }]) {
    console.log(`\n── ${vp.name} ──`);
    const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height } });
    const p = await ctx.newPage();
    p.on('dialog', d => d.accept('201432547E').catch(() => {}));
    await p.goto('http://localhost:4636'); await p.waitForTimeout(1200);
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(2500);
    await p.evaluate(() => document.querySelector('[data-tab="connections"]')?.click());
    await p.waitForTimeout(900);
    // Connections is Administrator-gated by an OVERLAY, not a prompt().
    if (await p.isVisible('#logPasswordOverlay').catch(() => false)) {
      await p.fill('#logPasswordInput', '201432547E');
      await p.keyboard.press('Enter');
      await p.waitForTimeout(2500);
    }
    await p.waitForTimeout(2500);
    const txt = await p.evaluate(() => document.body.innerText);
    ok(/does not answer to by that number/.test(txt),
       'the row names the orders the hub will not answer for');
    const tip = await p.evaluate(() => {
      const el = [...document.querySelectorAll('span[title]')].find(e => /does not answer/.test(e.textContent));
      return el ? el.getAttribute('title') : '';
    });
    ok(/WB-GHOST/.test(tip), `and the tooltip lists them (${(tip || '').slice(0, 60).replace(/\n/g, ' ')})`);
    ok(/Find order/.test(tip), 'and points at the tool that answers it');
    await ctx.close();
  }
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
