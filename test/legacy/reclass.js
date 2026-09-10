// RECLASSIFYING A COMPLETED ORDER — back to Pending (stock returned and
// re-reserved, floor re-picks) or Cancelled (stock returned, recorded
// unfulfilled). The one password-gated exception to the standing rule that
// completed work is never regressed.
//
// Driven end to end through the REAL flow: stock in → upload (reserves) →
// setqty + complete (deducts) → reclassify — so the stock assertions measure
// the genuine ledger, not a hand-seeded flag.
const BASE = 'http://localhost:4636', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
let T = '';
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const CLIENT = 'RcCo';
const stockOf = async (sku) => {
  const r = await J(`/api/inventory?clientId=${CLIENT}`);
  const rows = Array.isArray(r.body) ? r.body : r.body.items || r.body.rows || [];
  const it = rows.find(x => x.sku === sku) || {};
  return { on: Number(it.stock_qty) || 0, res: Number(it.reserved_qty) || 0 };
};
// NOTE: ?cancelled=1 narrows to CLIENT-withdrawn orders only, so a reclassified
// cancellation is asserted from stored state instead of that list.
const orderRow = async (num) => {
  const list = (await J('/api/orders?range=all')).body;
  const arr = Array.isArray(list) ? list : list.orders || [];
  return arr.find(o => o.order_number === num);
};
const storedState = (num) => {
  const dbj = JSON.parse(require('fs').readFileSync(__dirname + '/sup/tenants/default/db.json', 'utf8'));
  for (const b of dbj.batches || []) if (b.orderStates?.[num]) return b.orderStates[num];
  return null;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;

  // ── FIXTURE: a tracked client with stock, and three orders through the real
  // upload → complete pipeline. (Run via reclass-run.sh, which clears RC-*
  // orders with the server stopped first.)
  for (const sku of ['RC-A', 'RC-B']) {
    await J('/api/inventory', { method: 'POST', body: JSON.stringify({
      clientId: CLIENT, sku, name: `Reclass Widget ${sku}`, stock_qty: 50 }) });
    // Top the count back to 50 whatever an earlier run left behind.
    const cur = await stockOf(sku);
    if (cur.on !== 50) await J(`/api/inventory/${sku}/adjust`, { method: 'POST',
      body: JSON.stringify({ clientId: CLIENT, qty: 50 - cur.on, reason: 'test reset to fifty', password: MK }) });
  }
  const csv = 'Order No,SKU,Quantity,Description\n'
    + 'RC-ORD-1,RC-A,3,Reclass Widget A\nRC-ORD-1,RC-B,2,Reclass Widget B\n'
    + 'RC-ORD-2,RC-A,4,Reclass Widget A\n'
    + 'RC-ORD-3,RC-B,1,Reclass Widget B\n';
  const fd = new FormData();
  fd.append('orderFile', new Blob([csv], { type: 'text/csv' }), 'reclass-orders.csv');
  fd.append('client_name', CLIENT);
  fd.append('arrange_delivery', 'no');
  fd.append('overwrite_same_file', 'yes');
  fd.append('overwrite_duplicates', 'yes');
  const up = await fetch(BASE + '/api/upload', { method: 'POST', headers: { 'x-auth-token': T }, body: fd });
  const upBody = await up.json().catch(() => ({}));
  ok(up.status === 200, `the file uploads and reserves at intake (${up.status} ${JSON.stringify(upBody).slice(0, 120)})`);

  const s0 = await stockOf('RC-A');
  ok(s0.on === 50 && s0.res >= 7, `RC-A: 50 on hand, ${s0.res} reserved after intake (RC-ORD-1 wants 3 + RC-ORD-2 wants 4)`);

  // Complete RC-ORD-1 and RC-ORD-2 through the real scan pipeline.
  for (const [num, lines] of [['RC-ORD-1', [['RC-A', 3], ['RC-B', 2]]], ['RC-ORD-2', [['RC-A', 4]]]]) {
    for (const [sku, qty] of lines) {
      await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: num, sku, qty }) });
    }
    const done = await J('/api/scan/complete', { method: 'POST',
      body: JSON.stringify({ orderNumber: num, endTime: new Date().toISOString() }) });
    ok(done.status === 200 && done.body.ok !== false, `${num} completes (${JSON.stringify(done.body).slice(0, 60)})`);
  }
  await wait(400);
  const s1 = await stockOf('RC-A');
  ok(s1.on === 43 && s1.res === s0.res - 7, `completion DEDUCTED RC-A: on hand 50→${s1.on}, reserved down by 7 (now ${s1.res})`);

  // ── THE GATES, each proven to change nothing.
  const before = await stockOf('RC-A');
  let r = await J('/api/orders/bulk-reclassify', { method: 'POST',
    body: JSON.stringify({ orders: ['RC-ORD-1'], to: 'pending', reason: 'undo mis-completion', password: 'wrong-password' }) });
  ok(r.status === 403, `a WRONG password is refused with 403, never 401 (${r.status})`);
  r = await J('/api/orders/bulk-reclassify', { method: 'POST',
    body: JSON.stringify({ orders: ['RC-ORD-1'], to: 'pending', reason: 'oops', password: 'demo' }) });
  ok(r.status === 400, `a non-reason is refused (${r.status})`);
  r = await J('/api/orders/bulk-reclassify', { method: 'POST',
    body: JSON.stringify({ orders: ['RC-ORD-1'], to: 'archived', reason: 'undo mis-completion', password: 'demo' }) });
  ok(r.status === 400, `an unknown target state is refused (${r.status})`);
  const after = await stockOf('RC-A');
  ok(after.on === before.on && after.res === before.res, 'and every refusal changed no stock');

  // ── DONE → PENDING: stock back, reservation retaken, floor re-picks.
  r = await J('/api/orders/bulk-reclassify', { method: 'POST',
    body: JSON.stringify({ orders: ['RC-ORD-1'], to: 'pending', reason: 'completed against the wrong parcel — re-pick', password: 'demo' }) });
  ok(r.status === 200 && r.body.results?.length === 1, `RC-ORD-1 reclassifies to pending (${r.status})`);
  ok(r.body.results?.[0]?.unitsReturned === 5, `all 5 units were returned to stock (${r.body.results?.[0]?.unitsReturned})`);
  ok(/bin positions are not rewritten/i.test(r.body.note || ''), 'and the answer says the bins were NOT rewritten — cycle count wanted');
  await wait(400);
  const s2 = await stockOf('RC-A');
  ok(s2.on === s1.on + 3, `RC-A on hand got its 3 back (${s1.on}→${s2.on})`);
  ok(s2.res === s1.res + 3, `and RC-A is RE-RESERVED for the order (${s1.res}→${s2.res})`);
  const row1 = await orderRow('RC-ORD-1');
  ok(!!row1, 'RC-ORD-1 is back on the Orders list as open work');
  ok(row1?.scan_status === 'pending', `and genuinely pending again (${row1?.scan_status})`);
  const st1 = storedState('RC-ORD-1');
  ok(st1 && Object.values(st1.scanned || {}).every(q => !q) && !st1.endTime && !st1.pickup,
     'with its counts reset, no completion time and no pickup record — the floor re-picks');

  // A second call finds it no longer done — the same request cannot fire twice.
  r = await J('/api/orders/bulk-reclassify', { method: 'POST',
    body: JSON.stringify({ orders: ['RC-ORD-1'], to: 'pending', reason: 'completed against the wrong parcel — re-pick', password: 'demo' }) });
  ok(r.status === 200 && r.body.refused?.length === 1 && !r.body.results?.length,
     `a repeat is refused — the order is no longer completed (${r.body.refused?.[0]?.why})`);
  await wait(300);
  const s2b = await stockOf('RC-A');
  ok(s2b.on === s2.on && s2b.res === s2.res, 'and stock did not move a second time');

  // ── DONE → CANCELLED: stock back, nothing reserved, cancellation day stamped.
  r = await J('/api/orders/bulk-reclassify', { method: 'POST',
    body: JSON.stringify({ orders: ['RC-ORD-2'], to: 'cancelled', reason: 'customer refused the parcel at the door', password: 'demo' }) });
  ok(r.status === 200 && r.body.results?.length === 1, `RC-ORD-2 reclassifies to cancelled (${r.status})`);
  ok(r.body.results?.[0]?.unitsReturned === 4, `its 4 units came back to stock (${r.body.results?.[0]?.unitsReturned})`);
  await wait(400);
  const s3 = await stockOf('RC-A');
  ok(s3.on === s2.on + 4, `RC-A on hand got the 4 back (${s2.on}→${s3.on})`);
  ok(s3.res === s2.res, `and NOTHING extra is reserved — cancelled work holds no claim (${s3.res})`);
  const st2 = storedState('RC-ORD-2');
  ok(st2?.status === 'unprocessed', `the order reads Cancelled (${st2?.status})`);
  const fs = require('fs');
  const dbFile = __dirname + '/sup/tenants/default/db.json';
  // The day-bucket field — without it the cancellation files under the upload
  // date, the exact 15-vs-17 class of bug.
  ok(!!st2?.unprocessed_at, 'unprocessed_at is stamped, so it counts on the day it was cancelled');
  ok(st2?.unprocessed_reason === 'customer refused the parcel at the door', 'with the reason the person typed');

  // ── A MIXED SELECTION: one refusal reports itself, the rest go through.
  r = await J('/api/orders/bulk-reclassify', { method: 'POST',
    body: JSON.stringify({ orders: ['RC-ORD-3', 'RC-ORD-2'], to: 'cancelled', reason: 'sweep after the mis-completion', password: 'demo' }) });
  ok(r.status === 200, `a mixed selection still answers 200 (${r.status})`);
  ok((r.body.refused || []).length === 2 && !(r.body.results || []).length,
     `and BOTH are refused by name — RC-ORD-3 is not completed, RC-ORD-2 already cancelled (${(r.body.refused || []).map(x => x.why).join(' | ')})`);

  // ── WAREHOUSE gets a real 403 and changes nothing.
  await J('/api/master/users', { method: 'POST', body: JSON.stringify({ id: 'rcwh', name: 'RC Warehouse', password: 'rcwh123', role: 'warehouse' }) });
  const wl = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'rcwh', password: 'rcwh123' }) })).json();
  if (wl.token) {
    const wr = await fetch(BASE + '/api/orders/bulk-reclassify', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-token': wl.token },
      body: JSON.stringify({ orders: ['RC-ORD-1'], to: 'cancelled', reason: 'should be refused', password: 'rcwh123' }) });
    ok(wr.status === 403, `a warehouse user is refused server-side (${wr.status})`);
  } else ok(false, `could not sign in the warehouse fixture (${JSON.stringify(wl).slice(0, 80)})`);

  // ── THE TRAIL names who, why, and what moved.
  const rows = (JSON.parse(fs.readFileSync(dbFile, 'utf8')).auditLog || []).filter(e => e.type === 'order_reclassified');
  ok(rows.some(e => e.order === 'RC-ORD-1' && e.to === 'pending' && e.unitsReturned === 5 && e.by === 'demo'),
     'the trail carries RC-ORD-1 → pending with the units and the person');
  ok(rows.some(e => e.order === 'RC-ORD-2' && e.to === 'cancelled' && e.reason === 'customer refused the parcel at the door'),
     'and RC-ORD-2 → cancelled with the reason');

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
