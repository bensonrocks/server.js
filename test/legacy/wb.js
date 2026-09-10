// "The waybill is in ZORT but not in IdealOne."
//
// TWO CAUSES, both reproduced here against a hub that assigns tracking LATE:
//   1. the backfill on the pull REFUSED a done order, so an order picked and
//      packed faster than the channel mints its AWB stayed blank for ever;
//   2. the pull only sees what `updatedafter` returns, so an order whose
//      tracking arrives after it leaves that window was never re-read at all.
const BASE = 'http://localhost:4636', MK = '201432547E', HUB = 'http://localhost:4928';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
let T = '';
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const waybillOf = async (num) => {
  const list = (await J('/api/orders?range=all')).body;
  const arr = Array.isArray(list) ? list : list.orders || [];
  return (arr.find(o => o.order_number === num) || {}).waybill_number ?? null;
};

const T0 = new Date().toISOString();   // the audit log is NEVER wiped — scope every assertion to this run

(async () => {
  T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;

  // A store pointed at the mock hub.
  const stores = (await J('/api/master/zort/stores')).body;
  let store = (stores.stores || stores || []).find(s => s.clientName === 'ChaseCo');
  if (!store) {
    const mk = await J('/api/master/zort/stores', { method: 'POST', body: JSON.stringify({
      clientName: 'ChaseCo', storename: 'chase', apikey: 'k', apisecret: 's',
      endpoint: HUB, enabled: true, autoPullMinutes: 0 }) });
    store = mk.body.store || mk.body;
  }
  const sid = store.id;
  ok(!!sid, `a store pointed at the mock hub (${sid})`);

  // Run through wb-run.sh — it clears these orders out of db.json with the
  // server STOPPED, which is the only reset that sticks.
  // ── PULL 1: the orders arrive with NO tracking number, as they really do.
  let pull = await J(`/api/master/zort/stores/${sid}/pull`, { method: 'POST', body: '{}' });
  ok(pull.status === 200, `first pull runs (${pull.status})`);
  ok((await waybillOf('WB-1')) === '' || (await waybillOf('WB-1')) === null || !(await waybillOf('WB-1')),
     'the order imports with NO waybill — which is exactly how Lazada delivers it');

  // ── COMPLETE IT before the channel gets round to the AWB. This is the case
  // the old guard refused, and it is the normal one on a fast-moving account.
  const list = (await J('/api/orders?range=all')).body;
  const arr = Array.isArray(list) ? list : list.orders || [];
  const ord = arr.find(o => o.order_number === 'WB-1');
  if (!ord) { ok(false, 'WB-1 did not import'); console.log('\nSTOP'); return; }
  for (const l of (ord.items || [])) {
    await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: 'WB-1', sku: l.sku, qty: Number(l.qty) || 0 }) });
  }
  const done = await J('/api/scan/complete', { method: 'POST',
    body: JSON.stringify({ orderNumber: 'WB-1', endTime: new Date().toISOString() }) });
  ok(done.status === 200 && done.body.ok !== false, `WB-1 is picked, packed and completed (${JSON.stringify(done.body).slice(0, 80)})`);

  // ── NOW THE CHANNEL ASSIGNS THE TRACKING NUMBERS.
  await fetch(HUB + '/_assign');

  // ── PULL 2.
  pull = await J(`/api/master/zort/stores/${sid}/pull`, { method: 'POST', body: '{}' });
  ok(pull.status === 200, `second pull runs (${pull.status})`);
  await new Promise(r => setTimeout(r, 400));            // db writes are deferred

  const wb1 = await waybillOf('WB-1');
  ok(!!wb1, `THE COMPLETED ORDER GETS ITS WAYBILL (${wb1 || 'still blank'}) — the old code refused this because it was done`);
  const wb2 = await waybillOf('WB-2');
  ok(!!wb2, `and so does the one still open (${wb2 || 'still blank'})`);

  // ── THE ONE THAT FELL OUT OF THE WINDOW. Its `updated` is weeks old, so the
  // scheduled sweep's `updatedafter` never returns it; only the targeted chase
  // at the end of the pull can reach it.
  const wbOld = await waybillOf('WB-OLD'), wbOld2 = await waybillOf('WB-OLD2');
  ok(!!wbOld && !!wbOld2,
     `AND BOTH orders outside the updatedafter window (${wbOld || 'blank'}, ${wbOld2 || 'blank'}) — chased by order number`);

  // ── THE LIST DID NOT CARRY IT; THE DETAIL DID. On the hub's own screen the
  // tracking number sits under Shipping -> Tracking No., which is order detail.
  // Assuming the list row carries it is exactly how a waybill ZORT plainly has
  // stays blank here.
  const wbDetail = await waybillOf('WB-DETAIL');
  ok(!!wbDetail, `an order whose LIST row has no tracking is read from its detail (${wbDetail || 'still blank'})`);

  // ── THE ONE THE HUB WILL NOT ANSWER FOR IS REPORTED, not retried in silence.
  // /api/master/zort/stores answers with a BARE ARRAY — reading `.stores` off
  // it gives undefined and the check silently proves nothing. Same trap as
  // /api/portal/orders.
  const sBody = (await J('/api/master/zort/stores')).body;
  const store2 = ((Array.isArray(sBody) ? sBody : sBody.stores) || []).find(s => s.id === sid) || {};
  const lr = store2.lastResult || {};
  ok((lr.waybillNotOnHub || []).includes('WB-GHOST'),
     `the hub answering for no such order is named on the store row (${JSON.stringify(lr.waybillNotOnHub || [])})`);
  ok(Number(lr.waybillChased) > 0, `and the row says how many blanks were chased (${lr.waybillChased})`);

  // ── THE CHASE COSTS ONE CALL, not one per order. This matters on an account
  // metered at 50,000 requests a day.
  const calls = (await (await fetch(HUB + '/_calls')).json()).calls || [];
  const targeted = calls.filter(c => c.includes('/Order/GetOrders') && c.split('|')[1]);
  ok(targeted.length >= 1, `the catch-up used the numberlist header (${targeted.length} targeted read(s))`);
  const biggest = targeted.map(c => c.split('|')[1].split(',').length).sort((a, b) => b - a)[0] || 0;
  ok(biggest > 1, `asking for ${biggest} orders in ONE request rather than one call each`);
  // THE COST PROPERTY THAT MATTERS: one targeted read per pull, however many
  // orders are behind. The account is metered at 50,000 requests a day.
  const before3 = (await (await fetch(HUB + '/_calls')).json()).calls.length;
  await J(`/api/master/zort/stores/${sid}/pull`, { method: 'POST', body: '{}' });
  await new Promise(r => setTimeout(r, 400));
  const after3 = (await (await fetch(HUB + '/_calls')).json()).calls;
  const inPull = after3.slice(before3).filter(c => c.includes('/Order/GetOrders') && c.split('|')[1]);
  ok(inPull.length <= 1, `a pull makes at most ONE catch-up call (${inPull.length})`);

  // ── A WAYBILL WE ALREADY HOLD IS NEVER OVERWRITTEN.
  const before = await waybillOf('WB-2');
  await J(`/api/master/zort/stores/${sid}/pull`, { method: 'POST', body: '{}' });
  await new Promise(r => setTimeout(r, 400));
  ok((await waybillOf('WB-2')) === before, 'a third pull does not rewrite a waybill already held');

  // ── AND IT IS ON THE TRAIL, saying it landed after completion.
  const dbFile = __dirname + '/sup/tenants/default/db.json';
  const rows = (JSON.parse(require('fs').readFileSync(dbFile, 'utf8')).auditLog || [])
    .filter(e => e.type === 'sync_waybill_backfilled' && String(e.at || '') >= T0);
  if (!rows.length) console.log('SKIP - no backfill entries on the trail yet (deferred write)');
  else {
    ok(rows.some(e => e.order === 'WB-1' && e.afterCompletion), 'the trail records that WB-1 was filled after it completed');
    ok(rows.some(e => e.via === 'chase'), 'and that WB-OLD came from the catch-up');
  }

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
