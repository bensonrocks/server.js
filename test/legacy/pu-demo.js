// THE PICKED-UP FLOW, end to end on the real screens:
//   1. PU-1 syncs in from the hub (Pending there, pending here).
//   2. We pick, pack and complete it → amber "📦 Awaiting collection".
//   3. The courier scans the waybill → the hub moves to Shipping.
//   4. The next pull sees it → green "✓ Picked Up" appears BY ITSELF,
//      stamped courier-scan, and the client's portal says the same.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const MK = '201432547E';
const OUT = __dirname;
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

(async () => {
  // API session for the pulls and the portal-login setup.
  const login = await fetch('http://localhost:4636/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'whguy', ic: 'whguy' }),
  }).then(r => r.json()).catch(() => ({}));
  const tok = login.token || '';
  const H = { 'Content-Type': 'application/json', 'x-auth-token': tok, 'x-master-key': MK };
  const stores = await fetch('http://localhost:4636/api/master/zort/stores', { headers: H }).then(r => r.json());
  const store = stores.find(s => s.clientName === 'ChaseCo');
  ok(!!store, `the ChaseCo store is connected (${store?.id})`);
  const pull = () => fetch(`http://localhost:4636/api/master/zort/stores/${store.id}/pull`, { method: 'POST', headers: H }).then(r => r.json());

  // ── 1. THE ORDER ARRIVES from the hub.
  const p1 = await pull();
  ok((p1.imported || p1.fetched || 0) >= 1 || JSON.stringify(p1).includes('PU-1'), `pull imported PU-1 (${JSON.stringify(p1).slice(0, 120)})`);

  // A portal login for ChaseCo so the client side can be shown too.
  await fetch('http://localhost:4636/api/master/client-profiles/ChaseCo/portal-users', {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'PU Demo', password: 'pudemo1', access: 'view' }),
  }).then(r => r.json()).then(d => console.log('portal login:', JSON.stringify(d).slice(0, 100)));

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept().catch(() => {}));
  await ctx.addInitScript(() => { window.print = function () {}; });

  const mark = (sel, text, dy = 0) => p.evaluate(([sel, text, dy]) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const ring = document.createElement('div');
    ring.className = '__tour';
    ring.style.cssText = `position:fixed;left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;border:4px solid #dc2626;border-radius:10px;z-index:999999;pointer-events:none`;
    document.body.appendChild(ring);
    const tag = document.createElement('div');
    tag.className = '__tour';
    tag.textContent = text;
    tag.style.cssText = `position:fixed;left:${Math.max(10, r.left)}px;top:${r.bottom + 10 + dy}px;background:#dc2626;color:#fff;font:800 16px -apple-system,Arial;padding:7px 12px;border-radius:8px;z-index:999999;pointer-events:none;max-width:560px;box-shadow:0 4px 14px rgba(0,0,0,.35)`;
    document.body.appendChild(tag);
    return true;
  }, [sel, text, dy]);
  const clearMarks = () => p.evaluate(() => document.querySelectorAll('.__tour').forEach(e => e.remove()));
  const rowSel = 'tr.orders-tr[data-order="PU-1"]';

  await p.goto('http://localhost:4636'); await p.waitForTimeout(1500);
  await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
  await p.click('#loginBtn'); await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(2500);
  await p.evaluate(() => [...document.querySelectorAll('.filter-chip')].find(c => /^all$/i.test(c.textContent.trim()))?.click());
  await p.waitForTimeout(1500);

  // ── 2. PICK, PACK, COMPLETE through the real scan screen.
  await p.evaluate(() => {
    const tr = document.querySelector('tr.orders-tr[data-order="PU-1"]');
    tr?.querySelector('.btn-scan-now')?.click();
  });
  await p.waitForTimeout(3000);
  await p.click('#itemScanInput');
  await p.keyboard.type('PU-SKU-1', { delay: 15 });
  await p.keyboard.press('Enter');
  await p.waitForTimeout(3000);
  if (await p.isVisible('#completeOrderBtn').catch(() => false)) await p.click('#completeOrderBtn').catch(() => {});
  await p.waitForTimeout(4000);

  await p.evaluate(() => document.querySelector('[data-oview="completed"]')?.click());
  await p.waitForTimeout(2000);
  await p.evaluate(() => document.querySelector('tr.orders-tr[data-order="PU-1"]')?.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(400);
  const chip1 = await p.evaluate(() => document.querySelector('tr.orders-tr[data-order="PU-1"] .chip-pickup-wait')?.textContent.trim() || '');
  ok(/Awaiting collection/.test(chip1), `finished order shows the amber chip ("${chip1}")`);
  await mark(rowSel + ' .chip-pickup-wait', '1. Packed and completed — waiting for the courier. Nobody can hand-tick an API order.');
  await p.screenshot({ path: `${OUT}/pu-1-awaiting.png`, clip: { x: 0, y: 0, width: 1400, height: 620 } });
  await clearMarks();

  // ── 3. THE COURIER SCANS THE WAYBILL — the hub flips to Shipping.
  const ship = await fetch('http://localhost:4928/_ship').then(r => r.json());
  ok(ship.status === 'Shipping', `hub now says ${ship.status} — the courier scan`);

  // ── 4. THE NEXT PULL notices, and the chip changes BY ITSELF.
  await pull();
  await p.waitForTimeout(1000);
  await p.evaluate(() => window.renderOrdersDash?.() || document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-oview="completed"]')?.click());
  await p.waitForTimeout(2000);
  await p.evaluate(() => document.querySelector('tr.orders-tr[data-order="PU-1"]')?.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(400);
  const chip2 = await p.evaluate(() => {
    const c = document.querySelector('tr.orders-tr[data-order="PU-1"] .chip-picked-up');
    return c ? { text: c.textContent.trim(), title: c.getAttribute('title') } : null;
  });
  ok(!!chip2 && /Picked Up/.test(chip2.text), `the chip is now green ✓ Picked Up ("${chip2?.text}")`);
  ok(/courier collected it/.test(chip2?.title || ''), `and says WHO took it: "${chip2?.title}"`);
  await mark(rowSel + ' .chip-picked-up', `2. After the courier scan + pull — automatic. Hover: "${(chip2?.title || '').slice(0, 80)}…"`);
  await p.screenshot({ path: `${OUT}/pu-2-picked-up.png`, clip: { x: 0, y: 0, width: 1400, height: 620 } });
  await clearMarks();

  // The stored record says courier-scan, never manual.
  const orders = await fetch('http://localhost:4636/api/orders?range=all', { headers: H }).then(r => r.json());
  const pu = (Array.isArray(orders) ? orders : orders.orders || []).find(o => o.order_number === 'PU-1');
  ok(pu?.pickup_method === 'courier-scan', `stored method is courier-scan (${pu?.pickup_method})`);

  // ── 5. THE CLIENT'S PORTAL says the same, in their words.
  const p2 = await ctx.newPage();
  await p2.goto('http://localhost:4636/portal'); await p2.waitForTimeout(1500);
  await p2.fill('#pClient', 'ChaseCo').catch(() => {});
  await p2.fill('#pPassword', 'pudemo1').catch(() => {});
  await p2.evaluate(() => document.querySelector('#pLoginBtn')?.click());
  await p2.waitForTimeout(3000);
  const tabClicked = await p2.evaluate(() => {
    const t = [...document.querySelectorAll('[data-ptab],[data-tab],.pnav button,.tabbtn')].find(x => /orders/i.test(x.textContent));
    if (t) { t.click(); return true; } return false;
  });
  await p2.waitForTimeout(2500);
  const portalTxt = await p2.evaluate(() => document.body.innerText.slice(0, 4000));
  const hasPill = /Picked Up/i.test(portalTxt) && /PU-1/.test(portalTxt);
  ok(hasPill, `the client portal shows PU-1 as Picked Up (tab=${tabClicked})`);
  if (hasPill) {
    await p2.evaluate(() => {
      const tag = document.createElement('div');
      tag.textContent = "3. The client sees it too — Picked Up, collected by the platform's courier";
      tag.style.cssText = 'position:fixed;left:20px;top:14px;background:#dc2626;color:#fff;font:800 16px -apple-system,Arial;padding:8px 12px;border-radius:8px;z-index:999999;max-width:560px;box-shadow:0 4px 14px rgba(0,0,0,.35)';
      document.body.appendChild(tag);
      const el = [...document.querySelectorAll('*')].find(x => x.children.length === 0 && /Picked Up/i.test(x.textContent));
      el?.scrollIntoView({ block: 'center' });
    });
    await p2.waitForTimeout(500);
    await p2.screenshot({ path: `${OUT}/pu-3-portal.png`, clip: { x: 0, y: 0, width: 1400, height: 700 } });
  }

  await b.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
