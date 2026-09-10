// The rendered label, and the optional pre-print run.
//
//  1. While an order is open the printed line reads "CARTON 1" — never
//     "CARTON 1 OF 1", which claimed a total nobody could know yet.
//  2. 🏷×N pre-prints the next few labels in one go: sequential carton ids,
//     each barcoded, each blank until its box is packed — and NO carton is
//     created, because "+ New Carton" is still what brings a box into being.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636';
const ORD = '24944949';

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ONE VIEWPORT PER RUN, reset in between: the auto-print CONFIRMS the label,
  // so a second browser on the same order would never see the prompt again.
  const ALL = [{ width: 1400, height: 900, name: 'desktop' }, { width: 393, height: 851, name: 'Pixel 5' }];
  const want = process.argv[2] || '';
  for (const vp of ALL.filter(v => !want || v.name === want)) {
    console.log(`\n── ${vp.name} ─────────────────────────────`);
    const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
    const p = await ctx.newPage();
    p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 200)));
    // The label prints from a hidden IFRAME. Neuter print so nothing waits on
    // a dialog, and record that it was called.
    await ctx.addInitScript(() => {
      window.__printed = 0;
      window.print = function () { try { window.top.__printed++; } catch (e) { window.__printed++; } };
    });
    // prompt() for how many, then confirm() for the run. Answer both.
    let asked = '';
    p.on('dialog', d => {
      if (d.type() === 'prompt') { asked = d.message(); d.accept('3').catch(() => {}); }
      else d.accept().catch(() => {});
    });

    await p.goto(BASE); await p.waitForTimeout(1500);
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(3000);
    await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
    await p.waitForTimeout(2500);
    await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
    await p.waitForTimeout(2000);
    await p.evaluate((o) => {
      const tr = [...document.querySelectorAll('tr')].find(t => new RegExp(o).test(t.textContent));
      tr?.querySelector('.btn-scan-now')?.click();
    }, ORD);
    await p.waitForTimeout(3500);

    // SUPERSEDED: labels no longer print at order-open (per the user, after
    // the floor's "0 pcs / no 1-of-X" report — they print at completion now).
    ok(!(await p.evaluate(() => !!document.getElementById('cartonLabelFrame'))),
       'nothing prints at order-open any more');

    // ── 1. NO "OF N" WHILE THE TOTAL IS STILL MOVING.
    const read = () => p.evaluate(() => {
      const d = document.getElementById('cartonLabelFrame').contentDocument;
      const pages = [...d.querySelectorAll('.lbl-page')];
      return {
        n: pages.length,
        ctn: pages.map(e => e.querySelector('.ctn')?.textContent.replace(/\s+/g, ' ').trim() || ''),
        lbl: pages.map(e => e.querySelector('.lbl')?.textContent.trim() || ''),
        codes: pages.map(e => e.querySelector('svg.bc')?.getAttribute('data-code') || ''),
        bars: pages.map(e => e.querySelectorAll('svg.bc rect').length),
        qty: pages.map(e => e.querySelector('.qty')?.textContent.replace(/\s+/g, ' ').trim() || ''),
        pend: pages.map(e => !!e.querySelector('.pend')),
        cust: pages.map(e => e.querySelector('.ref-cust')?.textContent.trim() || ''),
      };
    });
    // (read() is used after the pre-print run below.)

    // ── 2. THE PRE-PRINT RUN.
    const btnThere = await p.isVisible('#preprintCartonLabelsBtn').catch(() => false);
    ok(btnThere, 'the 🏷×N pre-print button is on the carton bar');
    if (btnThere) {
      const box = await p.locator('#preprintCartonLabelsBtn').boundingBox();
      ok(box && box.x >= 0 && box.x + box.width <= vp.width + 1,
         `and is fully on screen at ${vp.width}px (x=${Math.round(box?.x)}..${Math.round(box?.x + box?.width)})`);
      const before = await p.evaluate(() => window.__printed);
      await p.click('#preprintCartonLabelsBtn');
      await p.waitForTimeout(2500);
      ok(/how many/i.test(asked), `it ASKS how many rather than guessing ("${asked.split('\n')[0]}")`);
      ok(/02 onwards|numbered 02/i.test(asked), 'and says which numbers it will print, starting after the box that exists');
      ok(/nothing is counted or created|only prints paper/i.test(asked),
         'and says plainly that it creates nothing — this is paper only');
      ok(await p.evaluate(w => window.__printed) > before, 'the run reached the print dialog');

      r = await read();
      ok(r.n === 3, `three labels were asked for and three were rendered (${r.n})`);
      ok(r.lbl.join('|') === `${ORD}-02|${ORD}-03|${ORD}-04`,
         `numbered sequentially from the next real box: ${r.lbl.join(', ')}`);
      ok(r.codes.join('|') === r.lbl.join('|'), 'each barcode encodes ITS OWN carton id, not the order number');
      ok(r.bars.every(n => n > 10), `and every barcode actually rendered (${r.bars.join('/')} bars)`);
      ok(r.ctn.every(t => !/\bOF\b/.test(t)), `none of them claims a total (${r.ctn.join(' | ')})`);
      ok(r.qty.every(t => /\b0 pcs in this carton\b/.test(t)),
         'each is blank — a box that does not exist yet holds nothing');
      ok(r.pend.every(Boolean), 'and each says to reprint it with 🏷 once its box is packed');
      ok(r.cust.every(c => c && c === r.cust[0]), `every label carries the customer (${r.cust[0]})`);

      // Page breaks, or three labels come out on one sheet.
      const breaks = await p.evaluate(() => {
        const d = document.getElementById('cartonLabelFrame').contentDocument;
        return [...d.querySelectorAll('.lbl-page')].map(e => getComputedStyle(e).pageBreakAfter);
      });
      ok(breaks.slice(0, 2).every(v => v === 'always'), `one label per page (${breaks.join(', ')})`);

      // ── 3. IT CREATED NOTHING. The whole point: a label that ends up unused
      // is torn up and leaves no phantom carton on the order.
      const cnt = await p.evaluate(async (o) => {
        const r = await fetch(`/api/scan/carton-slip/${o}`, { headers: { 'x-auth-token': localStorage.getItem('wms_token') } });
        return (await r.json()).cartonCount;
      }, ORD);
      ok(cnt === 1, `the order still has exactly ONE carton — printing created nothing (${cnt})`);
    }
    await ctx.close();
  }

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
