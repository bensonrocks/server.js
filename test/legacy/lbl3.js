// THE ORDER-FILES FALLBACK: GetShipmentLabels answers EMPTY for PLBL-3, but
// the marketplace label sits on the order's FILE LIST (the way ZORT's
// "Lazada Label" task stores it). The fetcher must find it there — and must
// NEVER fetch the invoice that sits beside it.
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4636';
const MK = '201432547E';
const T0 = new Date().toISOString();

(async () => {
  const login = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': login.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());
  const store = (await J('/api/master/zort/stores')).find(s => s.clientName === 'LblCo');
  ok(!!store, `LblCo store present (${store?.id})`);

  await J(`/api/master/zort/stores/${store.id}/pull`, { method: 'POST' });
  await J('/api/master/zort/outbox/drain', { method: 'POST' });
  await new Promise(r => setTimeout(r, 2500));

  const db = JSON.parse(require('fs').readFileSync(
    '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/sup/tenants/default/db.json', 'utf8'));
  const audit = (db.auditLog || []).filter(e => e.at >= T0);

  const imported = audit.find(e => e.type === 'sync_label_imported' && e.order === 'PLBL-3');
  ok(!!imported, `PLBL-3's label imported from the ORDER FILES (${JSON.stringify(imported || {}).slice(0, 90)})`);
  ok(!!(db.orderLabels || {})['PLBL-3'], 'and is attached to the order');
  const via = audit.find(e => e.type === 'sync_label_via_fallback' && e.order === 'PLBL-3');
  ok(/^order-file/.test(via?.via || ''), `via the order-file route (${via?.via})`);

  const stats = await fetch('http://localhost:4930/_stats').then(r => r.json());
  ok(stats.invoiceFetches === 0, `the INVOICE beside it was never fetched (${stats.invoiceFetches})`);

  // The probe's two new evidence steps answer with raw data.
  const probe = await J(`/api/master/zort/stores/${store.id}/probe`, { method: 'POST' });
  const names = (probe.steps || []).map(s => s.name);
  ok(names.includes('GetOrderFiles') && names.includes('GetShipmentTransactions'),
     `the probe now prints order files and shipment transactions (${names.join(', ')})`);

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
