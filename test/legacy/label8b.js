// Single-box order: the only label prints at completion, as "1 OF 1".
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const ORD = '24944949';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
  p.on('dialog', d => d.accept().catch(() => {}));
  await p.context().addInitScript(() => { window.__prints = 0; window.print = function () { try { window.top.__prints++; } catch (e) {} }; });
  await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click()); await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(1500);
  await p.evaluate((o) => { const tr = [...document.querySelectorAll('tr')].find(t => new RegExp(o).test(t.textContent)); tr?.querySelector('.btn-scan-now')?.click(); }, ORD);
  await p.waitForTimeout(3000);
  for (const [sku, n] of [['K4925', 3], ['K5008', 3]]) for (let i = 0; i < n; i++) {
    await p.click('#itemScanInput'); await p.keyboard.type(sku, { delay: 15 }); await p.keyboard.press('Enter'); await p.waitForTimeout(650);
  }
  await p.waitForTimeout(3000);
  if (await p.isVisible('#completeOrderBtn').catch(() => false)) await p.click('#completeOrderBtn').catch(() => {});
  await p.waitForTimeout(4000);
  ok((await p.evaluate(() => window.__prints)) === 1, 'a single-box order prints its ONE label at completion');
  const f = await p.evaluate(() => {
    const d = document.getElementById('cartonLabelFrame')?.contentDocument;
    const e = d?.querySelector('.lbl-page') || d?.body;
    return e ? { ctn: e.querySelector('.ctn')?.textContent.replace(/\s+/g, ' ').trim(), skus: [...e.querySelectorAll('table.it td:first-child')].map(t => t.textContent.trim()) } : null;
  });
  ok(/CTN 1 \/ 1/.test(f?.ctn || ''), `reading "${f?.ctn}" — the short form`);
  const ctnAlign = await p.evaluate(() => {
    const d = document.getElementById('cartonLabelFrame')?.contentDocument;
    const e = d?.querySelector('.ctn');
    return e ? getComputedStyle(e).textAlign : '';
  });
  ok(ctnAlign === 'right', `and it sits on the right (${ctnAlign})`);
  ok(f?.skus.length === 2, `with both SKUs on it (${f?.skus.join(', ')})`);
  // The GI, the order number and the customer all read at the SAME size.
  const px = await p.evaluate(() => {
    const d = document.getElementById('cartonLabelFrame')?.contentDocument;
    const g = sel => { const e = d?.querySelector(sel); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; };
    return { gi: g('.ref-no'), ordNo: g('.ref-alt'), cust: g('.ref-cust') };
  });
  ok(px.gi === 26 && px.ordNo === 26 && px.cust === 26,
     `GI / order no / customer all 26px (${JSON.stringify(px)})`);
  // GI on the LEFT, order number + customer on the RIGHT, per the user.
  const cols = await p.evaluate(() => {
    const d = document.getElementById('cartonLabelFrame')?.contentDocument;
    const gi = d?.querySelector('.ref-no')?.getBoundingClientRect();
    const rt = d?.querySelector('.ref-right')?.getBoundingClientRect();
    const page = d?.querySelector('.ref-row')?.getBoundingClientRect();
    const ctnPx = d?.querySelector('.ctn') ? parseFloat(getComputedStyle(d.querySelector('.ctn')).fontSize) : 0;
    return gi && rt && page ? { giLeft: gi.left - page.left, rtRightGap: page.right - rt.right, sameRow: gi.top < rt.bottom && rt.top < gi.bottom, ctnPx } : null;
  });
  ok(cols && cols.giLeft < 2, `the GI hugs the LEFT edge (offset ${cols?.giLeft}px)`);
  ok(cols && cols.rtRightGap < 2, `the order no + customer hug the RIGHT edge (gap ${cols?.rtRightGap}px)`);
  ok(cols && cols.sameRow, 'and the two columns sit on the same row, facing each other');
  ok(cols && cols.ctnPx === 26, `the CTN line is as large as the GI (${cols?.ctnPx}px)`);
  // The brand block, per the user — both lines, with the mark genuinely loaded.
  const brand = await p.evaluate(() => {
    const d = document.getElementById('cartonLabelFrame')?.contentDocument;
    const b = d?.querySelector('.brand');
    const img = b?.querySelector('img');
    return b ? { text: b.textContent.replace(/\s+/g, ' ').trim(), imgOk: !!(img && img.naturalWidth > 0) } : null;
  });
  ok(/UNITED LOGISTICS AND DISTRIBUTION/.test(brand?.text || ''), 'the label carries UNITED LOGISTICS AND DISTRIBUTION');
  ok(/powered by IdealOne/.test(brand?.text || ''), 'and "powered by IdealOne" beneath it');
  ok(brand?.imgOk === true, 'with the IdealOne mark genuinely loaded, not a broken image box');
  await p.evaluate(() => {
    const fr = document.getElementById('cartonLabelFrame');
    if (fr) fr.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:640px;border:1px solid #ccc;background:#fff;z-index:99999;overflow:auto';
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: __dirname + '/l8b-big.png', clip: { x: 0, y: 0, width: 420, height: 640 } });
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
