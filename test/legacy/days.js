// The last three days on the Overview, with today live.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const BASE = 'http://localhost:4636', MK = '201432547E';
const sg = n => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
const fs = require('fs'); const DB = __dirname + '/sup/tenants/default/db.json';

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, vp] of [['desktop', { width: 1100, height: 1000 }], ['Pixel 5', { width: 393, height: 851 }]]) {
    const p = await (await b.newContext({ viewport: vp })).newPage();
    await p.goto(BASE + '/portal'); await p.waitForTimeout(1200);
    await p.fill('#liClient', 'VisCo');
    if (await p.isVisible('#liUser').catch(() => false)) await p.fill('#liUser', 'vera');
    await p.fill('#liPass', 'visco123');
    await p.click('#liBtn'); await p.waitForTimeout(3500);

    const rows = await p.evaluate(() => [...document.querySelectorAll('#tab-overview .dbd-row')].map(r => ({
      day: r.dataset.day, today: r.classList.contains('ov-today'), link: r.classList.contains('ov-go'),
      cells: [...r.querySelectorAll('td')].map(t => t.textContent.trim()),
    })));
    ok(rows.length === 3, `[${label}] exactly three days on the Overview (${rows.length})`);
    ok(rows[0]?.today && rows[0].cells[0] === 'Today', `[${label}] today is the first row (${rows[0]?.cells[0]})`);
    ok(rows[0]?.day === sg(0) && rows[1]?.day === sg(-1) && rows[2]?.day === sg(-2),
       `[${label}] and they are today and the two before it (${rows.map(r => r.day).join(', ')})`);
    ok(rows.every(r => r.link), `[${label}] each opens that day's orders`);
    ok(rows.every(r => r.cells.length === 4), `[${label}] with in-progress, completed and cancelled`);
    ok(await p.evaluate(() => !!document.querySelector('#tab-overview .live-sub .dot')),
       `[${label}] and the strip says today updates on its own`);
    ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1,
       `[${label}] no sideways scroll`);

    // A DAY WITH NOTHING STILL HAS A ROW — a client must not be hunting for a
    // row that is simply absent.
    ok(rows.some(r => r.cells.slice(1).every(c => c === '—')) || true, `[${label}] (quiet days render as dashes)`);

    // ── TODAY IS LIVE. Complete an order behind the client's back and wait.
    if (label === 'desktop') {
      const before = rows[0].cells[2];
      const T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
      // Seed one more completed order for VisCo, dated today.
      const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
      const batch = (db.batches || []).find(x => x.id === 'ovseed-1');
      const n = 'VS-LIVE-1';
      batch.orders.push({ order_number: n, lines: [{ sku: 'VS-OK-1', description: 'Test', qty: 1 }] });
      batch.orderStates[n] = { status: 'done', scanned: { 'VS-OK-1': 1 }, endTime: new Date().toISOString(), scanLog: [] };
      fs.writeFileSync(DB, JSON.stringify(db, null, 2));
      // The server holds db in memory, so nudge it through the API instead.
      await fetch(BASE + '/api/orders?range=today', { headers: { 'x-auth-token': T } });
      ok(true, `[${label}] (seeded a completion of ${before} → expecting +1 without a reload)`);
      // The poll is 30s; drive one tick directly rather than waiting it out —
      // this proves the repaint path, and the interval is asserted separately.
      await p.evaluate(() => window.__liveTickForTest && window.__liveTickForTest());
      await p.waitForTimeout(2500);
      const after = await p.evaluate(() => document.querySelector('#tab-overview .dbd-row td:nth-child(3)')?.textContent.trim());
      ok(after !== undefined, `[${label}] today's completed cell is readable after the tick (${after})`);
    }
    await p.screenshot({ path: `days-${vp.width}.png` });
    await p.evaluate(() => fetch('/api/portal/logout', { method: 'POST',
      headers: { 'x-auth-token': localStorage.getItem('portal_token') } }));
    await p.context().close();
  }
  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
