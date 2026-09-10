// CARTON LABELS PRINT AT COMPLETION — when every fact on them is true.
//
// The floor tried the print-at-open version and rightly objected: the label
// read "0 pcs in this carton" and could not say "1 of X", because neither is
// known before the box is packed. Per the user: close the carton, then print.
// Now NOTHING prints during the pick, and at completion ONE run prints every
// box's label — contents, piece count, and "n OF m".
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

  // ── NOTHING PRINTS AND NOTHING PROMPTS AT OPEN — the exact complaint.
  ok((await p.evaluate(() => window.__prints)) === 0, 'opening the order prints NOTHING');
  ok(!(await p.evaluate(() => { const o = document.getElementById('cartonLabelOverlay'); return o && !o.classList.contains('hidden'); })),
     'and no label prompt pops up before scanning starts');

  // ── PACK BOX 1 (3 × K4925), open box 2 — still nothing prints mid-pick.
  for (let i = 0; i < 3; i++) {
    await p.click('#itemScanInput');
    await p.keyboard.type('K4925', { delay: 15 });
    await p.keyboard.press('Enter');
    await p.waitForTimeout(700);
  }
  await p.click('#newCartonBtn');
  await p.waitForTimeout(1500);
  ok((await p.evaluate(() => window.__prints)) === 0, '+ New Carton prints nothing mid-order — "1 of X" is not a fact yet');
  ok((await p.evaluate(() => document.getElementById('scanCartonNum')?.textContent)) === '2', 'the packer is in carton 2');

  // ── PACK BOX 2 (3 × K5008) and COMPLETE.
  for (let i = 0; i < 3; i++) {
    await p.click('#itemScanInput');
    await p.keyboard.type('K5008', { delay: 15 });
    await p.keyboard.press('Enter');
    await p.waitForTimeout(700);
  }
  // The last scan can AUTO-COMPLETE the order and close the overlay before a
  // Complete click ever lands — press the button only if it is still there.
  await p.waitForTimeout(3000);
  if (await p.isVisible('#completeOrderBtn').catch(() => false)) {
    await p.click('#completeOrderBtn').catch(() => {});
  }
  await p.waitForTimeout(4000);

  // ── ONE RUN, EVERY LABEL, EVERY FACT TRUE.
  ok((await p.evaluate(() => window.__prints)) === 1, `completion fires ONE print run (${await p.evaluate(() => window.__prints)})`);
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
  ok(doc && doc.length === 2, `one page per box (${doc?.length})`);
  if (doc && doc.length === 2) {
    ok(doc[0].lbl === `${ORD}-01` && doc[1].lbl === `${ORD}-02`, `labelled ${doc[0].lbl} and ${doc[1].lbl}`);
    ok(/CARTON 1 OF 2/.test(doc[0].ctn) && /CARTON 2 OF 2/.test(doc[1].ctn),
       `each says which of how many — "${doc[0].ctn}" / "${doc[1].ctn}" — the "1 of X" the floor asked for`);
    ok(/\b3 pcs in this carton/.test(doc[0].qty) && /\b3 pcs in this carton/.test(doc[1].qty),
       `and the REAL piece count, not 0 ("${doc[0].qty}")`);
    ok(doc[0].skus.includes('K4925') && !doc[0].skus.includes('K5008'),
       `box 1 lists its own contents (${doc[0].skus.join(', ')})`);
    ok(doc[1].skus.includes('K5008') && !doc[1].skus.includes('K4925'),
       `box 2 lists its own (${doc[1].skus.join(', ')})`);
    ok(doc.every(x => x.bars > 10), 'and every page carries its own rendered barcode');
  }

  // Photograph the run as it would print: bring the frame on screen.
  await p.evaluate(() => {
    const f = document.getElementById('cartonLabelFrame');
    if (f) f.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:940px;border:1px solid #ccc;background:#fff;z-index:99999;overflow:auto';
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: __dirname + '/label7-run.png', clip: { x: 0, y: 0, width: 420, height: 940 } });

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
