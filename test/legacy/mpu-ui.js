// The multi-device toggle on the REAL onboarding screen: Administrator →
// Onboard Client → ChaseCo → Portal logins. Flip it on, sign two portal
// devices in, watch the row read "● in use ×2", flip it back off (asks
// first) and watch both devices die.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4636';
const CL = 'ChaseCo', UID = 'pu-demo', PW = 'pudemo1';
const pLogin = () => fetch(`${B}/api/portal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client: CL, user: UID, password: PW }) });

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 200)));
  p.on('dialog', d => d.accept().catch(() => {}));

  await p.goto(B); await p.waitForTimeout(1200);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(2800);
  // Administrator panel is password-gated once per session.
  await p.evaluate(() => document.getElementById('adminBtn')?.click() || document.querySelector('[data-tab="admin"]')?.click()
    || [...document.querySelectorAll('button')].find(x => /administrator/i.test(x.textContent))?.click());
  await p.waitForTimeout(800);
  if (await p.isVisible('#logPasswordOverlay').catch(() => false)) {
    await p.fill('#logPasswordInput', '201432547E');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(1200);
  }
  await p.evaluate(() => document.querySelector('[data-admin-tab="onboarding"]')?.click());
  await p.waitForTimeout(1500);
  await p.evaluate((cl) => {
    [...document.querySelectorAll('#obClientList .user-row')].find(r => r.dataset.client === cl)?.click();
  }, CL);
  await p.waitForTimeout(2000);

  // ── THE DROPDOWN IS THERE, defaulting to one-at-a-time.
  const sel0 = await p.evaluate((uid) => {
    const s = document.querySelector(`.ob-user-multi[data-id="${uid}"]`);
    return s ? { val: s.value, opts: [...s.options].map(o => o.textContent) } : null;
  }, UID);
  ok(!!sel0, 'the per-login device dropdown renders on the Portal logins row');
  ok(sel0?.val === '', `defaulting to one device at a time (${JSON.stringify(sel0?.opts)})`);

  // ── FLIP IT ON from the screen.
  await p.selectOption(`.ob-user-multi[data-id="${UID}"]`, '1');
  await p.waitForTimeout(1500);
  const msg1 = await p.evaluate(() => document.getElementById('obUserMsg')?.textContent || '');
  ok(/several devices/i.test(msg1), `the save is confirmed in words ("${msg1.trim()}")`);

  // ── TWO DEVICES SIGN IN; the row says so.
  const r1 = await pLogin(); const r2 = await pLogin();
  ok(r1.status === 200 && r2.status === 200, 'two portal devices sign in together');
  await p.evaluate(() => document.querySelectorAll('.ob-user-vis')[0]);   // no-op; ensure page alive
  // reload the panel to pick up the live count
  await p.evaluate((cl) => {
    [...document.querySelectorAll('#obClientList .user-row')].find(r => r.dataset.client === cl)?.click();
  }, CL);
  await p.waitForTimeout(1800);
  const pill = await p.evaluate(() => {
    const el = [...document.querySelectorAll('#obUserList .cs-pill.ok')].find(x => /in use/.test(x.textContent));
    return el ? el.textContent.trim() : '';
  });
  ok(/×2/.test(pill), `the row counts the devices ("${pill}")`);
  await p.screenshot({ path: __dirname + '/mpu-row.png', clip: { x: 0, y: 0, width: 1400, height: 700 } });

  // ── FLIP IT BACK OFF (asks first; auto-accepted) — both devices die.
  const t1 = (await r1.json()).token, t2 = (await r2.json()).token;
  await p.selectOption(`.ob-user-multi[data-id="${UID}"]`, '');
  await p.waitForTimeout(1800);
  const m1 = await fetch(`${B}/api/portal/me`, { headers: { 'x-auth-token': t1 } });
  const m2 = await fetch(`${B}/api/portal/me`, { headers: { 'x-auth-token': t2 } });
  ok(m1.status === 401 && m2.status === 401, 'switching back off signs both devices out');

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
