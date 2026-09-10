// The Inbound list has to be readable on the phone the floor works from —
// and correct for an ADMIN, whose tick column used to shift every hidden column.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, vp] of [['Pixel 5', { width: 393, height: 851 }], ['320px', { width: 320, height: 700 }], ['desktop', { width: 1440, height: 950 }]]) {
    const p = await (await b.newContext({ viewport: vp })).newPage();
    await p.goto(BASE); await p.waitForTimeout(1500);
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(3500);
    await p.evaluate(() => document.querySelector('[data-tab="inbound"]')?.click());
    await p.waitForTimeout(2500);

    const row = await p.evaluate(() => {
      const tr = document.querySelector('#inboundList tr.inb-tr');
      if (!tr) return null;
      const vis = el => !!el && !!(el.offsetWidth || el.offsetHeight);
      const q = c => tr.querySelector('.' + c);
      return {
        serial: vis(q('inb-serial')) ? q('inb-serial').textContent.trim() : '',
        status: vis(q('inb-status')) ? q('inb-status').textContent.trim() : '',
        ref:    vis(q('inb-ref')) ? q('inb-ref').textContent.trim() : '',
        sum:    vis(q('inb-mobile-sum')) ? q('inb-mobile-sum').textContent.trim() : '',
        client: vis(q('inb-client')) ? q('inb-client').textContent.trim() : '',
        items:  vis(q('inb-items')) ? q('inb-items').textContent.trim() : '',
        btn:    vis(tr.querySelector('.btn-scan-now')) ? tr.querySelector('.btn-scan-now').getBoundingClientRect() : null,
        stripe: getComputedStyle(tr).borderLeftColor,
      };
    });
    ok(!!row, `[${label}] a receipt row rendered`);
    if (!row) { await p.context().close(); continue; }

    ok(!!row.serial, `[${label}] the serial is on screen (${row.serial})`);
    ok(!!row.status, `[${label}] and so is the status (${row.status})`);

    if (vp.width <= 768) {
      // THE FACTS THE HIDDEN COLUMNS CARRIED ARE STILL THERE, in one line.
      ok(!!row.sum, `[${label}] the card carries a summary line (${row.sum})`);
      ok(/Return|PO \/ ASN/.test(row.sum), `[${label}] saying what kind of receipt it is`);
      ok(/pcs/.test(row.sum), `[${label}] and how much has been counted`);
      ok(!row.client && !row.items, `[${label}] without also repeating the real columns`);
      ok(!!row.ref, `[${label}] the reference is on the card too`);
      ok(row.stripe !== 'rgba(0, 0, 0, 0)', `[${label}] with a status stripe down the side (${row.stripe})`);
      ok(row.btn && row.btn.width > vp.width * 0.7,
         `[${label}] Receive is a full-width tap target, not an 83px stub (${Math.round(row.btn?.width || 0)}px of ${vp.width})`);
      ok(row.btn && row.btn.height >= 44, `[${label}] and tall enough for a thumb (${Math.round(row.btn?.height || 0)}px)`);
      ok(row.btn && row.btn.right <= vp.width + 1, `[${label}] fully on screen, not clipped`);
    } else {
      ok(!row.sum, `[${label}] no phone summary line on desktop — the real columns are all there`);
      ok(!!row.client, `[${label}] the Client column shows (${row.client})`);
      ok(!!row.items, `[${label}] and the Items column (${row.items})`);
    }
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(over <= 1, `[${label}] the page does not scroll sideways (${over}px)`);
    // THE CASE THAT USED TO BREAK: an admin gets a tick column, which shifted
    // every nth-child index by one. Assert the tick is really there and that
    // the card is still correct with it.
    const tick = await p.evaluate(() => {
      const t = document.querySelector('#inboundList tr.inb-tr .ib-tick input');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left) };
    });
    ok(!!tick, `[${label}] the admin tick column is present — the case the old nth-child rules got wrong`);
    if (vp.width <= 768) {
      ok(tick && tick.w >= 18 && tick.h >= 18, `[${label}] and the tick is a real tap target (${tick?.w}x${tick?.h})`);
      ok(tick && tick.left >= 0, `[${label}] not pushed off the left edge (${tick?.left}px)`);
    }
    await p.screenshot({ path: `inbmob-${vp.width}.png` });
    await p.context().close();
  }
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
