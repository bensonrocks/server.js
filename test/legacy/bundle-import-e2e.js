// Bundle definitions — bulk import (office) + client-portal self-service —
// through the REAL server. Reported: ZORT sync shows a bundle/kit code as a
// bare SKU instead of resolving it to the real inventory SKUs + qty beneath
// it. `explodeBundleRows` already did this at every intake door, ZORT sync
// included — the gap was that no bundle DEFINITIONS existed, and there was
// no way to load many at once from the "Kit SKU / Inventory SKU / Quantity"
// template a client's kitting sheet actually comes in as (one row per
// component, several rows share a Kit SKU).
//
// The fixture below reproduces the shape of the client's own file, with
// invented SKUs — the real file is not committed here.
//
//   SERVER_JS=<path> boots another build (a pre-fix comparison).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');

const S = __dirname;
const PORT = 4991;
const B = `http://localhost:${PORT}`;
const DDIR = path.join(S, 'bundle-import-data');
const MASTER = process.env.MASTER_KEY || '201432547E';
const SERVER = process.env.SERVER_JS || path.join(__dirname, '../../server.js');

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kid;
async function portFree(url) { try { await fetch(url); return false; } catch { return true; } }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up: ' + url); }
async function stopAll() { if (kid) { try { process.kill(-kid.pid, 'SIGTERM'); } catch {} try { process.kill(kid.pid, 'SIGTERM'); } catch {} } await sleep(1000); }

const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t, _status: r.status }; } };
async function login(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); if (!d.token) throw new Error('login ' + id + ' ' + JSON.stringify(d)); return d.token; }
const MH = tok => ({ 'Content-Type': 'application/json', 'x-master-key': MASTER, 'x-auth-token': tok });

function xlsxOf(header, rows) {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
// The client's own template: "Kit SKU* / Inventory SKU* / Quantity*", one
// row per component, several rows sharing a Kit SKU.
const BUNDLE_FILE = xlsxOf(['Kit SKU*', 'Inventory SKU*', 'Quantity*'], [
  ['KIT-DESK-SETUP', 'MON-27-XXXXXXXWEMY', 1],
  ['KIT-DESK-SETUP', 'KBD-WLESS-XXSSMY', 1],
  ['KIT-CABLE-6PK', 'CBL-USBC-1M-WEXX', 6],
]);

async function importInventory(tok, clientId, items) {
  return J(await fetch(B + '/api/inventory/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': tok }, body: JSON.stringify({ clientId, items }) }));
}
async function getBundlesOffice(tok, clientId) {
  return J(await fetch(B + '/api/inventory/bundles?clientId=' + encodeURIComponent(clientId), { headers: { 'x-auth-token': tok } }));
}
async function importBundlesOffice(tok, clientId, confirm) {
  const fd = new FormData();
  fd.append('file', new Blob([BUNDLE_FILE]), 'Bundle_Kitting.xlsx');
  fd.append('clientId', clientId);
  if (confirm) fd.append('confirm_apply', 'yes');
  const r = await fetch(B + '/api/inventory/bundles/import', { method: 'POST', headers: { 'x-auth-token': tok }, body: fd });
  return { status: r.status, body: await J(r) };
}
async function createPortalUser(admin, client, name, access, password) {
  const r = await J(await fetch(B + `/api/master/client-profiles/${client}/portal-users`, { method: 'POST', headers: MH(admin), body: JSON.stringify({ name, access, password }) }));
  return r.user || r;
}
async function portalLogin(client, user, password) {
  return (await J(await fetch(B + '/api/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, user, password }) }))).token;
}

(async () => {
  if (!(await portFree(B + '/api/version'))) throw new Error(`port ${PORT} already answering — a stray server; refusing to measure the wrong process`);
  fs.rmSync(DDIR, { recursive: true, force: true });
  kid = spawn('node', [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(path.join(S, 'bundle-import-server.log'), 'a'), fs.openSync(path.join(S, 'bundle-import-server.log'), 'a')], detached: true });
  await waitUp(B + '/api/version');
  await sleep(2500);
  const admin = await login('demo', 'demo');
  console.log('server:', SERVER);

  console.log('\n=== bundle import against a client with NO item master ===');
  const pv0 = await importBundlesOffice(admin, 'BareClient', false);
  ok(pv0.status === 409 && pv0.body.needsBundleImportConfirm, `409 preview (${pv0.status})`);
  ok(pv0.body.preview.kits === 2, `preview counts 2 kits (${pv0.body.preview.kits})`);
  ok(pv0.body.preview.components === 3, `preview counts 3 component lines (${pv0.body.preview.components})`);
  ok(pv0.body.preview.willCreate === 0, `willCreate is 0 with no item master (${pv0.body.preview.willCreate})`);
  ok(pv0.body.preview.skippedKitCount === 2, `both kits flagged skipped (${pv0.body.preview.skippedKitCount})`);
  const ap0 = await importBundlesOffice(admin, 'BareClient', true);
  ok(ap0.body.kits === 0, `apply creates 0 bundles (${ap0.body.kits})`);
  ok((ap0.body.skippedKits || []).length === 2, `apply reports 2 skipped kits (${(ap0.body.skippedKits || []).length})`);
  const gb0 = await getBundlesOffice(admin, 'BareClient');
  ok(Array.isArray(gb0) && gb0.length === 0, `nothing was defined for BareClient (${gb0.length})`);

  console.log('\n=== bundle import against a client WITH the item master loaded ===');
  const CID = 'DeskGear';
  const seed = await importInventory(admin, CID, [
    { sku: 'MON-27-XXXXXXXWEMY', name: '27" Monitor', stock_qty: 100 },
    { sku: 'KBD-WLESS-XXSSMY', name: 'Wireless Keyboard', stock_qty: 100 },
    { sku: 'CBL-USBC-1M-WEXX', name: 'USB-C Cable 1m', stock_qty: 100 },
  ]);
  ok(seed.imported === 3, `seeded 3 real SKUs into the item master (${seed.imported})`);
  const pv1 = await importBundlesOffice(admin, CID, false);
  ok(pv1.status === 409, `409 preview (${pv1.status})`);
  ok(pv1.body.preview.willCreate === 2, `willCreate is 2 now the components exist (${pv1.body.preview.willCreate})`);
  ok(pv1.body.preview.skippedKitCount === 0, `nothing skipped (${pv1.body.preview.skippedKitCount})`);
  const ap1 = await importBundlesOffice(admin, CID, true);
  ok(ap1.status === 200 && ap1.body.kits === 2, `both kits defined (${ap1.status}, ${ap1.body.kits})`);
  const gb1 = await getBundlesOffice(admin, CID);
  const kit1 = gb1.find(b => b.bundle_sku === 'KIT-DESK-SETUP');
  const kit2 = gb1.find(b => b.bundle_sku === 'KIT-CABLE-6PK');
  ok(!!kit1 && kit1.components.length === 2, `kit1 has 2 components (${kit1 && kit1.components.length})`);
  ok(!!kit2 && kit2.components.length === 1 && kit2.components[0].sku === 'CBL-USBC-1M-WEXX' && kit2.components[0].qty === 6,
    `kit2 = CBL-USBC-1M-WEXX x6 (${kit2 && JSON.stringify(kit2.components)})`);
  ok(kit1.type === 'virtual' && kit2.type === 'virtual', `both bundles are virtual (${kit1.type}, ${kit2.type})`);

  console.log('\n=== a synced/uploaded order line carrying the kit SKU explodes into real components ===');
  const orderFile = xlsxOf(['Order Number', 'SKU', 'Qty'], [['ORD-BUNDLE-1', 'KIT-CABLE-6PK', 2]]);
  const fd = new FormData();
  fd.append('orderFile', new Blob([orderFile]), 'kit-order.xlsx');
  fd.append('client_name', CID);
  fd.append('arrange_delivery', 'no');
  const ur = await fetch(B + '/api/upload', { method: 'POST', headers: { 'x-auth-token': admin }, body: fd });
  const ud = await J(ur);
  ok(ur.status === 200, `order upload succeeded (${ur.status}) ${ur.status !== 200 ? JSON.stringify(ud) : ''}`);
  const ordersList = await J(await fetch(B + '/api/orders?range=all', { headers: { 'x-auth-token': admin } }));
  const list = Array.isArray(ordersList) ? ordersList : (ordersList.orders || []);
  const placed = list.find(o => o.order_number === 'ORD-BUNDLE-1');
  ok(!!placed, `order ORD-BUNDLE-1 is on the books`);
  const lineSkus = (placed && placed.items || []).map(i => i.sku);
  ok(lineSkus.includes('CBL-USBC-1M-WEXX') && !lineSkus.includes('KIT-CABLE-6PK'),
    `line exploded to the real component, not the kit code (${JSON.stringify(lineSkus)})`);
  const compLine = (placed.items || []).find(i => i.sku === 'CBL-USBC-1M-WEXX');
  ok(compLine && Number(compLine.qty) === 12, `qty = 2 (ordered) x 6 (per kit) = 12 (${compLine && compLine.qty})`);

  console.log('\n=== client portal bundle capability ===');
  const prof = await J(await fetch(B + '/api/master/client-profiles', { method: 'POST', headers: MH(admin), body: JSON.stringify({ client: CID }) }));
  ok(prof.client === CID, `profile exists for ${CID}`);
  const uFull = await createPortalUser(admin, CID, 'Full User', 'full', 'secret1');
  const uView = await createPortalUser(admin, CID, 'View User', 'view', 'secret2');
  ok(!!uFull.id && !!uView.id, `full-access and view-only logins created (${uFull.id}, ${uView.id})`);

  const ptok = await portalLogin(CID, uFull.id, 'secret1');
  const vtok = await portalLogin(CID, uView.id, 'secret2');
  ok(!!ptok && !!vtok, `both portal logins signed in`);

  const pList0 = await J(await fetch(B + '/api/portal/bundles', { headers: { 'x-auth-token': ptok } }));
  ok(Array.isArray(pList0) && pList0.length === 2, `portal sees the 2 office-defined bundles (${pList0.length})`);

  const vDeny = await fetch(B + '/api/portal/bundles', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': vtok },
    body: JSON.stringify({ bundle_sku: 'NOPE', components: [{ sku: 'MON-27-XXXXXXXWEMY', qty: 1 }] }) });
  const vDenyBody = await J(vDeny);
  ok(vDeny.status === 403 && vDenyBody.viewOnly === true, `view-only login refused (${vDeny.status})`);

  const badComp = await fetch(B + '/api/portal/bundles', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': ptok },
    body: JSON.stringify({ bundle_sku: 'PORTAL-KIT-1', components: [{ sku: 'DOES-NOT-EXIST', qty: 1 }] }) });
  const badCompBody = await J(badComp);
  ok(badComp.status === 400 && (badCompBody.unknownSkus || []).includes('DOES-NOT-EXIST'), `unknown component refused by name (${badComp.status}, ${JSON.stringify(badCompBody.unknownSkus)})`);

  const goodComp = await fetch(B + '/api/portal/bundles', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': ptok },
    body: JSON.stringify({ bundle_sku: 'PORTAL-KIT-1', components: [{ sku: 'MON-27-XXXXXXXWEMY', qty: 3 }] }) });
  const goodCompBody = await J(goodComp);
  ok(goodComp.status === 200 && goodCompBody.bundle_sku === 'PORTAL-KIT-1', `client-defined bundle saved (${goodComp.status})`);
  const officeSeesIt = await getBundlesOffice(admin, CID);
  ok(officeSeesIt.some(b => b.bundle_sku === 'PORTAL-KIT-1'), `office side sees the client-created bundle too (same account)`);

  console.log('\n=== bulk import via the portal, against a fresh client ===');
  const CID2 = 'DeskGear2';
  await importInventory(admin, CID2, [
    { sku: 'MON-27-XXXXXXXWEMY', name: '27" Monitor', stock_qty: 100 },
    { sku: 'KBD-WLESS-XXSSMY', name: 'Wireless Keyboard', stock_qty: 100 },
    { sku: 'CBL-USBC-1M-WEXX', name: 'USB-C Cable 1m', stock_qty: 100 },
  ]);
  await J(await fetch(B + '/api/master/client-profiles', { method: 'POST', headers: MH(admin), body: JSON.stringify({ client: CID2 }) }));
  const u2 = await createPortalUser(admin, CID2, 'Solo', 'full', 'secret3');
  const ptok2 = await portalLogin(CID2, u2.id, 'secret3');
  ok(!!ptok2, `second client's portal login signed in`);

  const fd2a = new FormData(); fd2a.append('file', new Blob([BUNDLE_FILE]), 'Bundle_Kitting.xlsx');
  const pr2 = await fetch(B + '/api/portal/bundles/import', { method: 'POST', headers: { 'x-auth-token': ptok2 }, body: fd2a });
  const pr2Body = await J(pr2);
  ok(pr2.status === 409 && pr2Body.needsBundleImportConfirm && pr2Body.preview.willCreate === 2,
    `portal bulk import previews correctly (${pr2.status}, willCreate=${pr2Body.preview && pr2Body.preview.willCreate})`);
  const fd2b = new FormData(); fd2b.append('file', new Blob([BUNDLE_FILE]), 'Bundle_Kitting.xlsx'); fd2b.append('confirm_apply', 'yes');
  const ap2 = await fetch(B + '/api/portal/bundles/import', { method: 'POST', headers: { 'x-auth-token': ptok2 }, body: fd2b });
  const ap2Body = await J(ap2);
  ok(ap2.status === 200 && ap2Body.kits === 2, `portal bulk import applied both kits (${ap2.status}, ${ap2Body.kits})`);

  const p2List = await J(await fetch(B + '/api/portal/bundles', { headers: { 'x-auth-token': ptok2 } }));
  ok(p2List.length === 2 && !p2List.some(b => b.bundle_sku === 'PORTAL-KIT-1'), `client isolation holds — no cross-client bleed (${p2List.length})`);

  const del = await fetch(B + '/api/portal/bundles/' + encodeURIComponent('PORTAL-KIT-1'), { method: 'DELETE', headers: { 'x-auth-token': ptok } });
  ok(del.status === 200, `client can delete their own bundle (${del.status})`);
  const afterDel = await getBundlesOffice(admin, CID);
  ok(!afterDel.some(b => b.bundle_sku === 'PORTAL-KIT-1'), `deleted bundle is gone office-side too`);

  console.log(`\n${fails.length ? 'FAIL: ' + fails.length + ' issue(s)' : 'ALL PASS'}`);
  await stopAll();
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('ERROR', e); await stopAll(); process.exit(1); });
