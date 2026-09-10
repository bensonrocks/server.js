// PER-CARTON PRINTING, exactly as the user specified:
//   "when individual carton closes, label to be out automatically. ie: an
//    order of 3 ctns — carton #01 will be printed when user scans a few
//    products then opens another carton #. until the last, user will complete
//    the order, final carton label will be out as # of #"
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const ORD = '24944949';

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 200)));
  p.on('dialog', d => d.accept().catch(() => {}));
  await ctx.addInitScript(() => {
    window.__prints = 0;
    window.print = function () { try { window.top.__prints++; } catch (e) { window.__prints++; } };
  });
  const prints = () => p.evaluate(() => window.__prints);
  const frame = () => p.evaluate(() => {
    const d = document.getElementById('cartonLabelFrame')?.contentDocument;
    if (!d) return null;
    const e = d.querySelector('.lbl-page') || d.body;
    return {
      lbl: e.querySelector('.lbl')?.textContent.trim(),
      ctn: e.querySelector('.ctn')?.textContent.replace(/\s+/g, ' ').trim(),
      qty: e.querySelector('.qty')?.textContent.replace(/\s+/g, ' ').trim(),
      skus: [...e.querySelectorAll('table.it td:first-child')].map(t => t.textContent.trim()),
    };
  });
  const scan = async (sku, n) => {
    for (let i = 0; i < n; i++) {
      await p.click('#itemScanInput');
      await p.keyboard.type(sku, { delay: 15 });
      await p.keyboard.press('Enter');
      await p.waitForTimeout(700);
    }
  };

  await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(1500);
  await p.evaluate((o) => {
    const tr = [...document.querySelectorAll('tr')].find(t => new RegExp(o).test(t.textContent));
    tr?.querySelector('.btn-scan-now')?.click();
  }, ORD);
  await p.waitForTimeout(3000);

  ok((await prints()) === 0, 'opening the order prints nothing — the box is not closed yet');

  // ── BOX 1: scan a few pieces, open box 2 → BOX 1'S LABEL COMES OUT.
  await scan('K4925', 2);
  await p.click('#newCartonBtn'); await p.waitForTimeout(2000);
  ok((await prints()) === 1, `closing carton 1 printed its label automatically (${await prints()})`);
  let f = await frame();
  ok(f?.lbl === `${ORD}-01`, `and it is carton 1's label (${f?.lbl})`);
  ok(/CTN 1\b/.test(f?.ctn || '') && !/\//.test(f?.ctn || ''),
     `reading "${f?.ctn}" — number only, the total is not a fact yet`);
  ok(/\b2 pcs in this carton/.test(f?.qty || ''), `with its real count (${f?.qty})`);
  ok(f?.skus.join() === 'K4925', `and its own contents (${f?.skus.join(', ')})`);
  await p.screenshot({ path: __dirname + '/l8-1-carton1.png', clip: { x: 0, y: 0, width: 1400, height: 500 } });

  // ── BOX 2: a few more, open box 3 → BOX 2'S LABEL COMES OUT.
  await scan('K4925', 1);   // finish K4925 into box 2
  await scan('K5008', 1);
  await p.click('#newCartonBtn'); await p.waitForTimeout(2000);
  ok((await prints()) === 2, `closing carton 2 printed its label (${await prints()})`);
  f = await frame();
  ok(f?.lbl === `${ORD}-02` && /CTN 2\b/.test(f?.ctn || '') && !/\//.test(f?.ctn || ''),
     `carton 2's label, number only ("${f?.ctn}")`);
  ok(/\b2 pcs in this carton/.test(f?.qty || ''), `its 2 pcs (${f?.qty})`);
  ok(f?.skus.includes('K4925') && f?.skus.includes('K5008'), `both its SKUs listed (${f?.skus.join(', ')})`);

  // ── BOX 3: the rest, COMPLETE → FINAL LABEL AS "# of #".
  await scan('K5008', 2);
  await p.waitForTimeout(3000);
  if (await p.isVisible('#completeOrderBtn').catch(() => false)) await p.click('#completeOrderBtn').catch(() => {});
  await p.waitForTimeout(4000);
  ok((await prints()) === 3, `completion printed the FINAL carton's label (${await prints()} prints total — one per box)`);
  f = await frame();
  ok(f?.lbl === `${ORD}-03`, `it is carton 3's label (${f?.lbl})`);
  ok(/CTN 3 \/ 3/.test(f?.ctn || ''), `and ONLY this one carries "# / #" — "${f?.ctn}"`);
  ok(/\b2 pcs in this carton/.test(f?.qty || ''), `with its real count (${f?.qty})`);
  ok(f?.skus.join() === 'K5008', `and its own contents (${f?.skus.join(', ')})`);

  // Photograph the final label.
  await p.evaluate(() => {
    const fr = document.getElementById('cartonLabelFrame');
    if (fr) fr.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:560px;border:1px solid #ccc;background:#fff;z-index:99999;overflow:auto';
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: __dirname + '/l8-3-final.png', clip: { x: 0, y: 0, width: 420, height: 560 } });

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
