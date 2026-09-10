// THE CLIENT'S REPORT HAS TO SAY WHAT MOVED, not just that something did.
//
// Orders and Cancelled were one row per order carrying "Lines: 1, Pieces: 3"
// and nothing else — a client could see that an order shipped and had no way,
// anywhere, to see WHICH products or how many of each. This adds an
// "Order lines" sheet (SKU / Description / Quantity) to the Orders download,
// the Cancelled download and the combined workbook.
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const BASE = 'http://localhost:4636', MK = '201432547E';
// The fixture splits the two cases: CxCo has cancelled orders and no live
// ones, VisCo the reverse. Run against both — a check that passes on an empty
// sheet has proved nothing, so each is SKIPPED out loud rather than passing.
const [CLIENT, USER, PW] = (process.argv[2] || 'CxCo').split(':');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

const rows = (wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
// The header row is wherever the columns actually start — the title block above
// it is prose and its length is allowed to change.
const table = (wb, name, firstCol) => {
  const a = rows(wb, name);
  const h = a.findIndex(r => String(r[0] || '').trim() === firstCol);
  return h < 0 ? { head: [], body: [] } : { head: a[h], body: a.slice(h + 1).filter(r => r.length) };
};

(async () => {
  const T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  const MH = { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': MK };

  // A login on the client under test. REUSED, never blindly created: a second
  // POST with the same name makes a SECOND account (mia-2), and then logging in
  // by name binds to one while the visibility check writes to the other — which
  // is a fault in the test, not in the report.
  const listUsers = async () => (await (await fetch(
    `${BASE}/api/master/client-profiles/${encodeURIComponent(CLIENT)}/portal-users`, { headers: MH })).json()).users || [];
  let mia = (await listUsers()).find(u => u.name === 'Mia');
  if (!mia) {
    const mk = await fetch(`${BASE}/api/master/client-profiles/${encodeURIComponent(CLIENT)}/portal-users`, {
      method: 'POST', headers: MH, body: JSON.stringify({ name: 'Mia', access: 'view', password: 'cxco12345', enabled: true }) });
    ok(mk.status === 200, `a portal login is created for ${CLIENT} (${mk.status})`);
    mia = (await listUsers()).find(u => u.name === 'Mia');
  } else ok(true, `reusing the existing portal login on ${CLIENT}`);
  if (!mia) { ok(false, 'no portal login to test with'); console.log('\nSTOP'); return; }
  const uid = mia.id;
  // Everything open, whatever an earlier run left behind.
  await fetch(`${BASE}/api/master/client-profiles/${encodeURIComponent(CLIENT)}/portal-users`, {
    method: 'POST', headers: MH, body: JSON.stringify({ id: uid, visibility: {} }) });
  // ONE PLACE AT A TIME: a seat left held by an earlier run refuses this login,
  // so free it first rather than reading the 409 as a failure of the report.
  await fetch(`${BASE}/api/master/client-profiles/${encodeURIComponent(CLIENT)}/portal-users/${uid}/release`, { method: 'POST', headers: MH });

  // Sign in BY ID, not by name — names are not unique.
  const L = await (await fetch(BASE + '/api/portal/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: CLIENT, user: uid, password: 'cxco12345' }) })).json();
  if (!L.token) { ok(false, `could not sign in: ${JSON.stringify(L).slice(0, 160)}`); console.log('\nSTOP'); return; }
  const H = { 'x-auth-token': L.token };
  const RANGE = 'from=2025-09-01&to=2026-08-25';
  const get = async k => {
    const r = await fetch(`${BASE}/api/portal/export/${k}?${RANGE}`, { headers: H });
    return { status: r.status, wb: r.status === 200 ? XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' }) : null,
             text: r.status === 200 ? '' : await r.text() };
  };

  // ── THE ORDERS DOWNLOAD.
  const o = await get('orders');
  ok(o.status === 200, `the Orders download builds (${o.status})`);
  ok(o.wb.SheetNames.includes('Order lines'), `and carries an Order lines sheet (${o.wb.SheetNames.join(', ')})`);
  ok(!o.wb.SheetNames.includes('Cancelled lines'),
     'and NOT a cancelled-lines sheet — cancelled orders are their own download');
  const ord = table(o.wb, 'Orders', 'Order no');
  const lin = table(o.wb, 'Order lines', 'Order no');
  ok(['SKU', 'Description', 'Quantity'].every(c => lin.head.includes(c)),
     `with SKU, Description and Quantity columns (${lin.head.join(' | ')})`);
  const iSku = lin.head.indexOf('SKU'), iDesc = lin.head.indexOf('Description'), iQty = lin.head.indexOf('Quantity');
  if (!lin.body.length) {
    // Correct for a client with nothing but cancelled orders — the sheet is
    // empty BECAUSE nothing shipped, which is the split doing its job. The
    // content checks are proved on the client that has live orders.
    console.log('SKIP - no live orders for this client, so Order lines is legitimately empty; content proved on the other client');
  } else {
    ok(true, `real rows on it (${lin.body.length})`);
    ok(lin.body.every(r => String(r[iSku] || '').trim()), 'every line names a SKU');
    ok(lin.body.every(r => Number(r[iQty]) > 0), 'every line carries a quantity');
    ok(lin.body.some(r => String(r[iDesc] || '').trim()), 'and the product description is filled in, not a bare code');
  }
  // ── ONE LINE SHEET PER ORDER SHEET. A mixed sheet is inconsistent with a
  // workbook whose Orders tab excludes cancelled, and anyone summing Quantity
  // without reading the Status column would add shipped and cancelled together.
  const iSt = lin.head.indexOf('Status');
  ok(lin.body.every(r => !/cancel/i.test(String(r[iSt]))),
     'NOT ONE cancelled line is on the Orders download — summing Quantity here is what shipped');
  const linNos = new Set(lin.body.map(r => String(r[0])));
  ok([...linNos].every(n => ord.body.some(r => String(r[0]) === n)),
     'and every line belongs to an order on the Orders sheet beside it');

  // ── THE ORDER SHEET KEEPS ITS SHAPE. People count orders on it; exploding it
  // into one row per SKU would change what every existing figure means.
  ok(ord.head.join('|') === ['Order no', 'Date', 'Status', 'Lines', 'Pieces', 'Waybill', 'PO no',
      'Completed (SGT)', 'Collection', 'Picked up (SGT)'].join('|'),
     'the Orders sheet still has exactly its old columns');
  const orderNos = ord.body.map(r => String(r[0]));
  if (!orderNos.length) console.log('SKIP - no LIVE orders for this client in range; the one-row-per-order and reconcile checks are proved on the other client');
  else ok(new Set(orderNos).size === orderNos.length, `and is still one row per order (${orderNos.length})`);

  // ── THE TWO SHEETS RECONCILE. A line sheet that does not add up to the
  // Pieces column is worse than none — the client would have to pick one.
  const iPieces = ord.head.indexOf('Pieces');
  const sumBy = new Map();
  for (const r of lin.body) sumBy.set(String(r[0]), (sumBy.get(String(r[0])) || 0) + (Number(r[iQty]) || 0));
  const checked = ord.body.filter(r => sumBy.has(String(r[0])));
  const bad = checked.filter(r => sumBy.get(String(r[0])) !== Number(r[iPieces]));
  if (!checked.length) console.log('SKIP - no live order on both sheets to reconcile here');
  else {
    ok(bad.length === 0, `all ${checked.length} orders' lines add up to their Pieces figure${bad.length ? ` — off on ${bad.map(r => r[0]).join(', ')}` : ''}`);
    // THE SHEET TOTAL IS NOW A REAL FIGURE: sum the whole Quantity column and it
    // is the pieces that shipped, which is precisely what the mixed sheet broke.
    const linTotal = lin.body.reduce((s2, r) => s2 + (Number(r[iQty]) || 0), 0);
    const ordTotal = ord.body.reduce((s2, r) => s2 + (Number(r[iPieces]) || 0), 0);
    ok(linTotal === ordTotal, `and the whole Quantity column totals the Orders sheet exactly (${linTotal} vs ${ordTotal})`);
  }

  // ── A CANCELLED ORDER'S CONTENTS ARE THE POINT OF THAT SHEET: it is the list
  // the client re-places elsewhere, and they cannot re-place a piece count.
  const c = await get('cancelled');
  ok(c.status === 200, `the Cancelled download builds (${c.status})`);
  ok(c.wb.SheetNames.includes('Cancelled lines'),
     `and carries a Cancelled lines sheet, named for what is on it (${c.wb.SheetNames.join(', ')})`);
  const cOrd = table(c.wb, 'Cancelled', 'Order no');
  const cLin = table(c.wb, 'Cancelled lines', 'Order no');
  if (!cOrd.body.length) console.log('SKIP - no cancelled orders for this client in range; proved on the other client');
  else {
    ok(cLin.body.length > 0, `their lines are listed (${cLin.body.length} for ${cOrd.body.length} order(s))`);
    const iCs = cLin.head.indexOf('Status');
    ok(cLin.body.every(r => /cancel/i.test(String(r[iCs]))), 'each marked Cancelled, so it cannot be mistaken for shipped work');
    const cNos = new Set(cOrd.body.map(r => String(r[0])));
    ok(cLin.body.every(r => cNos.has(String(r[0]))),
       'and the sheet holds ONLY cancelled orders — not the whole book');
    const jSku = cLin.head.indexOf('SKU'), jDesc = cLin.head.indexOf('Description'), jQty = cLin.head.indexOf('Quantity');
    ok(cLin.body.every(r => String(r[jSku] || '').trim() && Number(r[jQty]) > 0),
       'each cancelled line carries its SKU and quantity — the list is re-placeable');
    ok(cLin.body.some(r => String(r[jDesc] || '').trim()), 'with the product described, not just coded');
    // The cancelled sheet reconciles against its own Pieces column too.
    const kP = cOrd.head.indexOf('Pieces');
    const cSum = new Map();
    for (const r of cLin.body) cSum.set(String(r[0]), (cSum.get(String(r[0])) || 0) + (Number(r[jQty]) || 0));
    ok(cOrd.body.every(r => !cSum.has(String(r[0])) || cSum.get(String(r[0])) === Number(r[kP])),
       'and every cancelled order\'s lines add up to its Pieces figure');
  }

  // ── THE COMBINED WORKBOOK. The tab has to be in the one file a client pulls
  // for the month, or they are back to collecting several.
  const rep = await get('report');
  ok(rep.status === 200, `the combined workbook builds (${rep.status})`);
  ok(rep.wb.SheetNames.includes('Order lines') && rep.wb.SheetNames.includes('Cancelled lines'),
     `with BOTH line tabs in it, one per order tab (${rep.wb.SheetNames.join(', ')})`);
  const rLin = table(rep.wb, 'Order lines', 'Order no');
  const rCan = table(rep.wb, 'Cancelled lines', 'Order no');
  ok(rLin.body.length === lin.body.length, `the Order lines tab matches the standalone download (${rLin.body.length} vs ${lin.body.length})`);
  ok(rLin.body.every(r => !/cancel/i.test(String(r[rLin.head.indexOf('Status')]))),
     'and carries no cancelled line either');
  if (!cOrd.body.length) console.log('SKIP - nothing cancelled here to look for in the workbook');
  else ok(rCan.body.length === cLin.body.length,
     `the Cancelled lines tab matches its own download (${rCan.body.length} vs ${cLin.body.length})`);
  // BUILT BY ONE FUNCTION: the workbook's Orders tab and the standalone
  // download used to be separate copies of the same loop.
  const rOrd = table(rep.wb, 'Orders', 'Order no');
  ok(rOrd.head.join('|') === ord.head.join('|') && rOrd.body.length === ord.body.length,
     `and the workbook's Orders tab matches the standalone download exactly (${rOrd.body.length} vs ${ord.body.length})`);

  // ── NO NEW WAY IN. The lines ride with Orders rather than being their own
  // download, so a client whose Orders report is switched off cannot reach
  // them by URL either.
  {
    await fetch(`${BASE}/api/master/client-profiles/${encodeURIComponent(CLIENT)}/portal-users`, {
      method: 'POST', headers: MH, body: JSON.stringify({ id: uid, visibility: { report_orders: false } }) });
    const off = await get('orders');
    ok(off.status === 403, `with Orders & movements switched off the download is refused (${off.status})`);
    const offLines = await fetch(`${BASE}/api/portal/export/order-lines?${RANGE}`, { headers: H });
    ok(offLines.status !== 200, `and there is no separate order-lines URL to slip through (${offLines.status})`);
    await fetch(`${BASE}/api/master/client-profiles/${encodeURIComponent(CLIENT)}/portal-users`, {
      method: 'POST', headers: MH, body: JSON.stringify({ id: uid, visibility: {} }) });
  }

  console.log(`\n[${CLIENT}] ` + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
