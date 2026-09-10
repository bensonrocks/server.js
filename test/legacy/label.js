// The carton label is PRINTED, not written. Drive a real pick and photograph
// both the prompt and the label that comes out of it.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept().catch(() => {}));
  p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 220)));
  p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 200)); });
  await p.goto(BASE); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(2000);
  // Open the seeded order.
  await p.evaluate(() => {
    const tr = [...document.querySelectorAll('tr')].find(t => /24944949/.test(t.textContent));
    tr?.querySelector('.btn-scan-now')?.click();
  });
  await p.waitForTimeout(2500);

  // ── THE PROMPT NOW OFFERS A PRINT.
  const shown = await p.isVisible('#cartonLabelOverlay').catch(() => false);
  ok(shown, 'the carton-label prompt opens the moment the order does');
  const prompt = await p.evaluate(() => ({
    label: document.getElementById('cartonLabelText')?.textContent?.trim(),
    desc: document.querySelector('#cartonLabelOverlay .modal-desc')?.textContent?.trim(),
    print: !!document.getElementById('cartonLabelPrintBtn'),
    hand: document.getElementById('cartonLabelConfirmBtn')?.textContent?.trim(),
  }));
  ok(prompt.label === '24944949-01', `it names the carton (${prompt.label})`);
  ok(prompt.print, 'and offers to PRINT it');
  ok(/stick it on/i.test(prompt.desc || ''), `the wording is print-first (${prompt.desc})`);
  ok(/hand/i.test(prompt.hand || ''), `with writing kept as the fallback (${prompt.hand})`);
  await p.screenshot({ path: 'label-prompt.png' });

  // ── PRINTING PRODUCES THE LABEL — capture the popup instead of printing.
  const popupP = ctx.waitForEvent('page', { timeout: 15000 });
  await p.evaluate(() => document.getElementById('cartonLabelPrintBtn').click());
  const lab = await popupP;
  await lab.waitForLoadState('domcontentloaded');
  await lab.addStyleTag({ content: '@media print { .hint { display: block } }' }).catch(() => {});
  await lab.waitForTimeout(1200);
  const text = await lab.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ok(/24944949-01/.test(text), 'the label leads with the carton id');
  ok(/CARTON 1\b/.test(text) && !/CARTON 1 OF/.test(text),
     `and says which carton this is, without claiming a total before the order is done (${(text.match(/CARTON[^·]*/) || [''])[0].trim()})`);
  ok(/betime/.test(text), 'the client is on it');
  ok(/TML \(052\)/.test(text), 'so is the customer');
  // ── THE CUSTOMER NAME IS READ AT ARM'S LENGTH, not out of a table row.
  const cust = await lab.evaluate(() => {
    const e = document.querySelector('.cust');
    if (!e) return null;
    const s = getComputedStyle(e);
    const ids = document.querySelector('table.ids');
    return { text: e.textContent.replace(/\s+/g, ' ').trim(),
             px: parseFloat(s.fontSize), weight: s.fontWeight,
             idsPx: ids ? parseFloat(getComputedStyle(ids).fontSize) : 0,
             inIdTable: /Customer/.test(ids?.textContent || '') };
  });
  ok(!!cust, 'the customer has its own block on the label');
  ok(cust && /TML \(052\)/.test(cust.text), `carrying the name (${cust?.text})`);
  ok(cust && cust.px >= 20, `set large — ${cust?.px}px against ${cust?.idsPx}px for the identifier rows`);
  ok(cust && cust.px > cust.idsPx * 1.6, 'clearly bigger than the identifiers, not just a nudge');
  ok(cust && Number(cust.weight) >= 700, `and bold (${cust?.weight})`);
  ok(cust && !cust.inIdTable, 'and is no longer duplicated as a row in the identifier table');
  ok(/GI-137641/.test(text), 'and the GI number — the identifier actually on the paperwork');
  // AT CARTON 1 THE BOX IS EMPTY — the label goes on before packing, so there
  // is nothing to list. It says how much the order is instead.
  ok(/\d+ pcs? on this order/.test(text),
     `an empty carton states the order total, not an empty table (${text.slice(0, 160)})`);
  ok(!/Nothing scanned/.test(text), 'and does not print an empty contents table');
  ok(await lab.evaluate(() => !!document.querySelector('#bc rect')),
     'and the carton id is a real barcode, not just text');
  const bcValue = await lab.evaluate(() => document.querySelector('#bc')?.getAttribute('jsbarcode-value')
    || document.querySelector('#bc text')?.textContent || '');
  ok(/24944949-01/.test(bcValue), `the BARCODE is the carton id, not the order number (${bcValue})`);
  await lab.screenshot({ path: 'label-print.png', fullPage: true });

  // ── PRINTING COUNTS AS LABELLING — the prompt is gone and scanning is free.
  await p.waitForTimeout(800);
  ok(!(await p.isVisible('#cartonLabelOverlay').catch(() => false)),
     'printing dismisses the prompt — no second tick to mean nothing');
  ok(await p.evaluate(() => !!document.getElementById('itemScanInput')),
     'and the packer is straight into scanning');
  await lab.close();
  await p.screenshot({ path: 'label-after.png' });

  // ── PACK MOST OF THE BOX, THEN REPRINT: now the contents are on it.
  // Deliberately NOT all six — scanning the last piece auto-completes the
  // order and closes the scan overlay, taking the carton bar with it. Mid-pack
  // is also when a packer would actually reach for a reprint.
  for (const [sku, n] of [['K4925', 3], ['K5008', 2]]) {
    for (let i = 0; i < n; i++) {
      await p.click('#itemScanInput');
      await p.fill('#itemScanInput', '');
      await p.type('#itemScanInput', sku, { delay: 15 });
      await p.keyboard.press('Enter');
      await p.waitForTimeout(600);
    }
  }
  const st = await p.evaluate(() => {
    const el = document.getElementById('printCartonLabelBtn');
    const r = el?.getBoundingClientRect();
    return { exists: !!el, disabled: el?.disabled, w: Math.round(r?.width || 0),
             overlay: document.getElementById('scanOverlay')?.className,
             scanned: document.getElementById('itemScanInput') ? 'present' : 'gone' };
  });
  ok(st.exists && st.w > 0, `the reprint button is on the carton bar (${JSON.stringify(st)})`);
  const popup2 = ctx.waitForEvent('page', { timeout: 15000 });
  await p.evaluate(() => document.getElementById('printCartonLabelBtn').click());
  const lab2 = await popup2;
  await lab2.waitForLoadState('domcontentloaded');
  await lab2.waitForTimeout(1200);
  const t2 = await lab2.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ok(/K4925/.test(t2) && /K5008/.test(t2), 'reprinting a packed carton lists what is actually in it');
  ok(/24944949-01/.test(t2), 'still the same carton id');
  ok(!/on this order . reprint/.test(t2), 'and drops the "reprint once packed" line');
  await lab2.screenshot({ path: 'label-packed.png', fullPage: true });
  await lab2.close();

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
