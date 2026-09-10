// OneCart REFERENCE mode (the default), end to end through the REAL server
// against the spec mock. Per the user: Betime Online's synced orders are NOT
// orders — not in any counter, never scanned — and the client's own upload
// of the same number is not a duplicate: a prompt ("exists in Betime Online,
// carry on?") and then it goes through as the work order.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('/home/user/server.js/node_modules/xlsx');

const S      = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT   = 4751, MPORT = 4752;
const B      = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
const DDIR   = path.join(S, 'oc-ref-data');
const DBP    = path.join(DDIR, 'tenants', 'default', 'db.json');
const PDFDIR = path.join(S, 'oc-pdfs');
const MASTER = process.env.MASTER_KEY || '201432547E';
const KEY    = 'oc_test_key_123';
const T0     = new Date().toISOString();

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kids = [];
function spawnLogged(args, env, log) {
  const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true });
  kids.push(c); return c;
}
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up: ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids = []; await sleep(1500); }
async function bootServer() {
  spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'oc-ref-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
}

const MH = tok => ({ 'Content-Type': 'application/json', 'x-master-key': MASTER, 'x-auth-token': tok });
const J  = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
async function login(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); if (!d.token) throw new Error('login ' + id + ' ' + JSON.stringify(d)); return d.token; }
async function orders(tok) { const d = await J(await fetch(B + '/api/orders?range=all', { headers: { 'x-auth-token': tok } })); return Array.isArray(d) ? d : (d.orders || []); }
async function stats(tok) { return J(await fetch(B + '/api/stats', { headers: { 'x-auth-token': tok } })); }
const byNo = (list, n) => list.filter(o => o.order_number === n);
const mockCalls = async () => J(await fetch(M + '/__ctl/calls'));
const readDb = async () => { await sleep(1200); return JSON.parse(fs.readFileSync(DBP, 'utf8')); };
const batchesOf = (db, no) => (db.batches || []).filter(b => (b.orders || []).some(o => o.order_number === no));

function xlsxOf(rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
async function upload(tok, buf, name, extra = {}) {
  const fd = new FormData();
  fd.append('orderFile', new Blob([buf]), name);
  fd.append('client_name', 'BETIME');
  fd.append('arrange_delivery', 'no');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = await fetch(B + '/api/upload', { method: 'POST', headers: { 'x-auth-token': tok }, body: fd });
  return { status: r.status, body: await J(r) };
}
async function preview(tok, buf, name) {
  const fd = new FormData();
  fd.append('orderFile', new Blob([buf]), name);
  fd.append('client_name', 'BETIME');
  const r = await fetch(B + '/api/preview', { method: 'POST', headers: { 'x-auth-token': tok }, body: fd });
  return { status: r.status, body: await J(r) };
}
async function scan(tok, orderNumber, sku) {
  const r = await fetch(B + '/api/scan/increment', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': tok }, body: JSON.stringify({ orderNumber, sku, eventId: 'ev-' + Math.random().toString(36).slice(2) }) });
  return { status: r.status, body: await J(r) };
}
async function complete(tok, orderNumber) {
  const r = await fetch(B + '/api/scan/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': tok }, body: JSON.stringify({ orderNumber, startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) });
  return { status: r.status, body: await J(r) };
}

const NO1 = '585836014589150279';   // mock 9001, TikTok, K5008 x2 + a bundle
const NO3 = '172397910455623';      // mock 9003, Lazada, no tracking yet

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  spawnLogged([path.join(S, 'onecart-mock.js')], { PORT: String(MPORT), OC_KEY: KEY, OC_PDF_DIR: PDFDIR }, path.join(S, 'oc-ref-mock.log'));
  await waitUp(M + '/__ctl/calls');
  await bootServer();
  const admin = await login('demo', 'demo');

  console.log('\n=== connect: reference is the DEFAULT ===');
  const st = await J(await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(admin),
    body: JSON.stringify({ clientName: 'Betime Online', apiKey: KEY, endpoint: M + '/api/v2', autoPullMinutes: 0, completeAction: 'ship', labelSync: 'off', enabled: true }) }));
  const SID = st.id;
  ok(!!SID && st.mode === 'reference', `a store saved with no mode named is a REFERENCE ledger (${st.mode})`);

  console.log('\n=== pull: the ledger fills, the counters do not ===');
  const s0 = await stats(admin);
  const p1 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p1.ok && p1.imported === 3, `3 reference records imported (${p1.imported})`);
  const s1 = await stats(admin);
  ok(s1.totalOrders === s0.totalOrders && s1.pendingBacklog === s0.pendingBacklog && s1.todayPending === s0.todayPending,
    `NOT in the order counter: totalOrders ${s0.totalOrders}→${s1.totalOrders}, backlog ${s0.pendingBacklog}→${s1.pendingBacklog}, todayPending ${s0.todayPending}→${s1.todayPending}`);
  ok(s1.referenceOrders === 3, `counted APART as reference records (${s1.referenceOrders})`);
  ok(!(s1.clientStats || []).some(c => c.name === 'Betime Online'), 'Betime Online is not on the today/yesterday client tiles');
  ok((s1.kpi.overdue + s1.kpi.critical + s1.kpi.dueSoon + s1.kpi.onTime) === (s0.kpi.overdue + s0.kpi.critical + s0.kpi.dueSoon + s0.kpi.onTime), 'nothing added to the fulfilment KPI tiles');
  let list = await orders(admin);
  ok(byNo(list, NO1).length === 1 && byNo(list, NO1)[0].reference_only === true && byNo(list, NO1)[0].client_name === 'Betime Online', 'the record is on the list flagged reference_only under Betime Online');
  ok(list.filter(o => o.reference_only).length === 3, 'all three carry the flag');
  const db1 = await readDb();
  const rb = batchesOf(db1, NO1)[0];
  ok(rb && rb.reference_only === true && rb.onecart_store_id === SID && rb.uploaded_by === 'onecart-sync', 'the batch is stamped reference_only + store id');
  ok(!(db1.pokes || []).some(p => /betime online/i.test(p.client || '')), 'no "New Work" poke was raised — a reference record is not work');
  ok(!rb.inventory_tracked, 'nothing reserved');

  console.log('\n=== a reference record is never scanned ===');
  const sc = await scan(admin, NO1, 'K5008');
  ok(sc.status === 409 && sc.body.referenceOnly === true && /reference record/i.test(sc.body.error), `scan refused 409 referenceOnly (${sc.status}: ${String(sc.body.error).slice(0, 70)})`);
  const cp = await complete(admin, NO1);
  ok(cp.status === 409 && cp.body.referenceOnly === true, `complete refused too (${cp.status})`);
  const db2 = await readDb();
  ok(!batchesOf(db2, NO1)[0].orderStates?.[NO1]?.scanned?.K5008, 'and nothing was counted');

  console.log('\n=== the SAME number uploaded under BETIME is not a duplicate ===');
  const FILE = xlsxOf([{ 'Order No': NO1, 'SKU Code': 'K5008', 'Quantity': 2 }]);
  const pv = await preview(admin, FILE, 'betime-pick.xlsx');
  const pvText = JSON.stringify(pv.body);
  ok(pv.status === 200 && /reference record/i.test(pvText) && /carry on/i.test(pvText), `the Confirm-Upload preview says it exists as a reference record and will ask to carry on`);
  ok(!/will be blocked|Overwrite or Abort/.test(pvText), 'the preview does NOT call it blocked or overwritable');
  const u1 = await upload(admin, FILE, 'betime-pick.xlsx');
  ok(u1.status === 409 && u1.body.needsReferenceConfirm === true, `upload asks first: 409 needsReferenceConfirm (${u1.status} ${Object.keys(u1.body).join(',')})`);
  ok(!u1.body.needsOverwriteConfirm && !u1.body.needsDuplicateConfirm, 'not the overwrite tier, not the recycled-number tier');
  ok(u1.body.duplicates?.[0]?.order === NO1 && u1.body.duplicates[0].client === 'Betime Online' && /Betime Online/.test(u1.body.message) && /carry on/i.test(u1.body.message),
    `names the order and the ledger it is in ("${String(u1.body.message).slice(0, 90)}…")`);
  const s2 = await stats(admin);
  ok(s2.totalOrders === s1.totalOrders, 'asking wrote nothing');
  const u2 = await upload(admin, FILE, 'betime-pick.xlsx', { confirm_reference: 'yes' });
  ok(u2.status === 200 && (u2.body.ok !== false), `carry on → the upload goes through (${u2.status} ${JSON.stringify(u2.body).slice(0, 80)})`);
  const s3 = await stats(admin);
  ok(s3.totalOrders === s1.totalOrders + 1 && s3.pendingBacklog === s1.pendingBacklog + 1 && s3.referenceOrders === 3,
    `the WORK order counts (+1 → ${s3.totalOrders}), the reference is still apart (${s3.referenceOrders})`);
  list = await orders(admin);
  const rows1 = byNo(list, NO1);
  ok(rows1.length === 1 && rows1[0].client_name === 'BETIME' && rows1[0].reference_only === false, `ONE row for the number and it is BETIME's work order (${rows1.length} row(s), ${rows1[0]?.client_name})`);
  ok(rows1[0].reference_twin === 'Betime Online', `the work order says the channel also holds it (reference_twin=${rows1[0].reference_twin})`);
  const db3 = await readDb();
  ok(batchesOf(db3, NO1).length === 2 && batchesOf(db3, NO1).some(b => b.reference_only) && batchesOf(db3, NO1).some(b => !b.reference_only), 'both records exist on disk — the reference was NOT removed or overwritten');
  ok((db3.auditLog || []).some(e => e.type === 'upload_reference_confirmed' && e.at > T0), 'audited upload_reference_confirmed');
  const wl = await J(await fetch(B + '/api/waybill-lookup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': admin }, body: JSON.stringify({ waybill: NO1 }) }));
  ok(wl.order_number === NO1 && wl.client_name === 'BETIME' && !wl.reference_only, `the scan-to-find bar resolves to the WORK order (${wl.client_name})`);

  console.log('\n=== scanning lands on the work order and completion is relayed through the ledger ===');
  const sc1 = await scan(admin, NO1, 'K5008'); const sc2 = await scan(admin, NO1, 'K5008');
  ok(sc1.status === 200 && sc2.status === 200, `scans accepted on the work order (${sc1.status}/${sc2.status})`);
  const db4 = await readDb();
  const wb = batchesOf(db4, NO1).find(b => !b.reference_only), rfb = batchesOf(db4, NO1).find(b => b.reference_only);
  ok(wb.orderStates?.[NO1]?.scanned?.K5008 === 2 && !rfb.orderStates?.[NO1]?.scanned?.K5008, 'the pieces are on BETIME\'s state, none on the reference');
  const cpl = await complete(admin, NO1);
  ok(cpl.status === 200 && cpl.body.ok !== false, `completed (${cpl.status} ${JSON.stringify(cpl.body).slice(0, 60)})`);
  await sleep(9000);
  const calls = await mockCalls();
  const shipCall = calls.find(c => /^PUT$/i.test(c.method || '') && /\/orders\/9001$/.test(c.path));
  ok(!!shipCall, `the channel was told SHIPPED through the reference twin's id (PUT /orders/9001 seen: ${!!shipCall})`);
  const db5 = await readDb();
  const pushed = (db5.auditLog || []).find(e => (e.type === 'onecart_completion_pushed' || e.type === 'onecart_completion_unconfirmed') && e.order === NO1);
  ok(pushed && pushed.viaReference === true, `audited as relayed via the reference (${pushed && pushed.type}, viaReference=${pushed && pushed.viaReference})`);
  const wst = batchesOf(db5, NO1).find(b => !b.reference_only).orderStates[NO1];
  ok(wst.status === 'done' && !!wst.onecart_ship_requested_at, 'the stamp landed on the WORK order\'s state (never pushed twice)');
  const s4 = await stats(admin);
  ok(s4.totalDone === s3.totalDone + 1 && s4.referenceOrders === 3, `Processed count +1, reference count unchanged (${s4.totalDone}, ${s4.referenceOrders})`);

  console.log('\n=== the sweep still updates OUR copy beside the work order ===');
  await fetch(M + '/__ctl/track/9003?no=LZSGD9999', { method: 'POST' });
  const p2 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  // 9001 was marked SHIPPED on the channel by the completion above, so it has
  // left the unshipped queue — 2 of ours remain there. Its tracking number was
  // minted at ship time, so the sweep fills the 9001 reference too (the work
  // order got it from the ship read-back): 2 fills, both on reference rows.
  ok(p2.imported === 0 && p2.skippedExisting === 2 && !p2.heldElsewhereCount, `re-pull: nothing imported, the 2 still in the queue found as OURS, nothing "held elsewhere" (${p2.imported}/${p2.skippedExisting}/${p2.heldElsewhereCount || 0})`);
  ok(p2.trackingFilled === 2, `late tracking filled on the reference records — 9003's and shipped 9001's (${p2.trackingFilled})`);
  list = await orders(admin);
  ok(byNo(list, NO3)[0]?.waybill_number === 'LZSGD9999', 'and it shows on the ledger row');
  const db4b = await readDb();
  ok(!!batchesOf(db4b, NO1).find(b => b.reference_only).orders.find(o => o.order_number === NO1).waybill_number, 'the shipped order\'s reference copy carries the channel tracking too');

  console.log('\n=== upload FIRST, channel later: the ledger still gets its record, the work order still wins ===');
  const FILE2 = xlsxOf([{ 'Order No': '9009FIRST', 'SKU Code': '8006', 'Quantity': 1 }]);
  const u3 = await upload(admin, FILE2, 'betime-pick-2.xlsx');
  ok(u3.status === 200, `BETIME uploads 9009FIRST before the channel lists it (${u3.status})`);
  await fetch(M + '/__ctl/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 9009, order_no: '9009FIRST', platform: 'Lazada', shop_id: 13, shop_name: 'Betime Lazada', status: 'pending', tracking_no: 'LZSGD9009', first_name: 'Up', last_name: 'First', shipping_address: '1 Somewhere', shipping_postal_code: '333333', shipping_phone_number: '', line_items: [{ sku: '8006', quantity: 1, name: 'Koli Herbal Patch', is_bundle_component: false }] }) });
  const p3 = await J(await fetch(B + `/api/master/onecart/stores/${SID}/pull`, { method: 'POST', headers: MH(admin) }));
  ok(p3.imported === 1 && p3.heldElsewhereCount === 1 && p3.heldElsewhere[0].client === 'BETIME', `the reference record is imported anyway and BETIME's copy is named (${p3.imported}, ${JSON.stringify(p3.heldElsewhere)})`);
  list = await orders(admin);
  const r9 = byNo(list, '9009FIRST');
  ok(r9.length === 1 && r9[0].client_name === 'BETIME' && r9[0].reference_twin === 'Betime Online' && !r9[0].waybill_number,
    `one row, BETIME's, twin named, and the channel's tracking was NOT written onto BETIME's order (${r9[0]?.client_name}, wb=${r9[0]?.waybill_number || '—'})`);
  const sc9 = await scan(admin, '9009FIRST', '8006');
  const db6 = await readDb();
  ok(sc9.status === 200 && batchesOf(db6, '9009FIRST').find(b => !b.reference_only).orderStates['9009FIRST'].scanned['8006'] === 1
    && !batchesOf(db6, '9009FIRST').find(b => b.reference_only).orderStates?.['9009FIRST']?.scanned?.['8006'],
    'a scan on that number lands on BETIME\'s order even though the reference batch is NEWER');
  const s5 = await stats(admin);
  ok(s5.referenceOrders === 4 && s5.totalOrders === s3.totalOrders + 1, `ledger 4, work orders +1 (${s5.referenceOrders}, ${s5.totalOrders})`);

  console.log('\n=== the mode switch re-files the history ===');
  await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(admin), body: JSON.stringify({ id: SID, mode: 'work' }) });
  const s6 = await stats(admin);
  ok(s6.referenceOrders === 0 && s6.totalOrders === s5.totalOrders + 4, `work mode: the 4 records become orders and count (${s6.referenceOrders}, ${s6.totalOrders})`);
  await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(admin), body: JSON.stringify({ id: SID, mode: 'reference' }) });
  const s7 = await stats(admin);
  ok(s7.referenceOrders === 4 && s7.totalOrders === s5.totalOrders, `back to reference: filed apart again (${s7.referenceOrders}, ${s7.totalOrders})`);
  const db7 = await readDb();
  ok((db7.auditLog || []).some(e => e.type === 'onecart_store_saved' && e.mode === 'work' && e.restampedBatches >= 1), 'the switch is on the trail with how many batches it re-filed');

  console.log('\n=== a batch synced BEFORE this existed is filed at boot ===');
  await stopAll();
  const raw = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  let stripped = 0;
  for (const b of raw.batches || []) if (b.uploaded_by === 'onecart-sync') { delete b.reference_only; delete b.onecart_store_id; stripped++; }
  fs.writeFileSync(DBP, JSON.stringify(raw, null, 2));
  ok(stripped >= 2, `simulated ${stripped} pre-existing synced batch(es) carrying no flag`);
  spawnLogged([path.join(S, 'onecart-mock.js')], { PORT: String(MPORT), OC_KEY: KEY, OC_PDF_DIR: PDFDIR }, path.join(S, 'oc-ref-mock.log'));
  await waitUp(M + '/__ctl/calls');
  await bootServer();
  const admin2 = await login('demo', 'demo');
  const s8 = await stats(admin2);
  ok(s8.referenceOrders === 4 && s8.totalOrders === s5.totalOrders, `after restart they are reference records again (${s8.referenceOrders}, ${s8.totalOrders})`);
  const db8 = await readDb();
  ok((db8.auditLog || []).some(e => e.type === 'onecart_reference_batches_stamped' && e.count === stripped), 'the boot stamp is on the trail');
  ok((db8.batches || []).filter(b => b.uploaded_by === 'onecart-sync').every(b => b.onecart_store_id === SID), 'the store id was recovered from the orders');

  await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'} (${fails.length} fail)`);
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
