// The label with a PACKED carton — contents listed, quantity real — plus the
// hand-write fallback still standing when printing cannot happen.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(() => { window.print = function () { try { window.top.__printed = true; } catch (e) {} }; });
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept().catch(() => {}));
  await p.goto(BASE); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(2000);
  await p.evaluate(() => {
    const tr = [...document.querySelectorAll('tr')].find(t => /24944949/.test(t.textContent));
    tr?.querySelector('.btn-scan-now')?.click();
  });
  await p.waitForTimeout(3500);

  // Pack the box for real.
  for (const sku of ['K4925', 'K4925', 'K5008']) {
    await p.click('#itemScanInput');
    await p.fill('#itemScanInput', '');
    await p.type('#itemScanInput', sku, { delay: 15 });
    await p.keyboard.press('Enter');
    await p.waitForTimeout(900);
  }
  // Reprint with the label button on the carton bar.
  await p.evaluate(() => document.getElementById('printCartonLabelBtn')?.click());
  await p.waitForTimeout(2500);

  const m = await p.evaluate(() => {
    const d = document.getElementById('cartonLabelFrame').contentDocument;
    const txt = s => d.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '';
    return { qty: txt('.qty'), body: d.body.innerText.replace(/\s+/g, ' '),
             rows: [...d.querySelectorAll('table.it tbody tr')].map(r => r.textContent.replace(/\s+/g, ' ').trim()) };
  });
  ok(/3 pcs in this carton/.test(m.qty), `the packed quantity is real (${m.qty})`);
  ok(m.rows.length === 2, `the contents are listed once packed (${m.rows.length} lines)`);
  ok(m.rows.some(r => /K4925.*2/.test(r)), `with the right quantity per SKU (${m.rows.join(' | ')})`);
  ok(!/Reprint with/.test(m.body), 'and the "reprint once packed" note is gone — it IS packed');
  ok(/GI-137641/.test(m.body) && /TML \(052\)/.test(m.body), 'the order reference and customer are still on it');
  await p.evaluate(() => {
    const f = document.getElementById('cartonLabelFrame');
    f.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:600px;border:1px solid #ccc;background:#fff;z-index:99999';
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: 'label3.png', clip: { x: 0, y: 0, width: 400, height: 600 } });
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
