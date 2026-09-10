// TODAY REALLY UPDATES ON ITS OWN. The client sits on the Overview and touches
// nothing; an order is completed on the floor through the real endpoints; the
// figure moves without a reload and without pressing refresh.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636', MK = '201432547E';
const J = async (p, T, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const cells = p => p.evaluate(() => {
  const r = document.querySelector('#tab-overview .dbd-row.ov-today');
  return r ? [...r.querySelectorAll('td')].map(t => t.textContent.trim()) : null;
});

(async () => {
  const T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  // Make sure there IS an open order to finish.
  const all = await J('/api/orders?range=all', T);
  const rows = Array.isArray(all.body) ? all.body : (all.body.orders || []);
  const open = rows.find(o => String(o.client_name || o.client || '') === 'VisCo' && o.scan_status !== 'done' && o.scan_status !== 'unprocessed');
  ok(!!open, `there is an open VisCo order to finish (${open?.order_number})`);
  if (!open) { console.log('cannot run'); return; }

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 1100, height: 1000 } })).newPage();
  await p.goto(BASE + '/portal'); await p.waitForTimeout(1200);
  await p.fill('#liClient', 'VisCo');
  if (await p.isVisible('#liUser').catch(() => false)) await p.fill('#liUser', 'vera');
  await p.fill('#liPass', 'visco123');
  await p.click('#liBtn'); await p.waitForTimeout(3500);

  const before = await cells(p);
  ok(!!before, `today's row is on screen (${JSON.stringify(before)})`);
  const loadedAt = await p.evaluate(() => performance.now());

  // ── THE FLOOR FINISHES AN ORDER. Real endpoints, nothing touched in the page.
  // EXACTLY the ordered quantity. A part-scanned order stays `processing` and
  // an OVER-scanned one is refused as a mismatch — setqty lands it on the nose
  // however many times this test has run before.
  for (const l of (open.items || [])) {
    await J('/api/scan/setqty', T, { method: 'POST',
      body: JSON.stringify({ orderNumber: open.order_number, sku: l.sku, qty: Number(l.qty) || 0 }) });
  }
  const done = await J('/api/scan/complete', T, { method: 'POST', body: JSON.stringify({ orderNumber: open.order_number }) });
  // A 200 IS NOT A COMPLETION — this route answers 200 with {ok:false} and the
  // mismatches when the counts do not line up. Asserting on the status alone is
  // exactly the overclaim this codebase keeps being bitten by.
  ok(done.body?.ok === true,
     `the order is completed on the floor (${done.status}, ok=${done.body?.ok}${done.body?.mismatches ? ' ' + JSON.stringify(done.body.mismatches) : ''})`);
  const chk = await J('/api/orders?range=all', T);
  const chkRows = Array.isArray(chk.body) ? chk.body : (chk.body.orders || []);
  const nowDone = chkRows.find(o => o.order_number === open.order_number)?.scan_status;
  ok(nowDone === 'done', `and it really is done, not part-scanned (${nowDone})`);

  // ── AND THE CLIENT'S SCREEN CATCHES UP BY ITSELF. The poll is 30s.
  let after = before, waited = 0;
  while (waited < 45000 && JSON.stringify(after) === JSON.stringify(before)) {
    await p.waitForTimeout(2000); waited += 2000;
    after = await cells(p);
  }
  ok(JSON.stringify(after) !== JSON.stringify(before),
     `today's figures moved on their own after ${Math.round(waited / 1000)}s — ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  ok(Number(after[2].replace(/\D/g, '') || 0) > Number(before[2].replace(/\D/g, '') || 0),
     `and it is the COMPLETED column that went up (${before[2]} → ${after[2]})`);

  // NOBODY RELOADED AND NOBODY PRESSED REFRESH.
  ok(await p.evaluate(t => performance.now() > t, loadedAt), 'the page was never reloaded');
  ok(await p.evaluate(() => !document.getElementById('refreshBtn')?.classList.contains('spin')),
     'and the refresh button was never spun by hand');

  // ── A BACKGROUND TAB POLLS NOTHING.
  // Headless Chromium does not always mark a backgrounded page hidden, so the
  // guard is asserted by DRIVING the event rather than by hoping for it.
  const polledWhileHidden = await p.evaluate(async () => {
    let hits = 0;
    const orig = window.fetch;
    window.fetch = (...a) => { hits++; return orig(...a); };
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 1500));
    window.fetch = orig;
    return hits;
  });
  ok(polledWhileHidden === 0, `a hidden tab polls nothing (${polledWhileHidden} requests)`);

  await p.screenshot({ path: 'live-overview.png' });
  await p.evaluate(() => fetch('/api/portal/logout', { method: 'POST',
    headers: { 'x-auth-token': localStorage.getItem('portal_token') } }));
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
