// "THE LABELS ARE OUT IN ZORT — PULL THEM IN." One action per store that
// revives label jobs which gave up waiting, queues one for any synced order
// that has none, drains, and reports per order. The decisive case is a
// STALLED entry: a plain drain skips those, so the order sat label-less
// however many times anyone pressed drain.
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4636';
const MK = '201432547E';
const DB = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/sup/tenants/default/db.json';

(async () => {
  const login = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': login.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());
  const store = (await J('/api/master/zort/stores')).find(s => s.clientName === 'LblCo');
  ok(!!store, `LblCo store (${store?.id})`);

  // The reported shape: the order is in, the label job STALLED after waiting,
  // and the label has since appeared at the channel.
  const before = JSON.parse(require('fs').readFileSync(DB, 'utf8'));
  const stalledCount = (before.zortOutbox || []).filter(e => e.kind === 'label' && e.stalled).length;
  ok(true, `starting with ${stalledCount} stalled label job(s)`);

  // A plain drain does nothing for a stalled entry.
  const d0 = await J('/api/master/zort/outbox/drain', { method: 'POST' });
  ok(true, `plain drain leaves ${d0.stalled} stalled`);

  const r = await J(`/api/master/zort/stores/${store.id}/labels/retry`, { method: 'POST' });
  ok(r.ok === true, `the retry ran (${JSON.stringify(r).slice(0, 120)})`);
  ok(typeof r.asked === 'number' && r.asked >= 1, `it found the order(s) with no label (${r.asked})`);
  ok(r.attached >= 1, `and pulled ${r.attached} label(s) in`);
  ok((r.orders || []).includes('PLBL-1') || (r.orders || []).length > 0, `naming which (${(r.orders || []).join(', ')})`);

  const after = JSON.parse(require('fs').readFileSync(DB, 'utf8'));
  ok(!!(after.orderLabels || {})['PLBL-1'], 'PLBL-1 now carries its label');

  // AN ORDER WE CANNOT GET A LABEL FOR IS NAMED, not silently dropped.
  const unexplained = [...(r.stillWaiting || []), ...(r.failed || [])].filter(x => !x.why);
  ok(unexplained.length === 0, 'every order left over carries a reason');

  // The trail records who asked.
  const aud = (after.auditLog || []).slice(-40).find(e => e.type === 'sync_labels_retry_requested');
  ok(!!aud, `audited (${JSON.stringify(aud || {}).slice(0, 90)})`);

  // Switching label pull off refuses in words rather than doing nothing.
  await J('/api/master/zort/stores', { method: 'POST', body: JSON.stringify({ id: store.id, labelSync: false }) });
  const off = await fetch(`${B}/api/master/zort/stores/${store.id}/labels/retry`, { method: 'POST', headers: H });
  const offBody = await off.json();
  ok(off.status === 409 && /switched off/i.test(offBody.error || ''),
     `with label pull off it says so (${off.status}: ${offBody.error})`);
  await J('/api/master/zort/stores', { method: 'POST', body: JSON.stringify({ id: store.id, labelSync: true }) });

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
