// REPRINT CARTON LABELS FROM THE ORDERS LIST — completed orders included.
//
// Per the user: "allow reprinting of labels from order summary by selecting
// order even if its completed". Flow: pack 24944949 into two boxes through
// the real UI and complete it, then go to Orders → Completed, tick it, press
// 🏷 Carton Labels, and get BOTH boxes' labels in one run — final "CTN n / 2",
// each with its own contents. Cancelling the confirm prints nothing.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const ORD = '24944949';

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 200)));
  let confirmAnswer = true, lastConfirm = '';
  p.on('dialog', d => {
    if (d.type() === 'confirm') { lastConfirm = d.message(); (confirmAnswer ? d.accept() : d.dismiss()).catch(() => {}); }
    else d.accept().catch(() => {});
  });
  await ctx.addInitScript(() => {
    window.__prints = 0;
    window.print = function () { try { window.top.__prints++; } catch (e) { window.__prints++; } };
  });
  const prints = () => p.evaluate(() => window.__prints);
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

  // ── PACK AND COMPLETE: 3 × K4925 in box 1, 3 × K5008 in box 2.
  await p.evaluate((o) => {
    const tr = [...document.querySelectorAll('tr')].find(t => new RegExp(o).test(t.textContent));
    tr?.querySelector('.btn-scan-now')?.click();
  }, ORD);
  await p.waitForTimeout(3000);
  await scan('K4925', 3);
  await p.click('#newCartonBtn'); await p.waitForTimeout(2000);
  await scan('K5008', 3);
  // The last scan can auto-complete and close the overlay before Complete lands.
  await p.waitForTimeout(3000);
  if (await p.isVisible('#completeOrderBtn').catch(() => false)) {
    await p.click('#completeOrderBtn').catch(() => {});
  }
  await p.waitForTimeout(4000);
  const packPrints = await prints();
  ok(packPrints >= 2, `the pick itself printed per-close + final labels as before (${packPrints})`);

  // ── THE COMPLETED LIST: tick the order, the button counts it.
  await p.evaluate(() => document.querySelector('[data-oview="completed"]')?.click());
  await p.waitForTimeout(2000);
  const ticked = await p.evaluate((o) => {
    let n = 0;
    for (const cb of document.querySelectorAll('.ord-select')) {
      if (cb.dataset.order === o) { cb.click(); n++; }
    }
    return n;
  }, ORD);
  ok(ticked === 1, `the completed order is tickable on the list (${ticked})`);
  await p.waitForTimeout(500);
  const btn = await p.evaluate(() => {
    const b2 = document.getElementById('ordersBulkCartonLabels');
    return b2 ? { there: true, disabled: b2.disabled, text: b2.textContent.trim(), visible: !!b2.offsetParent } : { there: false };
  });
  ok(btn.there && btn.visible, 'the 🏷 Carton Labels button is on the bulk bar');
  ok(btn.disabled === false, 'and enabled for a COMPLETED order — the whole point');
  ok(/Carton Labels \(1\)/.test(btn.text), `counting the selection ("${btn.text}")`);
  await p.screenshot({ path: __dirname + '/l9-1-selected.png', clip: { x: 0, y: 0, width: 1400, height: 520 } });

  // ── CANCELLING THE CONFIRM PRINTS NOTHING.
  confirmAnswer = false;
  const before = await prints();
  await p.click('#ordersBulkCartonLabels');
  await p.waitForTimeout(2500);
  ok(/2 carton labels for 1 order/.test(lastConfirm), `the confirm states the real numbers ("${lastConfirm.split('\n')[0]}")`);
  ok((await prints()) === before, 'cancelling it prints nothing');

  // ── CONFIRMING PRINTS BOTH BOXES IN ONE RUN, WITH THE FINAL TOTAL.
  confirmAnswer = true;
  await p.click('#ordersBulkCartonLabels');
  await p.waitForTimeout(3000);
  ok((await prints()) === before + 1, `one print run for the whole selection (${await prints()} vs ${before})`);
  const doc = await p.evaluate(() => {
    const d = document.getElementById('cartonLabelFrame')?.contentDocument;
    if (!d) return null;
    return [...d.querySelectorAll('.lbl-page')].map(e => ({
      lbl: e.querySelector('.lbl')?.textContent.trim(),
      ctn: e.querySelector('.ctn')?.textContent.replace(/\s+/g, ' ').trim(),
      qty: e.querySelector('.qty')?.textContent.replace(/\s+/g, ' ').trim(),
      skus: [...e.querySelectorAll('table.it td:first-child')].map(t => t.textContent.trim()),
      bars: e.querySelectorAll('svg.bc rect').length,
    }));
  });
  ok(doc && doc.length === 2, `both boxes' labels rendered (${doc?.length})`);
  if (doc && doc.length === 2) {
    ok(doc[0].lbl === `${ORD}-01` && doc[1].lbl === `${ORD}-02`, `labelled ${doc[0].lbl} and ${doc[1].lbl}`);
    ok(/CTN 1 \/ 2/.test(doc[0].ctn) && /CTN 2 \/ 2/.test(doc[1].ctn),
       `the order is done, so BOTH carry the final total ("${doc[0].ctn}" / "${doc[1].ctn}")`);
    ok(/\b3 pcs in this carton/.test(doc[0].qty) && /\b3 pcs in this carton/.test(doc[1].qty),
       `each with its real count (${doc[0].qty})`);
    ok(doc[0].skus.includes('K4925') && !doc[0].skus.includes('K5008'),
       `box 1 lists its own contents (${doc[0].skus.join(', ')})`);
    ok(doc[1].skus.includes('K5008') && !doc[1].skus.includes('K4925'),
       `box 2 lists its own (${doc[1].skus.join(', ')})`);
    ok(doc.every(x => x.bars > 10), 'every label carries its rendered barcode');
  }

  // Photograph the run as it would print.
  await p.evaluate(() => {
    const f = document.getElementById('cartonLabelFrame');
    if (f) f.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:940px;border:1px solid #ccc;background:#fff;z-index:99999;overflow:auto';
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: __dirname + '/l9-2-reprint.png', clip: { x: 0, y: 0, width: 420, height: 940 } });

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
