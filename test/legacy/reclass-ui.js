// The Reclassify flow through the REAL UI: select completed orders on the
// Orders tab, press ↺ Reclassify, choose Pending or Cancelled, type the
// reason and the password, and watch the orders move.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const OUT = __dirname;

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 160)));
  let lastAlert = '';
  p.on('dialog', d => { lastAlert = d.message(); d.accept().catch(() => {}); });

  await p.goto('http://localhost:4636'); await p.waitForTimeout(1200);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(2800);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2200);
  // The Completed list is a SUB-TAB (data-oview), not a filter chip.
  await p.evaluate(() => document.querySelector('[data-oview="completed"]')?.click());
  await p.waitForTimeout(1800);

  // ── SELECT the two completed RC orders.
  const ticked = await p.evaluate(() => {
    let n = 0;
    for (const cb of document.querySelectorAll('.ord-select')) {
      if (/^RC-ORD-[12]$/.test(cb.dataset.order || '')) { cb.click(); n++; }
    }
    return n;
  });
  ok(ticked === 2, `two completed orders ticked (${ticked})`);
  await p.waitForTimeout(600);
  const btnTxt = await p.evaluate(() => document.getElementById('ordersBulkReclassify')?.textContent || '');
  ok(/Reclassify \(2\)/.test(btnTxt), `the bulk bar's Reclassify button counts them ("${btnTxt.trim()}")`);
  await p.screenshot({ path: `${OUT}/rcui-1-selected.png` });

  // ── THE MODAL: names the orders, offers the two destinations, wants a
  // reason and the password.
  await p.click('#ordersBulkReclassify');
  await p.waitForTimeout(500);
  ok(await p.isVisible('#reclassifyOverlay'), 'the Reclassify dialog opens');
  const listTxt = await p.evaluate(() => document.getElementById('reclassifyList').textContent);
  ok(/RC-ORD-1/.test(listTxt) && /RC-ORD-2/.test(listTxt), `naming both orders (${listTxt.trim()})`);

  // ── A WRONG PASSWORD is refused INLINE — no reload, the reason survives.
  await p.check('input[name="reclassifyTo"][value="pending"]');
  await p.fill('#reclassifyReason', 'completed against the wrong parcels — re-pick both');
  await p.fill('#reclassifyPassword', 'not-my-password');
  await p.screenshot({ path: `${OUT}/rcui-2-modal.png` });
  await p.click('#reclassifyConfirmBtn');
  await p.waitForTimeout(1200);
  const err = await p.evaluate(() => {
    const e = document.getElementById('reclassifyError');
    return e && !e.classList.contains('hidden') ? e.textContent : '';
  });
  ok(/does not match/i.test(err), `a wrong password is refused in place (${err.slice(0, 60)}…)`);
  ok(await p.isVisible('#reclassifyOverlay'), 'the dialog stays open');
  ok(!(await p.isVisible('#loginOverlay').catch(() => false)) ||
     !(await p.evaluate(() => { const l = document.getElementById('loginOverlay'); return l && !l.classList.contains('hidden'); })),
     'and the session was NOT torn down — 403, never 401');
  const keptReason = await p.evaluate(() => document.getElementById('reclassifyReason').value);
  ok(/re-pick both/.test(keptReason), 'the typed reason survives for the retry');
  await p.screenshot({ path: `${OUT}/rcui-3-wrongpw.png` });

  // ── THE RIGHT PASSWORD: both orders go back to Pending.
  await p.fill('#reclassifyPassword', 'demo');
  await p.click('#reclassifyConfirmBtn');
  await p.waitForTimeout(2500);
  ok(/2 order\(s\) reclassified to Pending/.test(lastAlert), `the outcome is reported (${lastAlert.split('\n')[0]})`);
  ok(/unit\(s\) returned to stock/.test(lastAlert), 'with the units returned to stock');
  ok(/bin positions are not rewritten/i.test(lastAlert), 'and the cycle-count caveat stated');
  await p.waitForTimeout(2000);

  // ── THE ORDERS ARE BACK ON THE ACTIVE LIST as pending work.
  await p.evaluate(() => document.querySelector('[data-oview="active"]')?.click());
  await p.waitForTimeout(1800);
  const states = await p.evaluate(() => {
    const out = {};
    for (const tr of document.querySelectorAll('tr')) {
      const m = (tr.textContent || '').match(/RC-ORD-([12])/);
      if (m && !out['RC-ORD-' + m[1]]) out['RC-ORD-' + m[1]] = tr.textContent.replace(/\s+/g, ' ').slice(0, 200);
    }
    return out;
  });
  ok(/pending/i.test(states['RC-ORD-1'] || ''), `RC-ORD-1 shows Pending on the list`);
  ok(/pending/i.test(states['RC-ORD-2'] || ''), `RC-ORD-2 shows Pending on the list`);
  await p.screenshot({ path: `${OUT}/rcui-4-pending.png` });

  // ── AND ONE OF THEM IS CANCELLED from the same flow.
  await p.evaluate(() => {
    for (const cb of document.querySelectorAll('.ord-select')) {
      if (cb.dataset.order === 'RC-ORD-2' && !cb.checked) cb.click();
    }
  });
  await p.waitForTimeout(500);
  // Its status is pending now, so the button goes DEAD — Reclassify is for
  // completed orders only, and a button that cannot apply should not invite
  // the click at all.
  const disabled = await p.evaluate(() => {
    const b2 = document.getElementById('ordersBulkReclassify');
    return b2 ? { disabled: b2.disabled, text: b2.textContent.trim() } : null;
  });
  ok(disabled && disabled.disabled === true,
     `with only a pending order selected the button is disabled (${JSON.stringify(disabled)})`);

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
