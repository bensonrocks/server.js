// Cancelling here should tell the hub — but only if the store opted in, never
// on shipped work, and never back at a hub that told US.
const BASE = 'http://localhost:4636', MK = '201432547E', HUB = 'http://localhost:4927';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
let T = '', STORE = '';
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const hub = (n, s) => fetch(`${HUB}/__set?n=${n}&s=${encodeURIComponent(s)}`).then(r => r.json());
const hubStatus = async n => (await fetch(`${HUB}/__set?n=${n}&s=`).then(r => r.json())).orders[n].status;
const pull = () => J(`/api/master/zort/stores/${STORE}/pull`, { method: 'POST' });
const drain = () => J('/api/master/zort/outbox/drain', { method: 'POST' });
const listStores = async () => { const b = (await J('/api/master/zort/stores')).body; return Array.isArray(b) ? b : (b.stores || []); };
const setStore = body => J('/api/master/zort/stores', { method: 'POST', body: JSON.stringify({ id: STORE, ...body }) });
const cancel = (nums, reason) => J('/api/orders/bulk-cancel', { method: 'POST', body: JSON.stringify({ orders: nums, reason }) });
// THE AUDIT LOG IS NEVER WIPED, so every assertion has to be scoped to this
// run or it reads a previous one's entries (documented trap; it bit here).
const T0 = new Date().toISOString();
// db.json persistence is DEFERRED (setImmediate), so reading the file the
// instant a request returns can miss the entry it just wrote.
const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));
const audit = () => (JSON.parse(require('fs').readFileSync(__dirname + '/sup/tenants/default/db.json', 'utf8')).auditLog || [])
  .filter(e => String(e.at || '') >= T0);
const orderOf = async n => {
  const r = await J('/api/orders?range=all');
  const rows = Array.isArray(r.body) ? r.body : (r.body.orders || []);
  return rows.find(o => String(o.order_number) === n);
};

(async () => {
  T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  STORE = (await listStores()).find(s => s.clientName === 'ExCo')?.id;
  ok(!!STORE, 'the ExCo store is connected');
  // A PREVIOUS RUN LEAVES THE SWITCH ON AND ENTRIES IN THE OUTBOX. Reset both,
  // or the first two checks measure the last run rather than this one.
  await setStore({ cancelSync: false });
  {
    const fs = require('fs'), DB = __dirname + '/sup/tenants/default/db.json';
    const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
    db.zortOutbox = (db.zortOutbox || []).filter(e => e.kind !== 'void');
    fs.writeFileSync(DB, JSON.stringify(db, null, 2));
  }

  // ── OFF BY DEFAULT. A destructive action is never a default.
  const st0 = (await listStores()).find(s => s.id === STORE);
  ok(st0.cancelSync === false, `cancel push-back is OFF unless asked for (${st0.cancelSync})`);

  await hub('EX-OPEN', 'Pending'); await hub('EX-DONE', 'Pending');
  await pull();
  await cancel(['EX-OPEN'], 'not required by the client');
  await drain();
  ok(await hubStatus('EX-OPEN') === 'Pending', 'with it off, cancelling here tells the hub NOTHING');
  await settle();
  ok(!audit().some(e => e.type === 'sync_void_queued' && e.order === 'EX-OPEN'), 'and nothing is queued');

  // ── TURNED ON, it tells them — and the hub really moves.
  await setStore({ cancelSync: true });
  ok((await listStores()).find(s => s.id === STORE).cancelSync === true, 'the switch saves');
  ok(audit().some(e => e.type === 'zort_cancel_sync_changed' && e.enabled === true),
     'and who turned it on is on the record — this is destructive');

  await hub('EX-OPEN', 'Pending');
  // Re-import it as fresh work so there is something live to cancel.
  await J('/api/master/client-data/wipe', { method: 'POST',
    body: JSON.stringify({ client: 'ExCo', scopes: ['orders'], confirm: 'ExCo' }) });
  await pull();
  ok(!!(await orderOf('EX-OPEN')), 'the order is back on the floor');
  await cancel(['EX-OPEN'], 'client asked us to drop it');
  await settle();
  ok(audit().some(e => e.type === 'sync_void_queued' && e.order === 'EX-OPEN'), 'cancelling queues the void');
  await drain(); await settle();
  ok(await hubStatus('EX-OPEN') === 'Voided', `the hub is now void (${await hubStatus('EX-OPEN')})`);
  ok(audit().some(e => e.type === 'sync_void_pushed' && e.order === 'EX-OPEN'),
     'recorded as pushed — and only AFTER reading the hub back, not on a bare 200');

  // ── ONCE ONLY. A second cancel cannot tell them twice.
  const n1 = audit().filter(e => e.type === 'sync_void_pushed' && e.order === 'EX-OPEN').length;
  await cancel(['EX-OPEN'], 'again');
  await drain();
  ok(audit().filter(e => e.type === 'sync_void_pushed' && e.order === 'EX-OPEN').length === n1,
     'a second cancel does not send a second void');

  // ── NEVER ON SHIPPED WORK. The hub had already shipped it.
  await hub('EX-DONE', 'Pending');
  await pull();
  await hub('EX-DONE', 'Shipping');
  await cancel(['EX-DONE'], 'cancelled here by mistake');
  await drain(); await settle();
  ok(await hubStatus('EX-DONE') === 'Shipping',
     `a parcel the hub already shipped is NOT voided (${await hubStatus('EX-DONE')})`);
  ok(audit().some(e => e.type === 'sync_void_refused_shipped' && e.order === 'EX-DONE'),
     'and the disagreement is reported, not swallowed');
  // Read the outage straight off the volume — there is no list endpoint.
  const dbj = JSON.parse(require('fs').readFileSync(__dirname + '/sup/tenants/default/db.json', 'utf8'));
  ok((dbj.systemErrors || []).some(e => /already shipped it/i.test(e.message || '')),
     'raised as something a person has to look at in System Outages, not just a log line');

  // ── NEVER BACK AT A HUB THAT TOLD US. A void the hub reported is not ours
  // to send back.
  const before = audit().filter(e => e.type === 'sync_void_queued').length;
  await hub('EX-DONE', 'Voided');
  await pull();
  ok(audit().filter(e => e.type === 'sync_void_queued').length === before,
     'a void the CHANNEL reported is never echoed back at them');

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
