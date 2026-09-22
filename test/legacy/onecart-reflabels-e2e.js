// 🏷 Get Labels in OneCart REFERENCE mode — Betime's live configuration —
// end to end through the REAL server against the spec mock.
//
// The button was written for work mode: it asked "does db.orderLabels hold
// this OneCart order's number?" to decide what to fetch and what came in. In
// reference mode the channel copy is NEVER labelled (the writer fence) — the
// label lands on the picking-list order sharing its waybill, or waits on the
// Labels tab until that order is uploaded — so every press re-asked the
// channel for labels that had already landed and reported them as missing.
//
// Mirrors the floor exactly: one shipment uploaded as a GI Analysis export
// (order number = the marketplace id, same as the copy), one as a GI-numbered
// picking list sharing only the waybill, and one whose picking list arrives
// AFTER the label was fetched.
//
//   SERVER_JS=<path> boots another build (the pre-fix comparison).
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');

const S      = __dirname;
const PORT   = 4761, MPORT = 4762;
const B      = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
const DDIR   = path.join(S, 'oc-reflabels-data');
const DBP    = path.join(DDIR, 'tenants', 'default', 'db.json');
const PDFDIR = path.join(S, 'oc-pdfs');
const MASTER = process.env.MASTER_KEY || '201432547E';
const KEY    = 'oc_test_key_123';
const SERVER = process.env.SERVER_JS || path.join(__dirname, '../../server.js');
const T0     = new Date().toISOString();

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kids = [];
function spawnLogged(args, env, log) {
  const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true });
  kids.push(c); return c;
}
async function portFree(url) { try { await fetch(url); return false; } catch { return true; } }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up: ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids = []; await sleep(1500); }

const MH = tok => ({ 'Content-Type': 'application/json', 'x-master-key': MASTER, 'x-auth-token': tok });
const J  = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
async function login(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); if (!d.token) throw new Error('login ' + id + ' ' + JSON.stringify(d)); return d.token; }
async function orders(tok) { const d = await J(await fetch(B + '/api/orders?range=all', { headers: { 'x-auth-token': tok } })); return Array.isArray(d) ? d : (d.orders || []); }
const byNo = (list, n) => list.filter(o => o.order_number === n);
const mockCalls = async () => J(await fetch(M + '/__ctl/calls'));
const awbCalls = async () => (await mockCalls()).filter(c => c.path.endsWith('/print_awbs'));
const readDb = async () => { await sleep(1200); return JSON.parse(fs.readFileSync(DBP, 'utf8')); };
const getLabels = async (tok, sid) => J(await fetch(B + `/api/master/onecart/stores/${sid}/labels`, { method: 'POST', headers: MH(tok) }));
const pull = async (tok, sid) => J(await fetch(B + `/api/master/onecart/stores/${sid}/pull`, { method: 'POST', headers: MH(tok) }));
const hasLabel = (db, n) => Object.prototype.hasOwnProperty.call(db.orderLabels || {}, n);

function xlsxOf(header, rows) {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
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

// Mock orders: 9001 TikTok (marketplace id below), 9002 Shopee (tracking
// already on it), 9003 Lazada. The label fixtures print "Order No: <id>";
// the tracking numbers set on 9001/9003 here are REAL carrier shapes (the
// picking-list parsers only file a tracking-SHAPED Consignee as the waybill —
// a short stand-in like LZSGD9999 is read as a customer name, which cost a
// run), so the GI orders below genuinely share a waybill with their copies.
const NO1 = '585836014589150279', NO2 = '260907ABCDEF01', NO3 = '172397910455623';
const WB1 = 'JTSG100900100001', WB2 = 'SPXSG0412345678', WB3 = 'LZSGD1019999999';
const WB7 = 'LZSGD1017777777';

(async () => {
  if (!(await portFree(B + '/api/version')) || !(await portFree(M + '/__ctl/calls'))) throw new Error(`port ${PORT}/${MPORT} already answering — a stray server; refusing to measure the wrong process`);
  // The mock serves these as the channel's labels. They are COMMITTED (CI has
  // no Chromium to print them); without them every label link answers 404 and
  // the run reads as the fix being broken — say which file is missing instead.
  const missingPdfs = ['9001', '9002', '9003', '9007'].map(id => path.join(PDFDIR, id + '.pdf')).filter(f => !fs.existsSync(f));
  if (missingPdfs.length) throw new Error(`label fixture(s) missing: ${missingPdfs.join(', ')} — they are committed under test/legacy/oc-pdfs; onecart-e2e.js reprints them`);
  fs.rmSync(DDIR, { recursive: true, force: true });
  spawnLogged([path.join(S, 'onecart-mock.js')], { PORT: String(MPORT), OC_KEY: KEY, OC_PDF_DIR: PDFDIR }, path.join(S, 'oc-reflabels-mock.log'));
  await waitUp(M + '/__ctl/calls');
  spawnLogged([SERVER], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'oc-reflabels-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
  const admin = await login('demo', 'demo');
  console.log('server:', SERVER);

  console.log('\n=== the ledger: three channel copies, each carrying its waybill ===');
  await fetch(M + `/__ctl/track/9001?no=${WB1}`, { method: 'POST' });
  await fetch(M + `/__ctl/track/9003?no=${WB3}`, { method: 'POST' });
  const st = await J(await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(admin),
    body: JSON.stringify({ clientName: 'Betime Online', apiKey: KEY, endpoint: M + '/api/v2', autoPullMinutes: 0, completeAction: 'ship', labelSync: 'off', enabled: true }) }));
  const SID = st.id;
  ok(!!SID && st.mode === 'reference', `store is a REFERENCE ledger (${st.mode})`);
  const p1 = await pull(admin, SID);
  ok(p1.ok && p1.imported === 3, `3 reference copies imported (${p1.imported})`);
  let list = await orders(admin);
  ok(byNo(list, NO1)[0]?.reference_only && byNo(list, NO1)[0]?.waybill_number === WB1, `copy ${NO1} carries ${WB1}`);
  ok(byNo(list, NO2)[0]?.reference_only && byNo(list, NO2)[0]?.waybill_number === WB2, `copy ${NO2} carries ${WB2}`);
  ok(byNo(list, NO3)[0]?.reference_only && byNo(list, NO3)[0]?.waybill_number === WB3, `copy ${NO3} carries ${WB3}`);

  console.log('\n=== BETIME uploads two of the three as work orders ===');
  // A GI Analysis export: order number = the marketplace id (same as the copy).
  const FA = xlsxOf(['Issue No', 'Reference', 'Consignee', 'SKU', 'Qty'], [['GI-700001', NO1, WB1, 'K5008', 2]]);
  const ua = await upload(admin, FA, 'GI-700001_export.xlsx');
  ok(ua.status === 409 && ua.body.needsReferenceConfirm === true, `the export copy asks "exists in Betime Online — carry on?" (${ua.status})`);
  const ua2 = await upload(admin, FA, 'GI-700001_export.xlsx', { confirm_reference: 'yes' });
  ok(ua2.status === 200 && ua2.body.ok !== false, `carried on (${ua2.status})`);
  // A GI-numbered picking list sharing only the WAYBILL with its copy.
  const FB = xlsxOf(['GI No', 'Consignee', 'SKU', 'Qty'], [['GI-700002', WB2, 'K5008', 1]]);
  const ub = await upload(admin, FB, 'GI-700002_picklist.xlsx');
  ok(ub.status === 200 && ub.body.ok !== false, `the GI-numbered order goes straight through (${ub.status} ${JSON.stringify(ub.body).slice(0, 80)})`);
  list = await orders(admin);
  const wA = byNo(list, NO1).find(o => !o.reference_only), wB = byNo(list, 'GI-700002')[0];
  ok(wA && wA.client_name === 'BETIME' && wA.reference_twin === 'Betime Online', `${NO1} is BETIME's work order with the twin named`);
  ok(wB && wB.waybill_number === WB2 && wB.reference_twin === 'Betime Online', `GI-700002 carries ${WB2} and is twinned to the copy BY WAYBILL (twin=${wB?.reference_twin})`);
  ok(!wA.has_order_label && !wB.has_order_label, 'neither work order has a label yet');

  console.log('\n=== 🏷 Get Labels, first press ===');
  const awb0 = (await awbCalls()).length;
  const g1 = await getLabels(admin, SID);
  ok(g1.ok && g1.requested === 3, `asked for all three copies (${g1.requested})`);
  const awb1 = await awbCalls();
  ok(awb1.length === awb0 + 1 && JSON.stringify((awb1[awb1.length - 1].body.order_ids || []).slice().sort()) === JSON.stringify([9001, 9002, 9003]), `print_awbs called once for exactly those ids (${JSON.stringify(awb1[awb1.length - 1]?.body.order_ids)})`);
  const att = g1.attached || [];
  ok(att.length === 2, `2 of 3 attached (${att.length}: ${JSON.stringify(att)})`);
  ok(att.some(a => a.order === NO1 && !a.landedOn), `${NO1}'s label is on BETIME's order of the same number`);
  ok(att.some(a => a.order === NO2 && a.landedOn === 'GI-700002'), `${NO2}'s label LANDED ON GI-700002 — the picking-list order sharing the waybill — and the dialog says so`);
  ok(Array.isArray(g1.held) && g1.held.length === 1 && g1.held[0] === NO3, `${NO3}'s label is fetched and HELD for its picking list, not reported as missing (held=${JSON.stringify(g1.held)})`);
  ok((g1.noLabel || []).length === 0 && (g1.unusable || []).length === 0, `nothing "still without one", nothing unusable (${JSON.stringify(g1.noLabel)} / ${JSON.stringify(g1.unusable)})`);
  const db1 = await readDb();
  ok(hasLabel(db1, NO1) && hasLabel(db1, 'GI-700002'), 'on disk: labels under the two WORK order numbers');
  ok(!hasLabel(db1, NO2) && !hasLabel(db1, NO3), 'and NONE under a reference copy\'s number — the fence held');
  const heldPage = (db1.labelImports || []).flatMap(i => i.pages || []).find(p => p.referenceHint && p.referenceHint.order === NO3);
  ok(heldPage && heldPage.matchStatus !== 'matched', `${NO3}'s page sits unmatched on the Labels tab hinting at the copy (${heldPage?.matchStatus})`);
  ok((db1.auditLog || []).some(e => e.type === 'sync_label_for_reference_unplaced' && e.order === NO3 && e.at > T0), 'audited sync_label_for_reference_unplaced for it');
  const lf = (db1.auditLog || []).filter(e => e.type === 'onecart_labels_fetched' && e.at > T0).pop();
  ok(lf && lf.attached === 2 && lf.held === 1 && lf.noLabel === 0, `audited onecart_labels_fetched attached 2 / held 1 / noLabel 0 (${JSON.stringify(lf)})`);
  ok(!(db1.auditLog || []).filter(e => e.at > T0).some(e => /\/awb\//.test(JSON.stringify(e))), 'no label URL anywhere on the trail');
  list = await orders(admin);
  ok(byNo(list, NO1).find(o => !o.reference_only)?.has_order_label === true && byNo(list, 'GI-700002')[0]?.has_order_label === true, 'both work orders now show 🏷 on the Orders list');
  ok(byNo(list, NO2)[0]?.reference_only && !byNo(list, NO2)[0]?.has_order_label, 'the copy itself shows no label');
  const stores1 = await J(await fetch(B + '/api/master/onecart/stores', { headers: MH(admin) }));
  const s1 = (Array.isArray(stores1) ? stores1 : stores1.stores || []).find(x => x.id === SID);
  ok(s1?.lastLabels?.attached === 2 && s1?.lastLabels?.held === 1, `the store row reads 2 attached + 1 waiting (${JSON.stringify(s1?.lastLabels)})`);

  console.log('\n=== second press: nothing is asked for twice ===');
  const awbBefore = (await awbCalls()).length;
  const g2 = await getLabels(admin, SID);
  ok(g2.ok && g2.requested === 0, `nothing requested (${g2.requested})`);
  ok((await awbCalls()).length === awbBefore, 'print_awbs NOT called again');
  ok(g2.alreadyLabelled === 2 && g2.waitingForPickingList === 1, `2 already labelled, 1 waiting for its picking list (${g2.alreadyLabelled}/${g2.waitingForPickingList})`);
  ok(/2 already labelled/.test(g2.note || '') && /1 on the picking-list order/.test(g2.note || '') && /waiting for a picking list/.test(g2.note || ''), `and the note says so in words ("${g2.note}")`);

  console.log('\n=== the picking list arrives AFTER the label: it attaches by itself ===');
  const FC = xlsxOf(['GI No', 'Consignee', 'SKU', 'Qty'], [['GI-700003', WB3, '8006', 3]]);
  const uc = await upload(admin, FC, 'GI-700003_picklist.xlsx');
  ok(uc.status === 200 && uc.body.ok !== false, `GI-700003 uploaded sharing ${WB3} (${uc.status})`);
  await sleep(11000);   // the late-orders sweep fires 5s after an upload
  const db2 = await readDb();
  ok(hasLabel(db2, 'GI-700003'), 'the held page is now ATTACHED to GI-700003 with nobody pressing anything');
  ok(!hasLabel(db2, NO3), 'and still not to the copy');
  const pg3 = (db2.labelImports || []).flatMap(i => i.pages || []).find(p => p.matchedOrderNumber === 'GI-700003');
  ok(pg3 && pg3.matchStatus === 'matched' && /reference_copy|tracking_number/.test(pg3.matchMethod || ''), `matched via ${pg3?.matchMethod} at ${pg3?.matchConfidence}`);
  // The sweep is debounced and keeps the FIRST caller's trigger name, so the
  // row is asserted by the import it matched, not by who scheduled it.
  const impNo3 = (db2.labelImports || []).find(i => (i.pages || []).some(p => p.matchedOrderNumber === 'GI-700003'));
  ok(impNo3 && (db2.auditLog || []).some(e => e.type === 'labels_auto_matched' && e.importId === impNo3.id && e.newMatches >= 1 && e.at > T0), 'audited labels_auto_matched by the late-orders sweep');
  const g3 = await getLabels(admin, SID);
  ok(g3.requested === 0 && g3.alreadyLabelled === 3 && g3.waitingForPickingList === 0, `third press: all three labelled, nothing waiting (${g3.alreadyLabelled}/${g3.waitingForPickingList})`);
  list = await orders(admin);
  ok(byNo(list, 'GI-700003')[0]?.has_order_label === true, 'GI-700003 shows 🏷 on the Orders list');

  console.log('\n=== labels at intake, in reference mode ===');
  const sv = await J(await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(admin), body: JSON.stringify({ id: SID, labelSync: 'intake' }) }));
  ok(sv.labelSync === 'intake' && sv.mode === 'reference', `auto-label at intake switched on, still a reference ledger (${sv.labelSync}/${sv.mode})`);
  // 9007's fixture label prints "Order No: 9007NEWORDER / Tracking: LZSGD7777"
  // — NEITHER is a shape any reader extracts, so this page's text names
  // nothing. The only link it has to its order is the fact that it was
  // fetched FOR the copy — the case a bitmap caption produces on a real label.
  await fetch(M + '/__ctl/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 9007, order_no: '9007NEWORDER', platform: 'Lazada', shop_id: 13, shop_name: 'Betime Lazada', status: 'pending', tracking_no: WB7, first_name: 'New', last_name: 'Order', shipping_address: '1 Somewhere', shipping_postal_code: '333333', shipping_phone_number: '', line_items: [{ sku: '8006', quantity: 1, name: 'Koli Herbal Patch', is_bundle_component: false }] }) });
  const awbI = (await awbCalls()).length;
  const p2 = await pull(admin, SID);
  ok(p2.imported === 1, `the new copy imported (${p2.imported})`);
  const awbI2 = await awbCalls();
  ok(awbI2.length === awbI + 1 && JSON.stringify(awbI2[awbI2.length - 1].body.order_ids) === '[9007]', 'print_awbs asked for the NEW copy only');
  ok(p2.labels && p2.labels.requested === 1 && p2.labels.attached === 0 && p2.labels.held === 1 && p2.labels.noLabel === 0, `the pull reports the label fetched and HELD, not missing (${JSON.stringify(p2.labels)})`);
  await sleep(8000);   // the pull's own sweep runs 5s later — the page must survive it
  const db3 = await readDb();
  ok(!hasLabel(db3, '9007NEWORDER'), 'nothing filed on the copy');
  const pg7 = (db3.labelImports || []).flatMap(i => i.pages || []).find(p => p.fetchedFor === '9007NEWORDER');
  ok(pg7 && pg7.matchStatus === 'unmatched' && !pg7.extracted?.orderNumber && !pg7.extracted?.trackingNumber, `its page reads NO identifier at all and sits unmatched (${pg7?.matchStatus}, order="${pg7?.extracted?.orderNumber}", tracking="${pg7?.extracted?.trackingNumber}")`);
  ok(pg7?.referenceHint?.order === '9007NEWORDER', `the "fetched for Betime Online's copy" hint SURVIVED the sweep (${JSON.stringify(pg7?.referenceHint)})`);
  const g4 = await getLabels(admin, SID);
  ok(g4.requested === 0 && g4.waitingForPickingList === 1, `Get Labels does not ask for it again (${g4.requested}, waiting ${g4.waitingForPickingList})`);
  const FD = xlsxOf(['GI No', 'Consignee', 'SKU', 'Qty'], [['GI-700007', WB7, '8006', 1]]);
  const ud = await upload(admin, FD, 'GI-700007_picklist.xlsx');
  ok(ud.status === 200, `its picking list uploaded sharing ${WB7} (${ud.status})`);
  await sleep(11000);
  const db4 = await readDb();
  ok(hasLabel(db4, 'GI-700007') && !hasLabel(db4, '9007NEWORDER'), 'the intake-fetched label attached to GI-700007 by itself — with nothing readable on the page');
  const pg7b = (db4.labelImports || []).flatMap(i => i.pages || []).find(p => p.fetchedFor === '9007NEWORDER');
  ok(pg7b?.matchStatus === 'matched' && pg7b?.matchedOrderNumber === 'GI-700007' && pg7b?.matchMethod === 'fetched-for-order_of_reference_copy' && pg7b?.matchConfidence === 'exact', `matched by the FACT it was fetched for the copy (${pg7b?.matchMethod} @ ${pg7b?.matchConfidence})`);
  ok(pg7b?.referenceHint?.via === true && pg7b?.referenceHint?.order === '9007NEWORDER', 'the review row says it came via Betime Online\'s copy');
  const g5 = await getLabels(admin, SID);
  ok(g5.requested === 0 && g5.alreadyLabelled === 4 && g5.waitingForPickingList === 0, `every copy is now labelled at its home, nothing waiting (${g5.alreadyLabelled}/${g5.waitingForPickingList})`);
  list = await orders(admin);
  ok(byNo(list, 'GI-700007')[0]?.has_order_label === true, 'GI-700007 shows 🏷 on the Orders list');

  await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'} (${fails.length} fail)`);
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
