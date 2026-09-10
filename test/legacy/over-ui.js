const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636';
// RESET THROUGH THE API, never by writing db.json under a running server —
// it holds the db in memory and the write is simply ignored (this cost a run).
// One active device per user, so re-authenticate each time the browser has
// taken the session.
const reseed = async () => {
  const T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  for (const sku of ['ABC', 'DEF', 'NOTONPO']) {
    await fetch(BASE + '/api/inbound/over-test/setqty', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': '201432547E' },
      body: JSON.stringify({ sku, qty: 0, reason: 'test reset' }) });
  }
};
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, vp] of [['Pixel 5', { width: 393, height: 851 }], ['desktop', { width: 1440, height: 950 }]]) {
    await reseed();
    const p = await (await b.newContext({ viewport: vp })).newPage();
    p.on('dialog', d => d.accept().catch(() => {}));
    await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(3500);
    await p.evaluate(() => document.querySelector('[data-tab="inbound"]')?.click());
    await p.waitForTimeout(2500);
    // Open the receiving screen for the seeded PO specifically — the list also
    // holds a return, and the first Receive button is not necessarily ours.
    await p.evaluate(() => {
      const row = [...document.querySelectorAll('tr')].find(t => /IB-OVER-01/.test(t.textContent));
      [...(row?.querySelectorAll('button') || [])].find(x => /receive/i.test(x.textContent))?.click();
    });
    await p.waitForTimeout(2000);
    // The mandatory carton-label prompt blocks scanning by design. Confirm it
    // the way a receiver would, then carry on.
    if (await p.isVisible('#cartonLabelOverlay').catch(() => false)) {
      await p.evaluate(() => [...document.querySelectorAll('#cartonLabelOverlay button')]
        .find(b => /written/i.test(b.textContent))?.click());
      await p.waitForTimeout(700);
    }
    const open = await p.evaluate(() => !!document.getElementById('inboundScanInput'));
    ok(open, `[${label}] the receiving screen opened`);
    if (!open) { await p.screenshot({ path: `over-fail-${vp.width}.png` }); continue; }

    const scan = async v => {
      await p.click('#inboundScanInput');
      await p.fill('#inboundScanInput', '');
      await p.type('#inboundScanInput', v, { delay: 15 });
      await p.keyboard.press('Enter');
      await p.waitForTimeout(1200);
    };
    const fb = () => p.evaluate(() => {
      const e = document.querySelector('.scan-feedback:not(.hidden)');
      return e ? { text: e.textContent.trim(), cls: e.className, bg: getComputedStyle(e).backgroundColor } : null;
    });

    for (let i = 0; i < 3; i++) await scan('ABC');
    let f = await fb();
    ok(f && !/MORE THAN EXPECTED/i.test(f.text), `[${label}] three of three says nothing about an overage (${f?.text?.slice(0, 50)})`);

    await scan('ABC');
    f = await fb();
    ok(!!f && /MORE THAN EXPECTED/i.test(f.text), `[${label}] the fourth warns loudly (${f?.text?.slice(0, 70)})`);
    ok(!!f && /4 received against 3/.test(f.text), `[${label}] with both numbers, not just "too many"`);
    ok(!!f && /Counted/.test(f.text), `[${label}] and says the piece was still counted`);
    ok(!!f && /error/.test(f.cls), `[${label}] styled as a warning, not a success`);

    // The count on screen really did go up — the warning is not a refusal.
    const row = await p.evaluate(() => {
      const tr = [...document.querySelectorAll('#inboundItemsTbody tr')].find(t => /ABC/.test(t.textContent));
      // The Received cell is an INPUT (it is editable until End Receipt), so
      // its value is not in textContent — read the control, not the text.
      return tr ? { got: tr.querySelector('input')?.value || '', cls: tr.className,
                    pill: tr.querySelector('.inb-over-pill')?.textContent?.trim() || '' } : null;
    });
    ok(row?.got === '4', `[${label}] the line shows 4 received — the warning did not refuse it (${row?.got})`);
    ok(!!row && /inb-over/.test(row.cls || ''), `[${label}] and the row itself reads as over, not as done`);
    ok(row?.pill === '+1 over', `[${label}] with a "+1 over" pill on the SKU (${row?.pill})`);

    // A fifth is a quieter note.
    await scan('ABC');
    f = await fb();
    ok(!!f && /2 over the expected 3/.test(f.text) && !/MORE THAN EXPECTED/.test(f.text),
       `[${label}] the fifth notes it without shouting again (${f?.text?.slice(0, 60)})`);

    await p.screenshot({ path: `over-${vp.width}.png` });
  }
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
