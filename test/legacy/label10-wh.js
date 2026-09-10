// WAREHOUSE can reprint carton labels from the Orders list too — with a
// REDUCED bulk bar: tick boxes + 🏷 Carton Labels + Clear, and none of the
// admin group actions even present in their DOM.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const ORD = '24944949';

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 200)));
  let lastConfirm = '';
  p.on('dialog', d => { if (d.type() === 'confirm') lastConfirm = d.message(); d.accept().catch(() => {}); });
  await ctx.addInitScript(() => {
    window.__prints = 0;
    window.print = function () { try { window.top.__prints++; } catch (e) { window.__prints++; } };
  });

  await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'rcwh'); await p.fill('#loginIC', 'rcwh123');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  const who = await p.evaluate(() => window.currentUser?.role || document.body.className || '');
  console.log('logged in as role:', who);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(1500);
  await p.evaluate(() => document.querySelector('[data-oview="completed"]')?.click());
  await p.waitForTimeout(2000);

  // ── THE SELECTION UI IS THERE FOR WAREHOUSE.
  const boxes = await p.evaluate(() => document.querySelectorAll('.ord-select').length);
  ok(boxes > 0, `warehouse sees the tick boxes (${boxes} rows)`);
  const ticked = await p.evaluate((o) => {
    let n = 0;
    for (const cb of document.querySelectorAll('.ord-select')) if (cb.dataset.order === o) { cb.click(); n++; }
    return n;
  }, ORD);
  ok(ticked === 1, `and can tick the completed order (${ticked})`);
  await p.waitForTimeout(500);

  // ── THE BAR IS THE REDUCED ONE: count + Carton Labels + Clear, nothing else.
  const bar = await p.evaluate(() => {
    const bar = document.getElementById('ordersBulkBar');
    return {
      visible: bar && !bar.classList.contains('hidden'),
      buttons: bar ? [...bar.querySelectorAll('button')].map(x => x.id) : [],
      count: document.getElementById('ordersBulkCount')?.textContent || '',
      ctn: document.getElementById('ordersBulkCartonLabels')?.textContent.trim() || '',
    };
  });
  ok(bar.visible, 'the bulk bar appears');
  ok(bar.buttons.join(',') === 'ordersBulkCartonLabels,ordersBulkClear',
     `and carries ONLY Carton Labels + Clear (${bar.buttons.join(', ')})`);
  ok(/Carton Labels \(1\)/.test(bar.ctn), `counting the selection ("${bar.ctn}")`);
  for (const id of ['ordersBulkDelete', 'ordersBulkReclassify', 'ordersBulkComplete', 'ordersBulkRefile', 'ordersBulkWave', 'ordersBulkNotOurs']) {
    ok(!(await p.evaluate((i) => !!document.getElementById(i), id)), `admin action ${id} is absent from the warehouse DOM`);
  }
  await p.evaluate((o) => document.querySelector(`tr.orders-tr[data-order="${o}"]`)?.scrollIntoView({ block: 'center' }), ORD);
  await p.screenshot({ path: __dirname + '/l10-wh-bar.png', clip: { x: 0, y: 0, width: 1400, height: 620 } });

  // ── AND THE REPRINT WORKS.
  await p.click('#ordersBulkCartonLabels');
  await p.waitForTimeout(3500);
  ok(/2 carton labels for 1 order/.test(lastConfirm), `the confirm states the numbers ("${lastConfirm.split('\n')[0]}")`);
  ok((await p.evaluate(() => window.__prints)) === 1, 'one print run fired');
  const doc = await p.evaluate(() => {
    const d = document.getElementById('cartonLabelFrame')?.contentDocument;
    return d ? [...d.querySelectorAll('.lbl-page')].map(e => e.querySelector('.ctn')?.textContent.replace(/\s+/g, ' ').trim()) : null;
  });
  ok(doc && doc.length === 2 && /CTN 1 \/ 2/.test(doc[0]) && /CTN 2 \/ 2/.test(doc[1]),
     `both boxes with the final total (${doc?.join(' | ')})`);

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
