// EVERY box's label reaches the printer, not just the first one.
//
// Reported from the floor (Yvonne, betime): "after scanned, only the 1st
// carton label can be printed, subsequent label unable to print". Two causes:
// nothing ever prompted the NEWLY OPENED carton (the flow only prompted the
// carton being closed, which was already labelled), and the print iframe was
// rewritten rather than recreated, gambling on `load` re-firing.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const ORD = '24944949';

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 200)));
  p.on('dialog', d => d.accept().catch(() => {}));   // the under-scanned split confirm
  // Count every print that actually fires, and remember which label fired it.
  await ctx.addInitScript(() => {
    window.__prints = [];
    window.print = function () {
      try { window.top.__prints.push(document.title || ''); } catch (e) {}
    };
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
  await p.waitForTimeout(3500);

  // ── CARTON 1: auto-printed at order-open, prompt closes itself.
  let prints = await p.evaluate(() => window.__prints);
  ok(prints.length === 1 && /-01$/.test(prints[0]), `carton 1's label printed itself on open (${JSON.stringify(prints)})`);
  ok(!(await p.evaluate(() => { const o = document.getElementById('cartonLabelOverlay'); return o && !o.classList.contains('hidden'); })),
     'and its prompt closed itself — printing is the confirmation');

  // Put a piece in carton 1 so + New Carton is legal (it refuses an empty box).
  await p.click('#itemScanInput');
  await p.keyboard.type('K4925', { delay: 15 });
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1500);

  // ── + NEW CARTON: the NEW box's label must print the moment it is opened —
  // this is the exact case the floor reported as unable to print.
  await p.click('#newCartonBtn');
  await p.waitForTimeout(2500);
  prints = await p.evaluate(() => window.__prints);
  ok(prints.length === 2, `opening carton 2 printed its label too (${prints.length} prints: ${JSON.stringify(prints)})`);
  ok(/-02$/.test(prints[1] || ''), `and it is carton 2's OWN label (${prints[1]})`);
  ok(!(await p.evaluate(() => { const o = document.getElementById('cartonLabelOverlay'); return o && !o.classList.contains('hidden'); })),
     'its prompt closed itself as well');
  const badge = await p.evaluate(() => document.getElementById('scanCartonNum')?.textContent);
  ok(badge === '2', `the packer is now in carton 2 (badge reads ${badge})`);

  // ── A THIRD BOX, for the frame-reuse gamble: three prints through the SAME
  // page session, each from a freshly created frame.
  await p.click('#itemScanInput');
  await p.keyboard.type('K5008', { delay: 15 });
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1500);
  await p.click('#newCartonBtn');
  await p.waitForTimeout(2500);
  prints = await p.evaluate(() => window.__prints);
  ok(prints.length === 3 && /-03$/.test(prints[2] || ''),
     `a third box prints as well — no decay after the first (${JSON.stringify(prints)})`);
  // The page legitimately holds other frames (the label lightbox) — count
  // only the print frame itself.
  ok((await p.evaluate(() => document.querySelectorAll('#cartonLabelFrame').length)) === 1,
     'and the page still holds ONE print frame, not one per label');

  // ── 🏷 REPRINT still works after all that.
  await p.click('#printCartonLabelBtn');
  await p.waitForTimeout(1800);
  prints = await p.evaluate(() => window.__prints);
  ok(prints.length === 4, `the 🏷 reprint fires a fourth print (${prints.length})`);

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
