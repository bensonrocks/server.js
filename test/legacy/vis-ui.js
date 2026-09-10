// The office sets sections per LOGIN; each person's portal carries only theirs.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const BASE = 'http://localhost:4636', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const CLIENT = 'VisCo';
const ALL = { overview: true, stock: true, orders: true, inbound: true, send: true, reports: true };
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const setVis = (id, visibility) => J(`/api/master/client-profiles/${CLIENT}/portal-users`,
  { method: 'POST', body: JSON.stringify({ id, visibility }) });

const portalIn = async (p, user, pass) => {
  await p.goto(BASE + '/portal'); await p.waitForTimeout(1200);
  await p.fill('#liClient', CLIENT);
  if (await p.isVisible('#liUser').catch(() => false)) await p.fill('#liUser', user);
  await p.fill('#liPass', pass);
  await p.click('#liBtn'); await p.waitForTimeout(3500);
};
const portalOut = p => p.evaluate(() => fetch('/api/portal/logout', { method: 'POST',
  headers: { 'x-auth-token': localStorage.getItem('portal_token') } }));

(async () => {
  // Both logins start able to see everything, so the office screen is what
  // takes things away.
  await setVis('vera', ALL);
  await J(`/api/master/client-profiles/${CLIENT}/portal-users`, { method: 'POST',
    body: JSON.stringify({ name: 'Wes', access: 'full', password: 'visco456' }) });
  await setVis('wes', ALL);

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ── THE OFFICE ──────────────────────────────────────────────────────────
  {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
    const p = await ctx.newPage();
    p.on('dialog', d => d.accept().catch(() => {}));
    await p.goto(BASE); await p.waitForTimeout(1500);
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(3000);
    await p.evaluate(() => document.getElementById('logAccessBtn')?.click());
    await p.waitForTimeout(800);
    if (await p.isVisible('#logPasswordOverlay').catch(() => false)) {
      await p.fill('#logPasswordInput', MK); await p.click('#logPasswordSubmitBtn'); await p.waitForTimeout(2000);
    }
    await p.evaluate(() => document.querySelector('[data-admin-tab="onboarding"]')?.click());
    await p.waitForTimeout(1200);
    await p.evaluate(c => document.querySelector(`#obClientList [data-client="${c}"]`)?.click(), CLIENT);
    await p.waitForTimeout(1800);

    // EVERY LOGIN HAS ITS OWN PANEL — that is the whole change.
    const panels = await p.evaluate(() => [...document.querySelectorAll('#obUserList .ob-vis-row')].map(r => r.dataset.for));
    ok(panels.includes('vera') && panels.includes('wes'),
       `each login has its own sections panel (${panels.join(',')})`);
    ok(await p.evaluate(() => !document.querySelector('#obUserList .ob-vis-row:not(.hidden)')),
       'closed until asked for — the table stays readable');
    ok(await p.evaluate(() => document.querySelectorAll('#obUserList .ob-user-vis').length) === panels.length,
       'and a 👁 button on every row to open it');
    ok(!(await p.evaluate(() => !!document.getElementById('obVisList'))),
       'the old one-per-client block is gone');

    // Open Vera's, untick Reports and Send, save.
    await p.evaluate(() => document.querySelector('#obUserList .ob-user-vis[data-id="vera"]').click());
    await p.waitForTimeout(400);
    ok(await p.evaluate(() => !document.querySelector('#obUserList .ob-vis-row[data-for="vera"]').classList.contains('hidden')),
       'the 👁 button opens that login\'s panel');
    ok(await p.evaluate(() => document.querySelector('#obUserList .ob-vis-row[data-for="wes"]').classList.contains('hidden')),
       '…and only that one');
    const ticks = await p.evaluate(() => [...document.querySelectorAll('#obUserList .ob-vis[data-for="vera"]')]
      .map(c => ({ key: c.dataset.key, on: c.checked,
                   label: c.closest('label')?.querySelector('b')?.textContent?.trim() || '',
                   hint: c.closest('label')?.querySelector('.hint')?.textContent?.trim() || '' })));
    ok(ticks.length === 6, `six sections on the panel (${ticks.length})`);
    ok(ticks.every(t => t.on), 'all ticked — nothing has been taken from her');
    ok(ticks.every(t => t.label && t.hint), 'each says what it is and what is inside it');

    await p.evaluate(() => { for (const k of ['reports', 'send'])
      document.querySelector(`#obUserList .ob-vis[data-for="vera"][data-key="${k}"]`).checked = false; });
    await p.evaluate(() => document.querySelector('#obUserList .ob-vis-save[data-id="vera"]').click());
    await p.waitForTimeout(2000);
    ok(/2 section\(s\) switched off for Vera/.test(await p.textContent('#obUserList .ob-vis-msg[data-for="vera"]')),
       'saving names the person and what went, not just "saved"');
    let stored = (await J(`/api/master/client-profiles/${CLIENT}/portal-users`)).body.users;
    ok(stored.find(u => u.id === 'vera').visibility.reports === false, 'the server holds exactly that for Vera');
    ok(stored.find(u => u.id === 'wes').visibility.reports === true,
       'and Wes on the same client is untouched — this is per login');
    ok(/no Reports/.test(await p.textContent('#obUserList')),
       'the table itself says who has had something taken away, without opening a panel');

    // A configuration leaving nothing to look at is refused ON SCREEN.
    await p.evaluate(() => { for (const k of ['overview', 'stock', 'orders', 'inbound'])
      document.querySelector(`#obUserList .ob-vis[data-for="vera"][data-key="${k}"]`).checked = false; });
    await p.evaluate(() => document.querySelector('#obUserList .ob-vis-save[data-id="vera"]').click());
    await p.waitForTimeout(2000);
    ok(/at least one/i.test(await p.textContent('#obUserList .ob-vis-msg[data-for="vera"]')),
       'switching everything off for a login is refused on screen, with what to do about it');
    stored = (await J(`/api/master/client-profiles/${CLIENT}/portal-users`)).body.users;
    ok(stored.find(u => u.id === 'vera').visibility.orders === true, 'and nothing was changed by the refusal');
    ok(await p.evaluate(() => document.querySelector('#obUserList .ob-vis[data-for="vera"][data-key="orders"]').checked === true),
       'the ticks show what is really stored, not the refused configuration');
    await p.screenshot({ path: 'vis-office.png', fullPage: false });
    await ctx.close();
  }

  // ── THE TWO CLIENTS' OWN SCREENS ────────────────────────────────────────
  // Wes is the finance contact: Reports, no Inbound.
  await setVis('wes', { ...ALL, inbound: false });
  for (const [label, vp] of [['desktop', { width: 1280, height: 900 }], ['Pixel 5', { width: 393, height: 851 }]]) {
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    p.on('dialog', d => d.accept().catch(() => {}));

    // VERA — no Reports, no Send.
    await portalIn(p, 'vera', 'visco123');
    let shown = await p.evaluate(() => [...document.querySelectorAll('nav button')]
      .filter(x => x.offsetWidth || x.offsetHeight).map(x => x.dataset.tab));
    ok(!shown.includes('send'), `[${label}] Vera has no Send tab (${shown.join(',')})`);
    ok(shown.includes('inbound') && shown.includes('stock'), `[${label}] and still has Inbound and Stock`);
    const veraReps = await p.evaluate(() => ['stExport', 'orExport', 'orFulfilExport', 'ibExport']
      .filter(id => { const e = document.getElementById(id); return e && !e.classList.contains('hidden'); }));
    ok(!veraReps.length, `[${label}] and no Report button anywhere (${veraReps.join(',') || 'none left'})`);
    let refused = await p.evaluate(async () => {
      const r = await fetch('/api/portal/export/orders', { headers: { 'x-auth-token': localStorage.getItem('portal_token') } });
      return { s: r.status, b: await r.json().catch(() => ({})) };
    });
    ok(refused.s === 403 && /not switched on/i.test(refused.b?.error || ''),
       `[${label}] and the download is refused server-side, in words (${refused.s})`);
    ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1,
       `[${label}] no sideways scroll`);
    await p.screenshot({ path: `vis-portal-vera-${vp.width}.png`, fullPage: false });
    await portalOut(p);

    // WES — the SAME client, a different set. This is the point of the change.
    await p.evaluate(() => localStorage.clear());
    await portalIn(p, 'wes', 'visco456');
    shown = await p.evaluate(() => [...document.querySelectorAll('nav button')]
      .filter(x => x.offsetWidth || x.offsetHeight).map(x => x.dataset.tab));
    ok(!shown.includes('inbound'), `[${label}] Wes has no Inbound tab (${shown.join(',')})`);
    ok(shown.includes('send'), `[${label}] but he does have Send, which Vera does not`);
    ok(await p.evaluate(() => { const e = document.getElementById('orExport'); return !!e && !e.classList.contains('hidden'); }),
       `[${label}] and his Report buttons are there, on the same client Vera cannot download from`);
    refused = await p.evaluate(async () => {
      const r = await fetch('/api/portal/inbound', { headers: { 'x-auth-token': localStorage.getItem('portal_token') } });
      return r.status;
    });
    ok(refused === 403, `[${label}] his Inbound is refused server-side too (${refused})`);
    await p.screenshot({ path: `vis-portal-wes-${vp.width}.png`, fullPage: false });
    await portalOut(p);
    await ctx.close();
  }

  // ── PUT IT BACK: nothing was stamped on their data.
  await setVis('vera', ALL);
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await portalIn(p, 'vera', 'visco123');
    const shown = await p.evaluate(() => [...document.querySelectorAll('nav button')]
      .filter(x => x.offsetWidth || x.offsetHeight).map(x => x.dataset.tab));
    ok(shown.includes('send'), 'switching it back on returns Vera\'s tab');
    await p.evaluate(() => document.querySelector('nav button[data-tab="orders"]')?.click());
    await p.waitForTimeout(600);
    ok(await p.evaluate(() => { const e = document.getElementById('orExport'); return !!(e.offsetWidth || e.offsetHeight); }),
       'and her Report button is back on the screen');
    await portalOut(p);
    await ctx.close();
  }

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
