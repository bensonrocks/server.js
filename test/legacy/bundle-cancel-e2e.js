// Reproduces the live report: "my bundling is not working and it's leading to
// cancelled orders". A ZORT hub store, Mayer2026 with real stock and the real
// bundle-kitting file. Orders pulled BEFORE the recipe existed carry the kit
// code unexploded and get auto-cancelled; orders arriving as a bundle-only
// line or with a differently-cased kit code must explode; already-cancelled
// ones can be restored unless re-placed by hand.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const S = __dirname;
const PORT = Number(process.env.BF_PORT || 4989), ZPORT = Number(process.env.BF_ZPORT || 4790);
const B = `http://localhost:${PORT}`, Z = `http://localhost:${ZPORT}`;
const DDIR = path.join(S, 'bundle-cancel-data-' + PORT);
const MASTER = process.env.MASTER_KEY || '201432547E';
const SERVER = process.env.SERVER_JS || process.env.IDEALONE_SERVER || path.join(__dirname, '../../server.js');
const ZMOCK = path.join(S, 'bundle-cancel-mock.js');
// Same sheet, headers and rows as the client's real Bundle_Kitting file —
// generated here so no client file is ever committed.
const XLSX = require('xlsx');
function kittingFile() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Kit SKU*', 'Inventory SKU*', 'Quantity*'],
    ['YP-800-MMPC6062A+MMSSP6', 'PCMMPC6062AXXXXXXWEMY', 1],
    ['YP-800-MMPC6062A+MMSSP6', 'AHMMSSP6XXSSMY', 1],
    ['YP-800-EPS111WEX6', 'WFEPS111XXXXXXXXXWEXX', 6],
  ]), 'Template');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kid, zkid;
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up: ' + url); }
async function stopAll() { for (const k of [kid, zkid]) { if (!k) continue; try { process.kill(-k.pid, 'SIGTERM'); } catch {} try { process.kill(k.pid, 'SIGTERM'); } catch {} } await sleep(1000); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t, _status: r.status }; } };
let tok;
const H = (extra = {}) => ({ 'Content-Type': 'application/json', 'x-auth-token': tok, 'x-master-key': MASTER, ...extra });
async function login() { tok = (await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }))).token; }
async function order(n) {
  const all = await J(await fetch(B + '/api/orders?range=all', { headers: { 'x-auth-token': tok } }));
  return (Array.isArray(all) ? all : (all.orders || [])).find(o => o.order_number === n);
}
async function stock() {
  const rows = await J(await fetch(B + '/api/inventory?clientId=Mayer2026', { headers: { 'x-auth-token': tok } }));
  const m = {}; for (const r of (Array.isArray(rows) ? rows : [])) m[r.sku] = r; return m;
}
const addZ = o => fetch(Z + '/__ctl/add', { method: 'POST', body: JSON.stringify(o) });
const pull = async sid => J(await fetch(B + `/api/master/zort/stores/${sid}/pull`, { method: 'POST', headers: H() }));
const skusOf = o => (o && (o.items || o.lines) || []).map(l => `${l.sku}×${l.qty}${l.from_bundle ? '<' + l.from_bundle : ''}`);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  zkid = spawn('node', [ZMOCK, String(ZPORT)], { stdio: 'ignore', detached: true });
  await sleep(500);
  kid = spawn('node', [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(path.join(S, 'bundle-cancel-server.log'), 'w'), fs.openSync(path.join(S, 'bundle-cancel-server.log'), 'a')], detached: true });
  await waitUp(B + '/api/version'); await sleep(2500);
  console.log('server:', SERVER);
  await login(); ok(!!tok, 'admin logged in');

  const seed = await J(await fetch(B + '/api/inventory/import', { method: 'POST', headers: H(), body: JSON.stringify({ clientId: 'Mayer2026', items: [
    { sku: 'WFEPS111XXXXXXXXXWEXX', name: 'EPS111 A.OPT EVOLVE+ WTR FTR', stock_qty: 100 },
    { sku: 'PCMMPC6062AXXXXXXWEMY', name: 'Mayer Pitcher', stock_qty: 50 },
    { sku: 'AHMMSSP6XXSSMY', name: 'Mayer Spare', stock_qty: 50 },
    { sku: 'WFMMFK621XWEMY', name: 'Mayer 2L Compact Water Filter Jug MMFK621', stock_qty: 20 },
  ] }) }));
  ok(seed.imported === 4, `Mayer2026 item master seeded (${seed.imported})`);

  const store = await J(await fetch(B + '/api/master/zort/stores', { method: 'POST', headers: H(), body: JSON.stringify({
    clientName: 'IDEALONEHUB', storename: 'mock', apikey: 'k', apisecret: 's', endpoint: Z, enabled: true, autoPullMinutes: 0,
    newClientFromChannel: true, channelClients: { ShopeeOther: 'OtherCo' } }) }));
  ok(!!store.id, 'hub ZORT store connected');

  console.log('\n=== BEFORE the recipe exists: orders carrying kit codes arrive ===');
  await addZ({ number: '173431916609282', saleschannel: 'Lazada20082026Mayer', list: [{ sku: 'YP-800-EPS111WEX6', name: 'EPS111 x6', number: 1 }, { sku: 'WFMMFK621XWEMY', name: 'Jug', number: 1 }] });
  await addZ({ number: 'A2-PENDING', saleschannel: 'Lazada20082026Mayer', list: [{ sku: 'YP-800-MMPC6062A+MMSSP6', name: 'Pitcher set', number: 2 }, { sku: 'WFMMFK621XWEMY', name: 'Jug', number: 1 }] });
  await addZ({ number: 'A4-RESTORE', saleschannel: 'Lazada20082026Mayer', list: [{ sku: 'YP-800-EPS111WEX6', name: 'EPS111 x6', number: 1 }, { sku: 'WFMMFK621XWEMY', name: 'Jug', number: 1 }] });
  const p1 = await pull(store.id);
  ok(p1.result && p1.result.created === 3, `3 orders pulled (${p1.result && p1.result.created})`);
  const a1 = await order('173431916609282');
  ok(a1 && a1.client_name === 'Mayer2026', `173431916609282 filed under Mayer2026 (${a1 && a1.client_name})`);
  ok(skusOf(a1).some(s => s.startsWith('YP-800-EPS111WEX6')), `…still carrying the kit code, no recipe yet (${skusOf(a1)})`);

  // A2 is kept off the clock so it survives to prove the re-explosion.
  const keep = await fetch(B + '/api/master/orders/A2-PENDING/keep', { method: 'POST', headers: H(), body: '{}' });
  ok(keep.ok, 'A2-PENDING kept off the auto-cancel clock');
  const sw1 = await J(await fetch(B + '/api/master/orders/auto-cancel-sweep', { method: 'POST', headers: H(), body: JSON.stringify({ minutes: 0 }) }));
  const c1 = (sw1.cancelled || []).map(c => c.order);
  ok(c1.includes('173431916609282') && c1.includes('A4-RESTORE'), `THE REPORTED FAULT: the kit code read as missing stock, both cancelled (${c1})`);

  // The floor re-places 173431916609282 by hand, exactly as the screenshot.
  const fd = new FormData();
  fd.append('orderFile', new Blob(['Order Number,SKU,Quantity\n173431916609282 - Manual,WFEPS111XXXXXXXXXWEXX,6\n173431916609282 - Manual,WFMMFK621XWEMY,1\n']), 'manual.csv');
  fd.append('client_name', 'Mayer2026');
  fd.append('stock_action', 'proceed');
  const up = await fetch(B + '/api/upload', { method: 'POST', headers: { 'x-auth-token': tok }, body: fd });
  const upBody = await up.text(); if (!up.ok) console.log('  upload said:', upBody.slice(0, 400));
  ok(up.ok, `manual replacement "173431916609282 - Manual" uploaded (${up.status})`);

  console.log('\n=== the recipe is defined (the real Bundle_Kitting file) ===');
  const fdb = new FormData();
  fdb.append('clientId', 'Mayer2026'); fdb.append('confirm_apply', 'yes');
  fdb.append('file', new Blob([kittingFile()]), 'Bundle_Kitting_24.09.2026.xlsx');
  const imp = await J(await fetch(B + '/api/inventory/bundles/import', { method: 'POST', headers: { 'x-auth-token': tok }, body: fdb }));
  ok(imp.ok && imp.kits === 2, `2 kits defined (${imp.kits})`);
  ok(imp.reexploded === 1, `the one untouched open order was re-exploded on import (${imp.reexploded})`);
  const a2 = await order('A2-PENDING');
  const a2s = skusOf(a2);
  console.log('  A2-PENDING lines now:', a2s);
  ok(!a2s.some(s => s.startsWith('YP-800-MMPC6062A')), 'A2-PENDING no longer carries the kit code');
  ok(a2s.includes('PCMMPC6062AXXXXXXWEMY×2<YP-800-MMPC6062A+MMSSP6') && a2s.includes('AHMMSSP6XXSSMY×2<YP-800-MMPC6062A+MMSSP6'),
    'A2-PENDING carries the real components ×2 each, tagged with the kit');
  ok(a2s.includes('WFMMFK621XWEMY×1'), 'its ordinary line is untouched');
  const st1 = await stock();
  console.log('  reserved:', Object.fromEntries(Object.entries(st1).map(([k, v]) => [k, v.reserved_qty])));
  ok(Number((st1['YP-800-MMPC6062A+MMSSP6'] || {}).reserved_qty || 0) === 0, 'nothing is left reserved against the kit code');
  ok(Number(st1['PCMMPC6062AXXXXXXWEMY'].reserved_qty) === 2 && Number(st1['AHMMSSP6XXSSMY'].reserved_qty) === 2, 'the components are reserved instead (2 + 2)');

  console.log('\n=== orders already cancelled over a kit code ===');
  const lr = await J(await fetch(B + '/api/master/orders/bundle-cancelled', { headers: H() }));
  const rows = lr.rows || [];
  console.log('  rescue list:', JSON.stringify(rows.map(r => ({ o: r.order, restorable: r.restorable, replacedBy: r.replacedBy }))));
  const r1 = rows.find(r => r.order === '173431916609282'), r4 = rows.find(r => r.order === 'A4-RESTORE');
  ok(!!r1 && r1.restorable === false && r1.replacedBy.includes('173431916609282 - Manual'), '173431916609282 is listed but NOT restorable — its manual re-placement is named');
  ok(!!r4 && r4.restorable === true, 'A4-RESTORE is listed and restorable');
  // ── REAL BROWSER: the rescue panel on Inventory → Bundles (BUNDLE_CANCEL_BROWSER=1) ──
  if (process.env.BUNDLE_CANCEL_BROWSER === '1') {
  const { chromium } = require('playwright');
  // Optional pass only (BUNDLE_CANCEL_BROWSER=1); CI is pure Node. TEST_CHROMIUM names the binary.
  const br = await chromium.launch(process.env.TEST_CHROMIUM ? { executablePath: process.env.TEST_CHROMIUM } : {});
  for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 393, height: 851 }]]) {
    const ctx = await br.newContext({ viewport: vp, isMobile: label === 'phone', hasTouch: label === 'phone' });
    const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', e => errs.push(e.message));
    pg.on('dialog', d => d.accept());
    await pg.goto(B, { waitUntil: 'domcontentloaded' });
    await pg.fill('#loginName', 'demo'); await pg.fill('#loginIC', 'demo'); await pg.click('#loginBtn'); await pg.waitForTimeout(2500);
    await pg.evaluate(() => document.querySelector('[data-tab="inventory"]').click()); await pg.waitForTimeout(800);
    await pg.evaluate(() => document.querySelector('button[data-inv-view="bundles"]').click()); await pg.waitForTimeout(500);
    await pg.fill('#invClient', 'Mayer2026'); await pg.click('#invLoadBtn', { force: true }); await pg.waitForTimeout(2000);
    const vis = await pg.evaluate(() => !document.getElementById('invBundleRescue').classList.contains('hidden'));
    const txt = await pg.evaluate(() => document.getElementById('invBundleRescue').innerText);
    const picks = await pg.$$eval('#invBundleRescue .bres-pick', els => els.map(e => e.dataset.o));
    const noScroll = await pg.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    const expectN = label === 'desktop' ? 2 : 1;   // desktop restores A4 before the phone pass
    ok(vis && new RegExp(expectN + ' order\\(s\\) were auto-cancelled').test(txt), `${label}: rescue panel shows ${expectN} cancelled bundle order(s)`);
    ok(label === 'desktop' ? (picks.length === 1 && picks[0] === 'A4-RESTORE') : picks.length === 0,
      `${label}: ${label === 'desktop' ? 'only A4-RESTORE can be ticked' : 'the re-placed one cannot be ticked'} (${picks})`);
    ok(/Re-placed as 173431916609282 - Manual/.test(txt), `${label}: the re-placed one says so in words`);
    ok(noScroll, `${label}: no sideways scroll`);
    await pg.screenshot({ path: path.join(S, `bundle-cancel-${label}-rescue.png`), fullPage: false });
    if (label === 'desktop') {
      await pg.click('#bresRestoreBtn'); await pg.waitForTimeout(2500);
      const after = await pg.evaluate(() => document.getElementById('invBundleRescue').innerText);
      ok(/1 order\(s\) were auto-cancelled/.test(after), 'desktop: after Restore only the re-placed one remains listed');
    }
    ok(!errs.length, `${label}: no page errors (${errs.join(' | ')})`);
    await ctx.close();
  }
  await br.close();
  await login();   // the browser's demo login took the one-device seat
  } else {
    // Without the browser, restore A4 through the API the panel calls.
    const r4r = await J(await fetch(B + '/api/master/orders/bundle-cancelled/restore', { method: 'POST', headers: H(), body: JSON.stringify({ orders: ['A4-RESTORE'] }) }));
    ok((r4r.restored || []).includes('A4-RESTORE'), `A4-RESTORE restored (${JSON.stringify(r4r.restored)})`);
  }
  const rs = await J(await fetch(B + '/api/master/orders/bundle-cancelled/restore', { method: 'POST', headers: H(), body: JSON.stringify({ orders: ['173431916609282'] }) }));
  ok(!(rs.restored || []).length, `the re-placed one cannot be restored via the API either (${JSON.stringify(rs.restored)})`);
  ok((rs.refused || []).some(x => x.order === '173431916609282' && /re-placed/i.test(x.why)), 'refused with a reason — no double shipment');
  const a4 = await order('A4-RESTORE');
  ok(a4 && a4.scan_status === 'pending', `A4-RESTORE is back on the floor (${a4 && a4.scan_status})`);
  ok(skusOf(a4).includes('WFEPS111XXXXXXXXXWEXX×6<YP-800-EPS111WEX6'), `A4-RESTORE picks WFEPS111 ×6 from the kit (${skusOf(a4)})`);
  const a1b = await order('173431916609282');
  ok(a1b && a1b.scan_status === 'unprocessed', 'the original 173431916609282 stays cancelled');

  console.log('\n=== AFTER the recipe exists: new orders ===');
  await addZ({ number: 'B2-LOWERCASE', saleschannel: 'Lazada20082026Mayer', list: [{ sku: 'yp-800-eps111wex6 ', name: 'EPS111 x6', number: 1 }] });
  await addZ({ number: 'B3-KITONLY', saleschannel: 'Lazada20082026Mayer', list: [{ sku: 'YP-800-MMPC6062A+MMSSP6', name: 'Pitcher set', number: 1 }] });
  const p2 = await pull(store.id);
  ok(p2.result && p2.result.created === 2, `2 more pulled (${p2.result && p2.result.created})`);
  const b2 = await order('B2-LOWERCASE'), b3 = await order('B3-KITONLY');
  ok(b3 && b3.client_name === 'Mayer2026', `a KIT-ONLY order from an unmapped channel files under Mayer2026, the recipe owner (${b3 && b3.client_name})`);
  ok(skusOf(b3).length === 2 && skusOf(b3).every(s => s.includes('<YP-800-MMPC6062A+MMSSP6')), `…and explodes (${skusOf(b3)})`);
  ok(b2 && b2.client_name === 'Mayer2026', `a lower-case, space-padded kit code files under Mayer2026 (${b2 && b2.client_name})`);
  ok(skusOf(b2).includes('WFEPS111XXXXXXXXXWEXX×6<YP-800-EPS111WEX6'), `…and explodes to WFEPS111 ×6 (${skusOf(b2)})`);

  const sw2 = await J(await fetch(B + '/api/master/orders/auto-cancel-sweep', { method: 'POST', headers: H(), body: JSON.stringify({ minutes: 0 }) }));
  const c2 = (sw2.cancelled || []).map(c => c.order);
  ok(!c2.length, `a purge at 0 minutes now cancels NOTHING — every bundle order is fillable (${c2})`);
  for (const n of ['A2-PENDING', 'A4-RESTORE', 'B2-LOWERCASE', 'B3-KITONLY']) {
    const o = await order(n);
    ok(o && o.scan_status === 'pending', `${n} still pending (${o && o.scan_status})`);
  }

  console.log(`\n${fails.length ? 'FAIL: ' + fails.length : 'ALL PASS'}`);
  await stopAll();
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('ERROR', e); await stopAll(); process.exit(1); });
