const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636', MK = '201432547E';
const J = async (p, o = {}) => (await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-master-key': MK, ...(o.headers || {}) } })).json();
(async () => {
  await J('/api/master/client-profiles/VisCo/portal-users', { method: 'POST',
    body: JSON.stringify({ id: 'vera', visibility: { overview: true, stock: true, orders: true, inbound: true, send: true, reports: true } }) });
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
  p.on('dialog', d => d.accept().catch(() => {}));
  await p.goto(BASE); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.getElementById('logAccessBtn')?.click()); await p.waitForTimeout(800);
  if (await p.isVisible('#logPasswordOverlay').catch(() => false)) {
    await p.fill('#logPasswordInput', MK); await p.click('#logPasswordSubmitBtn'); await p.waitForTimeout(2000); }
  await p.evaluate(() => document.querySelector('[data-admin-tab="onboarding"]')?.click()); await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector('#obClientList [data-client="VisCo"]')?.click()); await p.waitForTimeout(1800);
  await p.evaluate(() => document.querySelector('#obUserList .ob-user-vis[data-id="vera"]')?.click()); await p.waitForTimeout(500);

  const reps = await p.evaluate(() => [...document.querySelectorAll('#obUserList .ob-vis-rep[data-for="vera"]')]
    .map(c => ({ key: c.dataset.key, on: c.checked, disabled: c.disabled,
                 label: c.closest('label')?.querySelector('b')?.textContent?.trim() })));
  ok(reps.length === 3, `three report ticks nested under Reports (${reps.length})`);
  ok(!reps.some(r => /can ship/i.test(r.label || '')), 'and "What can ship" is not among them');
  ok(reps.every(r => r.on && !r.disabled), 'all on and editable while Reports is on');
  ok(reps.every(r => r.label), `each named (${reps.map(r => r.label).join(', ')})`);

  // Switching Reports OFF greys the nested block — ticking a report that
  // cannot apply is a configuration nobody can reason about later.
  await p.evaluate(() => {
    const m = document.querySelector('#obUserList .ob-vis[data-for="vera"][data-key="reports"]');
    m.checked = false; m.dispatchEvent(new Event('change'));
  });
  await p.waitForTimeout(400);
  ok(await p.evaluate(() => [...document.querySelectorAll('#obUserList .ob-vis-rep[data-for="vera"]')].every(c => c.disabled)),
     'Reports off disables the individual ticks');
  await p.evaluate(() => {
    const m = document.querySelector('#obUserList .ob-vis[data-for="vera"][data-key="reports"]');
    m.checked = true; m.dispatchEvent(new Event('change'));
  });
  await p.waitForTimeout(400);

  // Switch off one report and save.
  await p.evaluate(() => { document.querySelector('#obUserList .ob-vis-rep[data-for="vera"][data-key="report_orders"]').checked = false; });
  await p.evaluate(() => document.querySelector('#obUserList .ob-vis-save[data-id="vera"]').click());
  await p.waitForTimeout(2000);
  const stored = (await J('/api/master/client-profiles/VisCo/portal-users')).users.find(u => u.id === 'vera').visibility;
  ok(stored.report_orders === false && stored.report_stock === true && stored.reports === true,
     'the server holds exactly that — Reports on, one download off');
  ok(/no Orders & movements/.test(await p.textContent('#obUserList')),
     'and the row says which report went, without opening the panel');
  await p.screenshot({ path: 'reps-office.png' });

  // The client's own screen: that button is gone, the others stay.
  const p2 = await (await b.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  await p2.goto(BASE + '/portal'); await p2.waitForTimeout(1200);
  await p2.fill('#liClient', 'VisCo');
  if (await p2.isVisible('#liUser').catch(() => false)) await p2.fill('#liUser', 'vera');
  await p2.fill('#liPass', 'visco123');
  await p2.click('#liBtn'); await p2.waitForTimeout(3500);
  const btns = await p2.evaluate(() => ({
    orders: !document.getElementById('orExport')?.classList.contains('hidden'),
    stock: !document.getElementById('stExport')?.classList.contains('hidden'),
    inbound: !document.getElementById('ibExport')?.classList.contains('hidden'),
  }));
  ok(btns.orders === false, 'the client no longer has the Orders report button');
  ok(btns.stock && btns.inbound, 'while Stock and Inbound are still there');
  await p2.evaluate(() => fetch('/api/portal/logout', { method: 'POST', headers: { 'x-auth-token': localStorage.getItem('portal_token') } }));
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
