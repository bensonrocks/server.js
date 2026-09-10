// OneCart connector, end to end through the REAL server against a mock built
// to the v2 Swagger. Proves the whole loop: connect → test → pull → the orders
// land under "Betime Online" with channel, lines (bundle components, not the
// parent), address and tracking → re-pull imports nothing → late tracking is
// filled → completion marks the order shipped and READS IT BACK → labels come
// in through the one label pipeline → cancellations follow the touched/
// untouched asymmetry → auto-label at intake → a rate limit is reported →
// warehouse is refused → disconnect.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('/home/user/server.js/node_modules/playwright');

const S      = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT   = 4747, MPORT = 4748;
const B      = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
const DDIR   = path.join(S, 'oc-data');
const DBP    = path.join(DDIR, 'tenants', 'default', 'db.json');
const PDFDIR = path.join(S, 'oc-pdfs');
const MASTER = process.env.MASTER_KEY || '201432547E';
const KEY    = 'oc_test_key_123';

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kids = [];
function spawnLogged(args, env, log) {
  const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true });
  kids.push(c); return c;
}
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up: ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids.length = 0; await sleep(1200); }

const MH = tok => ({ 'Content-Type': 'application/json', 'x-master-key': MASTER, 'x-auth-token': tok });
const J  = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
async function login(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); if (!d.token) throw new Error('login ' + id + ' ' + JSON.stringify(d)); return d.token; }
async function orders(tok) { const d = await J(await fetch(B + '/api/orders?range=all', { headers: { 'x-auth-token': tok } })); return Array.isArray(d) ? d : (d.orders || []); }
const byNo = (list, n) => list.find(o => o.order_number === n);
const mockCalls = async () => J(await fetch(M + '/__ctl/calls'));
const readDb = async () => { await sleep(1000); return JSON.parse(fs.readFileSync(DBP, 'utf8')); };
const stateOf = (db, no) => { for (const b of db.batches || []) if ((b.orders || []).some(o => o.order_number === no)) return b.orderStates?.[no] || null; return null; };
const orderOf = (db, no) => { for (const b of db.batches || []) { const o = (b.orders || []).find(o => o.order_number === no); if (o) return { o, b }; } return null; };

async function makePdfs() {
  fs.rmSync(PDFDIR, { recursive: true, force: true }); fs.mkdirSync(PDFDIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  const specs = { 9001: ['585836014589150279', 'TT9001'], 9002: ['260907ABCDEF01', 'SPXSG0412345678'], 9003: ['172397910455623', 'LZSGD9999'], 9007: ['9007NEWORDER', 'LZSGD7777'] };
  for (const [id, [no, trk]] of Object.entries(specs)) {
    await page.setContent(`<div style="font:18px sans-serif"><h1>SHIPPING LABEL</h1><p>Order No: ${no}</p><p>Tracking: ${trk}</p><p>To: Test Buyer</p></div>`);
    fs.writeFileSync(path.join(PDFDIR, id + '.pdf'), await page.pdf({ format: 'A5' }));
  }
  await browser.close();
}

(async () => {
  await makePdfs();
  ok(fs.existsSync(path.join(PDFDIR, '9001.pdf')), 'label fixtures printed through Chromium');

  fs.rmSync(DDIR, { recursive: true, force: true });
  spawnLogged([path.join(S, 'onecart-mock.js')], { PORT: String(MPORT), OC_KEY: KEY, OC_PDF_DIR: PDFDIR }, path.join(S, 'oc-mock.log'));
  await waitUp(M + '/__ctl/calls');
  spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'oc-server.log'));
  await waitUp(B + '/api/version');
  await sleep(2500);

  const admin = await login('demo', 'demo');
  await fetch(B + '/api/master/users', { method: 'POST', headers: MH(admin), body: JSON.stringify({ id: 'whguy', name: 'WH', password: 'whguy123', role: 'warehouse' }) });

  console.log('\n=== connect ===');
  const wrong = await J(await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(admin), body: JSON.stringify({ clientName: 'Betime Online', apiKey: 'wrong-key', endpoint: M + '/api/v2', autoPullMinutes: 0 }) }));
  const tw = await J(await fetch(B + `/api/master/onecart/stores/${wrong.id}/test`, { method: 'POST', headers: MH(admin) }));
  ok(tw.ok === false && /401|UNAUTHORIZED|invalid/i.test(tw.error || ''), `a wrong key is refused in OneCart's own words (${tw.error})`);
  await fetch(B + `/api/master/onecart/stores/${wrong.id}`, { method: 'DELETE', headers: MH(admin) });

  const noKey = await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(admin), body: JSON.stringify({ clientName: 'Betime Online', autoPullMinutes: 0 }) });
  ok(noKey.status === 400, `a store with no key is refused (${noKey.status})`);

  const st = await J(await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(admin),
    // mode:'work' — this suite covers the ORIGINAL work-order behaviour; the
    // reference-ledger default has its own suite (onecart-ref-e2e.js).
    body: JSON.stringify({ clientName: 'Betime Online', apiKey: KEY, endpoint: M + '/api/v2', autoPullMinutes: 0, completeAction: 'ship', labelSync: 'off', mode: 'work', enabled: true }) }));
  ok(!!st.id && st.clientName === 'Betime Online' && st.mode === 'work', `store saved for "${st.clientName}" in work mode`);
  ok(st.apiKey === '••••_123' && !JSON.stringify(st).includes(KEY), `the key is masked on read (${st.apiKey})`);
  const SID = st.id;
  const t = await J(await fetch(B + `/api/master/onecart/stores/${SID}/test`, { method: 'POST', headers: MH(admin) }));
  ok(t.ok && t.company === 'Betime Online Pte Ltd' && t.key === 'IdealOne', `Test names the company and the key (${t.company} / ${t.key})`);

  console.log('\n=== first pull ===');
  const p1 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p1.ok && p1.fetched === 4, `4 orders waiting on the channel (${p1.fetched})`);
  ok(p1.imported === 3, `3 imported (${p1.imported})`);
  ok(Array.isArray(p1.skippedNoLines) && p1.skippedNoLines.includes('NOLINES-1'), `the order with no product lines is skipped BY NAME (${JSON.stringify(p1.skippedNoLines)})`);
  ok(p1.skippedExisting === 0, 'nothing already held');
  let list = await orders(admin);
  const o1 = byNo(list, '585836014589150279'), o2 = byNo(list, '260907ABCDEF01'), o3 = byNo(list, '172397910455623');
  ok(o1 && o2 && o3, 'all three are on the Orders list');
  ok(!byNo(list, '9004CANCELLED') && !byNo(list, 'SHIPPED-ALREADY') && !byNo(list, 'NOLINES-1'), 'the cancelled, already-shipped and line-less orders are NOT imported');
  ok(o1 && o1.client_name === 'Betime Online', `filed under Betime Online (${o1 && o1.client_name})`);
  ok(o1 && o1.platform === 'TikTok' && o2.platform === 'Shopee' && o3.platform === 'Lazada', `each order carries its channel (${o1 && o1.platform}/${o2 && o2.platform}/${o3 && o3.platform})`);
  const skus = (o1.items || []).map(i => i.sku);
  ok(skus.includes('K5008') && skus.includes('KOLI-BOX 9') && skus.includes('KOLI-BOX 5'), `bundle COMPONENTS are pick lines (${skus.join(', ')})`);
  ok(!skus.includes('KOLI-BUNDLE'), 'the bundle PARENT is not a pick line');
  ok((o1.items || []).find(i => i.sku === 'K5008')?.qty === 2 || (o1.items || []).find(i => i.sku === 'K5008')?.ordered === 2, 'quantities carried');
  ok(o1.customer_name === 'Ali Tan' && /640012/.test(o1.delivery_address || '') && o1.tel === '91234567', `customer, address+postal and phone carried (${o1.customer_name}, ${o1.delivery_address})`);
  ok(o2.waybill_number === 'SPXSG0412345678', `a tracking number the channel already had is on the order (${o2.waybill_number}) — read from /orders, since /delivery_orders has none`);
  ok(!o3.waybill_number, 'an order the channel has not tracked yet is blank, not invented');
  let calls = await mockCalls();
  ok(!calls.some(c => c.path.endsWith('/print_awbs')), 'labelSync off: the channel was NOT asked to generate labels');
  ok(calls.filter(c => c.path === '/api/v2/delivery_orders').length === 1 && calls.filter(c => c.path === '/api/v2/orders').length === 1, 'one queue read + one sweep read per pull');
  const db1 = await readDb();
  ok(orderOf(db1, '585836014589150279')?.o.onecart_id === '9001' && orderOf(db1, '585836014589150279')?.o.onecart_store_id === SID, 'onecart_id + store stamped on the stored order');
  ok(orderOf(db1, '585836014589150279')?.b.uploaded_by === 'onecart-sync' && /^onecart-Betime_Online/.test(orderOf(db1, '585836014589150279')?.b.filename), `the batch is named for the sync (${orderOf(db1, '585836014589150279')?.b.filename})`);

  console.log('\n=== isolation: an order held OUTSIDE this connection is never touched ===');
  // A hand-keyed order under BETIME that shares a marketplace number the
  // channel later lists. Keyed in through the partner intake door.
  const keyMint = await J(await fetch(B + '/api/master/api-keys', { method: 'POST', headers: MH(admin), body: JSON.stringify({ name: 'e2e-intake', scopes: ['orders:write'] }) }));
  ok(!!keyMint.key, 'minted a partner key to key an order in by hand');
  const kin = await J(await fetch(B + '/api/orders/intake', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': keyMint.key },
    body: JSON.stringify({ client: 'BETIME', on_short: 'proceed', orders: [{ order_number: '9008SHARED', lines: [{ sku: '8006', qty: 1, description: 'Koli Herbal Patch' }] }] }) }));
  ok(kin.created === 1, `a BETIME order 9008SHARED keyed in by hand (${JSON.stringify(kin).slice(0, 80)})`);
  await fetch(M + '/__ctl/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 9008, order_no: '9008SHARED', platform: 'Lazada', shop_id: 13, shop_name: 'Betime Lazada', status: 'pending', tracking_no: 'LZSGD8008', first_name: 'Sh', last_name: 'Ared', shipping_address: '1 Somewhere', shipping_postal_code: '333333', shipping_phone_number: '', line_items: [{ sku: '8006', quantity: 1, name: 'Koli Herbal Patch', is_bundle_component: false }] }) });
  const pi = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(pi.imported === 0, `the shared number is NOT imported a second time (${pi.imported})`);
  ok(pi.heldElsewhereCount === 1 && pi.heldElsewhere[0].order === '9008SHARED' && pi.heldElsewhere[0].client === 'BETIME', `and is reported BY NAME with the client holding it (${JSON.stringify(pi.heldElsewhere)})`);
  ok(pi.skippedExisting === 3, 'it is not counted among our own held orders');
  let heldList = await orders(admin);
  ok(byNo(heldList, '9008SHARED').client_name === 'BETIME' && !byNo(heldList, '9008SHARED').waybill_number, 'the BETIME order kept its client and its BLANK waybill — the channel\'s tracking number was not written onto it');
  await fetch(M + '/__ctl/cancel/9008', { method: 'POST' });
  const pi2 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(pi2.cancelled === 0 && (pi2.cancelConflicts || []).length === 0, 'a cancellation on the channel does nothing to the hand-keyed order');
  heldList = await orders(admin);
  ok(byNo(heldList, '9008SHARED').scan_status !== 'unprocessed', `it is still ${byNo(heldList, '9008SHARED').scan_status}`);
  // /api/putaway/clients lists names in use (batches included), so it is not
  // the question. catalogue-clients is built from inventory.listClientIds():
  // exactly "who HAS an item master".
  const catClients = await J(await fetch(B + '/api/master/zort/catalogue-clients', { headers: MH(admin) }));
  const names = (Array.isArray(catClients) ? catClients : (catClients.clients || [])).map(c => String(c.name || c.client || c.id || c).toLowerCase());
  ok(!names.includes('betime online'), `no item master was learned for Betime Online — the feed never reached inventory (masters: ${names.join(', ') || 'none'})`);
  ok(byNo(heldList, '585836014589150279').stock_state === undefined || byNo(heldList, '585836014589150279').stock_state === null || !byNo(heldList, '585836014589150279').stock, 'and the synced order carries no stock verdict at all');

  console.log('\n=== the synced order carries the SAME attributes as a hand-keyed one ===');
  const handKeyed = byNo(heldList, '9008SHARED'), synced = byNo(heldList, '585836014589150279');
  const missing = Object.keys(handKeyed).filter(k => !(k in synced));
  ok(missing.length === 0, `every attribute on the hand-keyed order is on the synced one (${missing.length ? 'missing: ' + missing.join(', ') : Object.keys(handKeyed).length + ' keys'})`);
  const lineKeysHand = Object.keys((handKeyed.items || [])[0] || {}), lineKeysSync = Object.keys((synced.items || [])[0] || {});
  const lineMissing = lineKeysHand.filter(k => !lineKeysSync.includes(k));
  ok(lineMissing.length === 0, `and every LINE attribute too (${lineMissing.length ? 'missing: ' + lineMissing.join(', ') : lineKeysHand.length + ' keys'})`);
  const todaySG = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const dbA = await readDb();
  const oA = orderOf(dbA, '585836014589150279').o;
  ok(oA.date === todaySG, `date = the order's own placed day, SGT (${oA.date})`);
  ok(oA.shop_name === 'Betime TikTok' && oA.carrier === 'J&T Express' && oA.platform === 'TikTok', `shop, carrier and platform all filled (${oA.shop_name} / ${oA.carrier} / ${oA.platform})`);
  ok(oA.issue_no === '' && oA.po_number === '' && oA.pick_ticket === '', 'fields OneCart does not carry are honestly blank, never invented');
  ok(oA.lines[0].uom === 'EACH' && 'batch_number' in oA.lines[0] && 'expiry_date' in oA.lines[0] && 'location' in oA.lines[0], 'lines have the standard shape');

  console.log('\n=== re-pull is idempotent; late tracking is filled ===');
  const p2 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p2.imported === 0 && p2.skippedExisting === 3, `second pull imports nothing, 3 held (${p2.imported}/${p2.skippedExisting})`);
  await fetch(M + '/__ctl/track/9003?no=LZSGD9999', { method: 'POST' });
  const p3 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p3.trackingFilled === 1, `a tracking number assigned later is filled on the next pull (${p3.trackingFilled})`);
  list = await orders(admin);
  ok(byNo(list, '172397910455623').waybill_number === 'LZSGD9999', 'and it is on the order');
  ok(byNo(list, '260907ABCDEF01').waybill_number === 'SPXSG0412345678', 'an existing waybill was never overwritten');

  console.log('\n=== completion marks the order shipped — and reads it back ===');
  const inc = await J(await fetch(B + '/api/scan/increment', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': admin }, body: JSON.stringify({ orderNumber: '260907ABCDEF01', sku: 'K5008' }) }));
  ok(!inc.error, `scanned the one piece (${JSON.stringify(inc).slice(0, 60)})`);
  const done = await J(await fetch(B + '/api/scan/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': admin }, body: JSON.stringify({ orderNumber: '260907ABCDEF01', startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) }));
  ok(done.ok === true, `completed (${JSON.stringify(done).slice(0, 80)})`);
  await sleep(6500);
  calls = await mockCalls();
  const put = calls.find(c => c.method === 'PUT' && c.path === '/api/v2/orders/9002');
  ok(!!put && put.body.mark_as_shipped === true, 'PUT /orders/9002 mark_as_shipped was sent');
  ok(calls.filter(c => c.method === 'GET' && c.path === '/api/v2/orders/9002').length >= 1, 'and the order was READ BACK afterwards');
  const dbC = await readDb();
  const stC = stateOf(dbC, '260907ABCDEF01');
  ok(!!stC?.onecart_shipped_at && /ship/i.test(stC.onecart_ship_status || ''), `confirmed shipped only once the channel's status moved (${stC?.onecart_ship_status})`);
  ok((dbC.auditLog || []).some(e => e.type === 'onecart_completion_pushed' && e.order === '260907ABCDEF01' && /ship/i.test(e.hubStatus || '')), 'audited onecart_completion_pushed with the hub status');
  ok(!(dbC.auditLog || []).some(e => e.type === 'onecart_completion_pushed' && e.order !== '260907ABCDEF01'), 'no other order was pushed');
  const oc = require('/home/user/server.js/lib/onecart.js');
  ok(!oc.isShippedStatus('ready_to_ship') && oc.isShippedStatus('shipped') && oc.isShippedStatus('COMPLETED') && !oc.isShippedStatus('pending'), 'ready_to_ship is NOT read as shipped');

  console.log('\n=== 🏷 Get Labels ===');
  const lb = await J(await fetch(B + `/api/master/onecart/stores/${SID}/labels`, { method: 'POST', headers: MH(admin) }));
  ok(lb.ok && lb.requested === 3, `asked for the 3 open, unlabelled orders (${lb.requested})`);
  ok(lb.attached.length === 3 && lb.noLabel.length === 0 && lb.unusable.length === 0, `all 3 attached — a URL label, a base64 label and a per-package TikTok label (${JSON.stringify(lb)})`);
  calls = await mockCalls();
  const pj = calls.find(c => c.path.endsWith('/print_awbs'));
  ok(!!pj && JSON.stringify(pj.body.order_ids.slice().sort()) === JSON.stringify([9001, 9002, 9003]), `print_awbs called with exactly those ids (${pj && JSON.stringify(pj.body.order_ids)})`);
  await sleep(1200);
  const dbL = await readDb();
  ok(!!dbL.orderLabels?.['585836014589150279'] && !!dbL.orderLabels?.['260907ABCDEF01'] && !!dbL.orderLabels?.['172397910455623'], 'each order has its label on disk');
  ok(!JSON.stringify(dbL.auditLog).includes('/awb/'), 'no label URL anywhere on the audit trail');
  ok((dbL.auditLog || []).some(e => e.type === 'onecart_labels_fetched' && e.attached === 3), 'audited onecart_labels_fetched');
  const lb2 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/labels`, { method: 'POST', headers: MH(admin) }));
  ok(lb2.requested === 0, 'a second Get Labels has nothing left to ask for');

  console.log('\n=== cancellations: untouched closes, touched is flagged ===');
  await fetch(M + '/__ctl/cancel/9003?reason=Buyer%20changed%20mind', { method: 'POST' });
  const p4 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p4.cancelled === 1, `an UNTOUCHED pending order is cancelled here (${p4.cancelled})`);
  let db4 = await readDb();
  const s3 = stateOf(db4, '172397910455623');
  ok(s3?.status === 'unprocessed' && /OneCart/.test(s3.unprocessed_reason || '') && /cancelled/i.test(s3.unprocessed_reason || '') && !!s3.unprocessed_at, `unprocessed, dated, with the channel's word (${s3?.unprocessed_reason})`);
  const inc2 = await J(await fetch(B + '/api/scan/increment', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': admin }, body: JSON.stringify({ orderNumber: '585836014589150279', sku: 'K5008' }) }));
  ok(!inc2.error, 'a piece scanned on the TikTok order (it is now touched work)');
  await fetch(M + '/__ctl/cancel/9001', { method: 'POST' });
  const p5 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p5.cancelled === 0 && Array.isArray(p5.cancelConflicts) && p5.cancelConflicts.includes('585836014589150279'), `TOUCHED work is never regressed — flagged as a conflict (${JSON.stringify(p5.cancelConflicts)})`);
  db4 = await readDb();
  const s1 = stateOf(db4, '585836014589150279');
  ok(s1?.status === 'processing' && s1.platform_cancelled?.via === 'onecart' && s1.platform_cancelled.scanned === 1, `still processing, platform_cancelled stamped (${s1?.status}, via ${s1?.platform_cancelled?.via})`);
  const p6 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p6.cancelled === 0 && (p6.cancelConflicts || []).length === 0, 're-pull re-stamps nothing');
  ok(((await readDb()).auditLog || []).filter(e => e.type === 'sync_marketplace_cancel_conflict' && e.via === 'onecart').length === 1, 'exactly one conflict audit entry');

  console.log('\n=== labels at intake, once switched on ===');
  await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(admin), body: JSON.stringify({ id: SID, labelSync: 'intake' }) });
  const stAfter = (await J(await fetch(B + '/api/master/onecart/stores', { headers: MH(admin) }))).find(x => x.id === SID);
  ok(stAfter.labelSync === 'intake' && stAfter.apiKey === '••••_123', 'labelSync saved; a blank key kept the stored one');
  await fetch(M + '/__ctl/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 9007, order_no: '9007NEWORDER', platform: 'Lazada', shop_id: 13, shop_name: 'Betime Lazada', status: 'pending', tracking_no: 'LZSGD7777', first_name: 'New', last_name: 'Buyer', shipping_address: '5 Bukit Timah Rd', shipping_postal_code: '229899', shipping_phone_number: '90001111', line_items: [{ sku: '8006', quantity: 1, name: 'Koli Herbal Patch', is_bundle_component: false }] }) });
  const before = (await mockCalls()).filter(c => c.path.endsWith('/print_awbs')).length;
  const p7 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p7.imported === 1 && p7.labels && p7.labels.attached === 1 && p7.labels.requested === 1, `new order imported and its label fetched at intake (${JSON.stringify(p7.labels)})`);
  calls = await mockCalls();
  const pj2 = calls.filter(c => c.path.endsWith('/print_awbs'));
  ok(pj2.length === before + 1 && JSON.stringify(pj2[pj2.length - 1].body.order_ids) === '[9007]', 'print_awbs asked for the NEW order only');
  await sleep(1000);
  ok(!!(await readDb()).orderLabels?.['9007NEWORDER'], 'its label is on the order');
  ok(byNo(await orders(admin), '9007NEWORDER')?.waybill_number === 'LZSGD7777', 'and its tracking number came with it');

  console.log('\n=== the channel says no ===');
  await fetch(M + '/__ctl/rate-limit-once', { method: 'POST' });
  const rl = await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) });
  const rlj = await J(rl);
  ok(rl.status === 502 && /rate limit/i.test(rlj.error || ''), `a 429 is reported as a rate limit, not swallowed (${rl.status}: ${rlj.error})`);
  const stRl = (await J(await fetch(B + '/api/master/onecart/stores', { headers: MH(admin) }))).find(x => x.id === SID);
  ok(/rate limit/i.test(stRl.lastResult?.error || ''), 'and it is on the store row');
  const p8 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p8.ok === true, 'the next pull is fine again');

  console.log('\n=== access ===');
  const wh = await login('whguy', 'whguy123');
  const whr = await fetch(B + '/api/master/onecart/stores', { headers: { 'x-auth-token': wh } });
  ok(whr.status === 401 || whr.status === 403, `warehouse cannot read the connection (${whr.status})`);
  const whp = await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: { 'x-auth-token': wh } });
  ok(whp.status === 401 || whp.status === 403, `warehouse cannot pull (${whp.status})`);
  const del = await J(await fetch(B + `/api/master/onecart/stores/${SID}`, { method: 'DELETE', headers: MH(admin) }));
  ok(del.ok === true, 'disconnected');
  ok((await J(await fetch(B + '/api/master/onecart/stores', { headers: MH(admin) }))).length === 0, 'no stores left');
  ok((await orders(admin)).length >= 4, 'pulled orders stay after disconnecting');

  await stopAll();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error(e); await stopAll(); process.exit(1); });
