// TWO SHEETS, EACH CARRYING ITS OWN PRODUCT DETAIL.
//
// Per the user: "Order one sheet, Cancelled order one sheet". The per-SKU
// breakdown that lived on its own tab is now IN the order sheets — one row per
// order × SKU — and the order-level Lines/Pieces columns are gone, because
// repeating an order's total on each of its rows makes that column sum to a
// wrong figure silently.
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const BASE = 'http://localhost:4636', MK = '201432547E';
// The fixture splits the cases: VisCo has shipped AND cancelled orders, CxCo
// only cancelled. Run against both — a check with no rows behind it is SKIPPED
// out loud rather than passing on an empty sheet.
const CLIENT = process.argv[2] || 'CxCo';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

const table = (wb, name, firstCol) => {
  const a = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
  const h = a.findIndex(r => String(r[0] || '').trim() === firstCol);
  return h < 0 ? { head: [], body: [] } : { head: a[h], body: a.slice(h + 1).filter(r => r.length) };
};
const col = (t, n) => t.head.indexOf(n);

(async () => {
  const T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  const MH = { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': MK };
  const U = `${BASE}/api/master/client-profiles/${encodeURIComponent(CLIENT)}/portal-users`;

  // REUSED, never blindly created: a second POST with the same name makes a
  // SECOND account, and then logging in by name binds to one while the
  // visibility check writes to the other — a fault in the test, not the report.
  const listUsers = async () => (await (await fetch(U, { headers: MH })).json()).users || [];
  let mia = (await listUsers()).find(u => u.name === 'Mia');
  if (!mia) {
    const mk = await fetch(U, { method: 'POST', headers: MH,
      body: JSON.stringify({ name: 'Mia', access: 'view', password: 'cxco12345', enabled: true }) });
    ok(mk.status === 200, `a portal login is created for ${CLIENT} (${mk.status})`);
    mia = (await listUsers()).find(u => u.name === 'Mia');
  } else ok(true, `reusing the existing portal login on ${CLIENT}`);
  if (!mia) { ok(false, 'no portal login to test with'); console.log('\nSTOP'); return; }
  const uid = mia.id;
  await fetch(U, { method: 'POST', headers: MH, body: JSON.stringify({ id: uid, visibility: {} }) });
  // One place at a time — free a seat an earlier run left held.
  await fetch(`${U}/${uid}/release`, { method: 'POST', headers: MH });

  const L = await (await fetch(BASE + '/api/portal/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: CLIENT, user: uid, password: 'cxco12345' }) })).json();   // by ID — names are not unique
  if (!L.token) { ok(false, `could not sign in: ${JSON.stringify(L).slice(0, 160)}`); console.log('\nSTOP'); return; }
  const H = { 'x-auth-token': L.token };
  const RANGE = 'from=2025-09-01&to=2026-08-25';
  const get = async k => {
    const r = await fetch(`${BASE}/api/portal/export/${k}?${RANGE}`, { headers: H });
    return { status: r.status, wb: r.status === 200 ? XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' }) : null,
             text: r.status === 200 ? '' : await r.text() };
  };

  // ── ORDERS: ONE SHEET, carrying the products.
  const o = await get('orders');
  ok(o.status === 200, `the Orders download builds (${o.status})`);
  ok(o.wb.SheetNames.length === 1 && o.wb.SheetNames[0] === 'Orders',
     `and is ONE sheet, not a sheet plus a line tab (${o.wb.SheetNames.join(', ')})`);
  const ord = table(o.wb, 'Orders', 'Order no');
  ok(['SKU', 'Description', 'Quantity'].every(c => ord.head.includes(c)),
     `with SKU, Description and Quantity on the order sheet itself (${ord.head.join(' | ')})`);
  // THE COLUMNS THAT WOULD LIE ARE GONE. Repeating an order's total on each of
  // its rows makes summing that column multiply every multi-line order.
  ok(!ord.head.includes('Lines') && !ord.head.includes('Pieces'),
     'and NO order-level Lines/Pieces columns, which would double-count once repeated per row');

  const iSku = col(ord, 'SKU'), iDesc = col(ord, 'Description'), iQty = col(ord, 'Quantity'), iSt = col(ord, 'Status');
  if (!ord.body.length) {
    console.log('SKIP - no shipped orders for this client in range; content proved on the other client');
  } else {
    ok(ord.body.every(r => String(r[iSku] || '').trim()), `every row names a SKU (${ord.body.length} rows)`);
    ok(ord.body.every(r => Number(r[iQty]) > 0), 'and carries a quantity');
    ok(ord.body.some(r => String(r[iDesc] || '').trim()), 'with the product described, not just coded');
    ok(ord.body.every(r => !/cancel/i.test(String(r[iSt]))),
       'NOT ONE cancelled row is on this sheet — summing Quantity here is what shipped');
    // A MULTI-LINE ORDER REPEATS ITS ORDER COLUMNS DOWN ITS ROWS, which is the
    // whole point of a flat sheet: it pivots without joining two tabs by hand.
    const counts = new Map();
    for (const r of ord.body) counts.set(String(r[0]), (counts.get(String(r[0])) || 0) + 1);
    const multi = [...counts.entries()].find(([, n]) => n > 1);
    if (!multi) console.log('SKIP - no multi-product order in this fixture to prove the repeat on');
    else {
      const rows = ord.body.filter(r => String(r[0]) === multi[0]);
      ok(rows.every(r => r[1] === rows[0][1] && r[iSt] === rows[0][iSt]),
         `${multi[0]} spans ${multi[1]} rows, each repeating its order date and status`);
      ok(new Set(rows.map(r => r[iSku])).size === rows.length, 'with a different product on each');
    }
  }

  // ── CANCELLED: ONE SHEET, same treatment.
  const c = await get('cancelled');
  ok(c.status === 200, `the Cancelled download builds (${c.status})`);
  ok(c.wb.SheetNames.length === 1 && c.wb.SheetNames[0] === 'Cancelled',
     `and is ONE sheet too (${c.wb.SheetNames.join(', ')})`);
  const can = table(c.wb, 'Cancelled', 'Order no');
  ok(['SKU', 'Description', 'Quantity'].every(x => can.head.includes(x)),
     `carrying the products on it (${can.head.join(' | ')})`);
  ok(!can.head.includes('SKUs'), 'and the old comma-jammed "SKUs" cell is gone — real columns replaced it');
  if (!can.body.length) console.log('SKIP - no cancelled orders for this client in range; proved on the other client');
  else {
    const jSku = col(can, 'SKU'), jQty = col(can, 'Quantity'), jDesc = col(can, 'Description');
    ok(can.body.every(r => String(r[jSku] || '').trim() && Number(r[jQty]) > 0),
       `each cancelled row carries its SKU and quantity — the list is re-placeable (${can.body.length} rows)`);
    ok(can.body.some(r => String(r[jDesc] || '').trim()), 'with the product described');
    ok(can.body.every(r => String(r[3] || '').trim()), 'and the reason repeated on every row of the order');
  }

  // ── THE COMBINED WORKBOOK: two order tabs, down from four.
  const rep = await get('report');
  ok(rep.status === 200, `the combined workbook builds (${rep.status})`);
  ok(!rep.wb.SheetNames.some(n => /lines/i.test(n)),
     `with no separate line tabs left in it (${rep.wb.SheetNames.join(', ')})`);
  ok(rep.wb.SheetNames.filter(n => /^(Orders|Cancelled)$/.test(n)).length === 2,
     'exactly one Orders tab and one Cancelled tab');
  const rOrd = table(rep.wb, 'Orders', 'Order no'), rCan = table(rep.wb, 'Cancelled', 'Order no');
  ok(rOrd.head.join('|') === ord.head.join('|') && rOrd.body.length === ord.body.length,
     `the workbook's Orders tab matches the standalone download exactly (${rOrd.body.length} vs ${ord.body.length})`);
  ok(rCan.head.join('|') === can.head.join('|') && rCan.body.length === can.body.length,
     `and its Cancelled tab likewise (${rCan.body.length} vs ${can.body.length})`);
  ok(rOrd.body.every(r => !/cancel/i.test(String(r[col(rOrd, 'Status')]))),
     'nothing cancelled leaks onto the workbook\'s Orders tab either');

  // ── THE FIGURES STILL RECONCILE against what the portal screen reports.
  // /api/portal/orders answers with a BARE ARRAY — reading `.orders` off it
  // silently gave an empty list and skipped this check, which is exactly the
  // vacuous pass this suite is written to avoid.
  const list = await (await fetch(`${BASE}/api/portal/orders?limit=500`, { headers: H })).json();
  const live = (Array.isArray(list) ? list : list.orders || []).filter(x => x.status !== 'unprocessed');
  if (!live.length || !ord.body.length) console.log('SKIP - nothing live to reconcile against the screen');
  else {
    const sheetPieces = ord.body.reduce((s, r) => s + (Number(r[iQty]) || 0), 0);
    const seen = new Set(ord.body.map(r => String(r[0])));
    // Only the orders that fall in BOTH windows can be compared.
    const shared = live.filter(x => seen.has(String(x.order_number)));
    const screenPieces = shared.reduce((s, x) => s + (Number(x.pieces ?? x.total_qty) || 0), 0);
    ok(sheetPieces === screenPieces,
       `the Quantity column totals what the portal screen reports for the same orders (${sheetPieces} vs ${screenPieces})`);
    ok(seen.size === shared.length, `and distinct Order no still counts orders (${seen.size})`);
  }

  // ── NO NEW WAY IN.
  await fetch(U, { method: 'POST', headers: MH, body: JSON.stringify({ id: uid, visibility: { report_orders: false } }) });
  const off = await get('orders');
  ok(off.status === 403, `with Orders & movements switched off the download is refused (${off.status})`);
  const stray = await fetch(`${BASE}/api/portal/export/order-lines?${RANGE}`, { headers: H });
  ok(stray.status !== 200, `and there is no order-lines URL left to slip through (${stray.status})`);
  await fetch(U, { method: 'POST', headers: MH, body: JSON.stringify({ id: uid, visibility: {} }) });

  console.log(`\n[${CLIENT}] ` + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
