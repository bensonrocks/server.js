// "REFILE DOESN'T SEEM TO WORK" — reported from a phone with the reason
// reading "Wrong" (5 characters). The button only unlocks at 6, was styled
// exactly like a live button, and a disabled control swallows the tap — so
// nothing anywhere said why. This proves the fix AND that refile itself works:
//   1. with "Wrong" typed, the button is visibly dimmed and a tap on it now
//      ANSWERS ("the reason needs at least 6 characters (1 more)");
//   2. the hint under the box counts down live;
//   3. one more character unlocks it, and the refile then genuinely moves
//      the order to the other client.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const ORD = 'MP-PLAIN';   // ChaseCo, pending, untracked — safe to move

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 200)));
  p.on('dialog', d => d.accept().catch(() => {}));

  await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(1500);
  await p.evaluate((o) => {
    const tr = document.querySelector(`tr.orders-tr[data-order="${o}"]`);
    tr?.querySelector('.btn-refile-order')?.click();
  }, ORD);
  await p.waitForTimeout(2000);
  ok(await p.isVisible('#refileOrderOverlay'), 'the Refile dialog opens');

  // ── THE REPORTED STATE: client picked, reason "Wrong" (5 chars).
  await p.evaluate(() => {
    const sel = document.getElementById('refileClient');
    const opt = [...sel.options].find(o => o.value && o.value !== '');
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await p.click('#refileReason');
  await p.keyboard.type('Wrong', { delay: 20 });
  await p.waitForTimeout(400);

  const state1 = await p.evaluate(() => {
    const btn = document.getElementById('refileConfirmBtn');
    return {
      disabled: btn.disabled,
      opacity: getComputedStyle(btn).opacity,
      hint: document.getElementById('refileReasonHint')?.textContent || '',
      hintColor: getComputedStyle(document.getElementById('refileReasonHint')).color,
    };
  });
  ok(state1.disabled, 'with a 5-character reason the button is locked (the reported state)');
  ok(Number(state1.opacity) < 0.6, `and now VISIBLY locked — dimmed to ${state1.opacity}, not solid blue`);
  ok(/1 more character needed/.test(state1.hint), `the hint counts down live ("${state1.hint}")`);
  ok(/rgb\(217, 119, 6\)/.test(state1.hintColor), 'in amber, so it reads as the blocker');

  // ── TAPPING THE LOCKED BUTTON NOW ANSWERS instead of doing nothing.
  await p.evaluate(() => {
    const btn = document.getElementById('refileConfirmBtn');
    const r = btn.getBoundingClientRect();
    document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
  });
  await p.waitForTimeout(400);
  const err = await p.evaluate(() => {
    const e = document.getElementById('refileOrderError');
    return e && !e.classList.contains('hidden') ? e.textContent : '';
  });
  ok(/at least 6 characters \(1 more\)/.test(err), `a tap on the dead button explains itself ("${err}")`);
  await p.screenshot({ path: __dirname + '/refile-1-locked.png' });

  // ── ONE MORE CHARACTER UNLOCKS IT, AND THE REFILE GENUINELY WORKS.
  await p.click('#refileReason');
  await p.keyboard.press('End');
  await p.keyboard.type(' one', { delay: 20 });   // "Wrong one" — 9 chars
  await p.waitForTimeout(400);
  const state2 = await p.evaluate(() => {
    const btn = document.getElementById('refileConfirmBtn');
    return { disabled: btn.disabled, opacity: getComputedStyle(btn).opacity,
             errHidden: document.getElementById('refileOrderError').classList.contains('hidden') };
  });
  ok(!state2.disabled && Number(state2.opacity) > 0.9, `a 6+ character reason unlocks it (opacity ${state2.opacity})`);
  ok(state2.errHidden, 'and the refusal message clears');

  const dest = await p.evaluate(() => document.getElementById('refileClient').value);
  await p.click('#refileConfirmBtn');
  await p.waitForTimeout(3500);
  ok(!(await p.evaluate(() => { const o = document.getElementById('refileOrderOverlay'); return o && !o.classList.contains('hidden'); })),
     'the dialog closes on success');
  await p.waitForTimeout(2000);
  const moved = await p.evaluate((o) => {
    const tr = document.querySelector(`tr.orders-tr[data-order="${o}"]`);
    return tr ? tr.textContent.replace(/\s+/g, ' ').slice(0, 160) : '(row not found)';
  }, ORD);
  ok(moved.includes(dest), `the order now files under "${dest}" — refile itself works (${moved.slice(0, 90)})`);
  await p.screenshot({ path: __dirname + '/refile-2-moved.png' });

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
