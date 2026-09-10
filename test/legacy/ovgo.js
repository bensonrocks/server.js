// Every figure on the client's Overview opens the rows behind it.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const BASE = 'http://localhost:4636', MK = '201432547E', CLIENT = 'VisCo';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ALL = { overview: true, stock: true, orders: true, inbound: true, send: true, reports: true };

(async () => {
  await J(`/api/master/client-profiles/${CLIENT}/portal-users`, { method: 'POST',
    body: JSON.stringify({ id: 'vera', visibility: ALL }) });

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, vp] of [['desktop', { width: 1280, height: 900 }], ['Pixel 5', { width: 393, height: 851 }]]) {
    const p = await (await b.newContext({ viewport: vp })).newPage();
    await p.goto(BASE + '/portal'); await p.waitForTimeout(1200);
    await p.fill('#liClient', CLIENT);
    if (await p.isVisible('#liUser').catch(() => false)) await p.fill('#liUser', 'vera');
    await p.fill('#liPass', 'visco123');
    await p.click('#liBtn'); await p.waitForTimeout(3500);

    const tiles = await p.evaluate(() => [...document.querySelectorAll('#tab-overview .tile')].map(t => ({
      label: t.querySelector('.l')?.textContent?.trim() || '',
      go: t.dataset.go || '', f: t.dataset.f || '', link: t.classList.contains('ov-go'),
      role: t.getAttribute('role') || '', tab: t.getAttribute('tabindex') })));
    ok(tiles.length === 4, `[${label}] four KPI tiles (${tiles.length})`);
    ok(tiles.every(t => t.link), `[${label}] every one of them is a link`);
    ok(tiles.every(t => t.role === 'link' && t.tab === '0'),
       `[${label}] reachable by keyboard, not mouse-only`);
    const byLabel = Object.fromEntries(tiles.map(t => [t.label, `${t.go}/${t.f}`]));
    ok(byLabel['Available'] === 'stock/all', `[${label}] Available → the stock list (${byLabel['Available']})`);
    ok(byLabel['Reserved'] === 'stock/res', `[${label}] Reserved → stock filtered to reserved (${byLabel['Reserved']})`);
    ok(byLabel['Orders in progress'] === 'orders/open', `[${label}] In progress → open orders (${byLabel['Orders in progress']})`);
    ok(byLabel['Orders shipped'] === 'orders/done', `[${label}] Shipped → completed orders (${byLabel['Orders shipped']})`);

    // Tap Reserved and land on Stock, filtered, with the chip agreeing.
    await p.evaluate(() => [...document.querySelectorAll('#tab-overview .tile')]
      .find(t => /Reserved/.test(t.textContent))?.click());
    await p.waitForTimeout(1200);
    const after = await p.evaluate(() => ({
      tab: document.querySelector('nav button.active')?.dataset.tab,
      chip: document.querySelector('#stChips .chip.on')?.dataset.f,
      shown: !document.getElementById('tab-stock').classList.contains('hidden'),
    }));
    ok(after.tab === 'stock' && after.shown, `[${label}] tapping Reserved opens the Stock tab (${after.tab})`);
    ok(after.chip === 'res', `[${label}] AND the chip says Reserved — a filtered list that claims to be All reads as lost stock (${after.chip})`);

    // The alerts lead somewhere too.
    await p.evaluate(() => document.querySelector('nav button[data-tab="overview"]')?.click());
    await p.waitForTimeout(900);
    const alerts = await p.evaluate(() => [...document.querySelectorAll('#tab-overview .alert')].map(a => ({
      text: a.textContent.replace(/\s+/g, ' ').trim().slice(0, 44),
      go: a.dataset.go || '', f: a.dataset.f || '', link: a.classList.contains('ov-go'),
      hint: !!a.querySelector('.ov-go-hint') })));
    const actionable = alerts.filter(a => a.link);
    if (actionable.length) {
      ok(actionable.every(a => a.go && a.f), `[${label}] each alert knows where it leads`);
      ok(actionable.every(a => a.hint), `[${label}] and says so in the text, since a phone has no hover`);
    } else {
      ok(alerts.length <= 1, `[${label}] nothing to act on — only the "All clear" line, which is not a link`);
    }

    // A day with shipments opens that day; an empty day is deliberately not a link.
    const bars = await p.evaluate(() => [...document.querySelectorAll('rect.bar')].map(r => ({
      zero: r.classList.contains('z'), link: r.classList.contains('ov-go'), day: r.dataset.day || '' })));
    ok(bars.length > 0, `[${label}] the chart drew (${bars.length} bars)`);
    ok(bars.filter(x => x.zero).every(x => !x.link), `[${label}] an empty day is not a link — it would open an empty list`);
    const live = bars.find(x => !x.zero && x.link);
    if (live) {
      await p.evaluate(d => document.querySelector(`rect.bar[data-day="${d}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })), live.day);
      await p.waitForTimeout(1200);
      const t = await p.evaluate(() => ({ tab: document.querySelector('nav button.active')?.dataset.tab,
                                          note: document.querySelector('.day-note')?.textContent || '' }));
      ok(t.tab === 'orders', `[${label}] tapping a bar opens Orders (${t.tab})`);
      ok(/Showing/.test(t.note), `[${label}] narrowed to that day, and the list says so (${t.note.slice(0, 50)})`);
    } else ok(true, `[${label}] (no shipping day to tap in this fixture)`);

    await p.screenshot({ path: `ovgo-${vp.width}.png` });
    await p.evaluate(() => fetch('/api/portal/logout', { method: 'POST',
      headers: { 'x-auth-token': localStorage.getItem('portal_token') } }));
    await p.context().close();
  }

  // ── A SECTION THIS LOGIN CANNOT SEE IS NEVER MADE A LINK.
  await J(`/api/master/client-profiles/${CLIENT}/portal-users`, { method: 'POST',
    body: JSON.stringify({ id: 'vera', visibility: { ...ALL, stock: false } }) });
  {
    const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await p.goto(BASE + '/portal'); await p.waitForTimeout(1200);
    await p.fill('#liClient', CLIENT);
    if (await p.isVisible('#liUser').catch(() => false)) await p.fill('#liUser', 'vera');
    await p.fill('#liPass', 'visco123');
    await p.click('#liBtn'); await p.waitForTimeout(3500);
    const stockTiles = await p.evaluate(() => [...document.querySelectorAll('#tab-overview .tile')]
      .filter(t => /Available|Reserved/.test(t.textContent))
      .map(t => ({ label: t.querySelector('.l')?.textContent?.trim(), link: t.classList.contains('ov-go') })));
    ok(stockTiles.length && stockTiles.every(t => !t.link),
       `with Stock switched off, its tiles are not links (${JSON.stringify(stockTiles)})`);
    const orderTiles = await p.evaluate(() => [...document.querySelectorAll('#tab-overview .tile')]
      .filter(t => /Orders/.test(t.textContent)).every(t => t.classList.contains('ov-go')));
    ok(orderTiles, 'while the Orders tiles still are — it follows what they can see, not a blanket switch');
    await p.evaluate(() => fetch('/api/portal/logout', { method: 'POST',
      headers: { 'x-auth-token': localStorage.getItem('portal_token') } }));
    await p.context().close();
  }
  await J(`/api/master/client-profiles/${CLIENT}/portal-users`, { method: 'POST',
    body: JSON.stringify({ id: 'vera', visibility: ALL }) });

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
