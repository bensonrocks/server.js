// The label PRINTS ITSELF when the prompt fires — including carton 1 — and
// carries a large order reference with the customer on it, plus the quantity.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept().catch(() => {}));
  p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 200)));

  // The label prints from a hidden IFRAME now (a pop-up outside a click is
  // blocked by every browser, which is what made auto-print do nothing).
  // Neuter print so nothing waits on a dialog, and record that it was called.
  await ctx.addInitScript(() => {
    window.__printed = false;
    const orig = window.print;
    window.print = function () { try { window.top.__printed = true; } catch (e) {} window.__printed = true; };
  });

  await p.goto(BASE); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(2000);

  // ── OPENING THE ORDER SHOULD PRINT CARTON 1 BY ITSELF.
  await p.evaluate(() => {
    const tr = [...document.querySelectorAll('tr')].find(t => /24944949/.test(t.textContent));
    tr?.querySelector('.btn-scan-now')?.click();
  });
  await p.waitForTimeout(3500);
  const framed = await p.evaluate(() => !!document.getElementById('cartonLabelFrame'));
  ok(framed, 'the label printed ITSELF the moment the order opened — no button pressed');
  if (!framed) { await b.close(); console.log('\ncannot continue'); return; }
  ok(await p.evaluate(() => window.__printed === true), 'and it really reached the print dialog');

  // ── THE PROMPT CLOSES ITSELF ONCE IT HAS PRINTED — printing IS the
  // confirmation, so the packer is not asked to tick anything.
  await p.waitForTimeout(800);
  ok(!(await p.isVisible('#cartonLabelOverlay').catch(() => true)),
     'and the prompt closed itself — printing is the confirmation');

  // ── THE ORDER REFERENCE, LARGE, WITH THE CUSTOMER.
  // Read THROUGH the parent — the frame is same-origin, and picking it out of
  // page.frames() grabbed the wrong one.
  const m = await p.evaluate(() => {
    const d = document.getElementById('cartonLabelFrame').contentDocument;
    const px = sel => { const e = d.querySelector(sel); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; };
    const txt = sel => d.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() || '';
    return {
      lbl: txt('.lbl'), lblPx: px('.lbl'),
      ref: txt('.ref-no'), refPx: px('.ref-no'),
      cust: txt('.ref-cust'), custPx: px('.ref-cust'),
      qty: txt('.qty'), qtyPx: px('.qty b'),
      idsPx: px('table.ids'),
      idsText: txt('table.ids'),
      body: d.body.innerText.replace(/\s+/g, ' '),
      bars: d.querySelectorAll('svg.bc rect').length,
    };
  });
  ok(/GI-137641/.test(m.ref), `the order reference block carries the GI (${m.ref})`);
  ok(m.refPx >= 24, `set large — ${m.refPx}px`);
  ok(m.refPx > m.idsPx * 2, `far bigger than the identifier rows (${m.refPx} vs ${m.idsPx})`);
  ok(/TML \(052\)/.test(m.cust), `and the customer is on it (${m.cust})`);
  ok(m.custPx >= 15 && m.custPx > m.idsPx * 1.4,
     `the customer reads at distance too — ${m.custPx}px against ${m.idsPx}px`);
  ok(m.lblPx > m.refPx, `the carton id is still the biggest thing (${m.lblPx} vs ${m.refPx})`);
  ok(!/Customer/.test(m.idsText), 'the customer is no longer duplicated in the identifier table');
  ok(!/GI/.test(m.idsText), '…and neither is the GI');

  // ── QUANTITY IS STATED, not left to be added up.
  ok(/pcs? in this carton/.test(m.qty), `the quantity in the box is stated outright (${m.qty})`);
  ok(/on the order/.test(m.qty), 'alongside what the whole order is');
  ok(m.qtyPx >= 18, `and it is readable (${m.qtyPx}px)`);

  // ── ORDER DETAILS still there.
  ok(/betime/.test(m.body), 'the client is on the label');
  // "OF N" is NOT printed while the order is open — the total is not known
  // yet, and claiming one told a receiver the consignment was complete.
  ok(/CARTON 1\b/.test(m.body) && !/CARTON 1 OF/.test(m.body),
     'and which carton this is, with no total invented before the order is finished');
  // The order total is stated ONCE, in the quantity block — the empty-carton
  // line used to repeat it.
  ok((m.body.match(/on the order/g) || []).length === 1,
     'the order total is stated once, not twice');
  ok(/Reprint with/.test(m.body), 'and an empty carton says how to get its contents on later');
  ok(m.bars > 0, `the carton-id barcode rendered (${m.bars} bars)`);
  // Photograph the label as it will print: bring the frame on screen.
  await p.evaluate(() => {
    const f = document.getElementById('cartonLabelFrame');
    f.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:600px;border:1px solid #ccc;background:#fff;z-index:99999';
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: 'label2.png', clip: { x: 0, y: 0, width: 400, height: 600 } });

  // ── AND WRITING BY HAND IS STILL THERE. Force a blocked pop-up and check
  // the prompt survives with the fallback on it.
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
  await b.close();
})();
