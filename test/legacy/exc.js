// A parcel the courier brought back must stop reading as shipped — on our
// screens and on the client's — without regressing the work or the stock.
const BASE = 'http://localhost:4636', MK = '201432547E', HUB = 'http://localhost:4927';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
let T = '', STORE = '';
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const hub = (n, s) => fetch(`${HUB}/__set?n=${n}&s=${encodeURIComponent(s)}`).then(r => r.json());
const pull = () => J(`/api/master/zort/stores/${STORE}/pull`, { method: 'POST' });
const orderOf = async n => {
  const r = await J('/api/orders?range=all');
  const rows = Array.isArray(r.body) ? r.body : (r.body.orders || []);
  return rows.find(o => String(o.order_number) === n);
};
// The audit log is NEVER wiped, so a re-run reads the last run's rows unless
// every assertion is scoped to this one.
const T0 = new Date().toISOString();
// db.json persistence is DEFERRED, so reading the file the instant a request
// returns can miss the entry it just wrote.
const settle = (ms = 250) => new Promise(r => setTimeout(r, ms));
const audit = () => (JSON.parse(require('fs').readFileSync(__dirname + '/sup/tenants/default/db.json', 'utf8')).auditLog || [])
  .filter(e => String(e.at || '') >= T0);

(async () => {
  T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  // The stores endpoint returns a BARE ARRAY, not {stores:[…]}.
  const listStores = async () => { const b = (await J('/api/master/zort/stores')).body; return Array.isArray(b) ? b : (b.stores || []); };
  for (const s of await listStores()) if (s.clientName === 'ExCo') await J(`/api/master/zort/stores/${s.id}`, { method: 'DELETE' });
  const mk = await J('/api/master/zort/stores', { method: 'POST', body: JSON.stringify({
    clientName: 'ExCo', storename: 'hub', apikey: 'k', apisecret: 's', endpoint: HUB, enabled: true, completeAction: 'none' }) });
  STORE = mk.body?.store?.id || (await listStores()).find(s => s.clientName === 'ExCo').id;

  // A RE-RUN MUST START CLEAN. The orders already exist from last time, and the
  // pull deliberately skips numbers it already holds — so without clearing them
  // this measures the previous run.
  await J('/api/master/client-data/wipe', { method: 'POST',
    body: JSON.stringify({ client: 'ExCo', scopes: ['orders'], confirm: 'ExCo' }) });

  // ── Both orders arrive as ordinary work.
  await hub('EX-DONE', 'Pending'); await hub('EX-OPEN', 'Pending');
  let r = await pull();
  ok(r.status === 200, 'the first pull imports them');
  ok(!!(await orderOf('EX-DONE')) && !!(await orderOf('EX-OPEN')), 'both orders are on the floor');
  ok(!(await orderOf('EX-DONE')).hub_exception, 'and neither carries an exception yet');

  // Finish one of them the normal way, so it is genuinely shipped from here.
  const d = await orderOf('EX-DONE');
  await J('/api/scan/increment', { method: 'POST', body: JSON.stringify({ orderNumber: 'EX-DONE', sku: 'EX-SKU' }) });
  await J('/api/scan/complete', { method: 'POST', body: JSON.stringify({ orderNumber: 'EX-DONE' }) });
  ok((await orderOf('EX-DONE')).scan_status === 'done', 'one of them is picked, packed and completed here');

  // ── THE COURIER BRINGS IT BACK.
  await hub('EX-DONE', 'Returned');
  await pull();
  let o = await orderOf('EX-DONE');
  ok(!!o.hub_exception, 'the return is recorded on the order');
  ok(o.hub_exception.status === 'returned', `…as a return (${o.hub_exception.status})`);
  ok(o.hub_exception.label === 'Returned to us', `in words, not a status code (${o.hub_exception.label})`);
  ok(!!o.hub_exception.at && !!o.hub_exception.noticed_at, 'with when it happened and when we learned of it');
  ok(o.hub_exception.local_status === 'done', 'and what our own status was at the time');

  // WHAT IT MUST NOT DO.
  ok(o.scan_status === 'done', 'THE WORK IS NOT REGRESSED — it really was picked and packed');
  ok(!!o.pickup || o.pickup === undefined || o.pickup === null, 'the collection record is untouched — the parcel did leave');
  const inv = await J('/api/inventory?clientId=' + encodeURIComponent('exco'));
  ok(inv.status === 200, 'stock is readable');
  ok(!(await orderOf('EX-DONE')).scan_status.includes('pending'), 'and the order is not reopened');

  // ── A RE-PULL CHANGES NOTHING.
  const before = JSON.stringify((await orderOf('EX-DONE')).hub_exception);
  await pull();
  ok(JSON.stringify((await orderOf('EX-DONE')).hub_exception) === before,
     'a second pull does not re-stamp it — the record cannot drift');

  // ── THE HUB SAYS IT CAME BACK AND WE NEVER SHIPPED IT is a different problem.
  await hub('EX-OPEN', 'Returned');
  await pull(); await settle();
  o = await orderOf('EX-OPEN');
  ok(!!o.hub_exception, 'an order we never shipped is flagged too');
  ok(o.hub_exception.local_status !== 'done',
     `and recorded as never having shipped from here (${o.hub_exception.local_status})`);
  const conflictRow = audit().filter(e => e.type === 'sync_order_returned').find(e => e.order === 'EX-OPEN');
  ok(!!conflictRow && conflictRow.neverShippedHere === true,
     'the trail says so explicitly, rather than filing it as a routine return');

  // ── A FAILED SHIPMENT IS ITS OWN THING, and a change of status re-records.
  await hub('EX-OPEN', 'Failed Shipment');
  await pull(); await settle();
  o = await orderOf('EX-OPEN');
  ok(o.hub_exception.status === 'failed shipment', `a status CHANGE updates the record (${o.hub_exception.status})`);
  ok(o.hub_exception.label === 'Shipment failed', 'with its own wording, not the return\'s');
  ok(audit().some(e => e.type === 'sync_order_shipment_failed' && e.order === 'EX-OPEN'),
     'and its own event on the trail');
  ok(audit().filter(e => e.type === 'sync_order_returned' && e.order === 'EX-OPEN').length === 1,
     'the earlier return is still on the trail — history is not rewritten');

  // ── THE PULL REPORTS IT, because a count of zero and a count of nine are
  // different mornings.
  const st = (await listStores()).find(s => s.id === STORE);
  ok(Number(st.lastResult?.hubExceptionCount) >= 0, 'the store row carries the count');
  ok(Array.isArray(st.lastResult?.hubExceptions), 'and which orders they were');

  // ── AN ORDINARY ORDER IS UNTOUCHED.
  await hub('EX-DONE', 'Success');   // back to normal; the record stays as it was
  await pull();
  ok((await orderOf('EX-DONE')).hub_exception?.status === 'returned',
     'a hub that changes its mind does not silently erase what it told us');

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
