// MASS COLLECTION FOR API ORDERS — per the user: the tick now closes synced
// orders too; Picked Up is an internal own status and NOTHING relays to the
// platform; cancelled work (ours or the marketplace's) is never closeable.
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4636';
const MK = '201432547E';

(async () => {
  const login = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': login.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());
  const hubRow = async () => (await fetch('http://localhost:4928/Order/GetOrders').then(r => r.json())).list
    .find(o => o.number === 'MP-PLAIN');

  // Idempotent start: free any pickups a previous run left behind.
  await J('/api/orders/pickup', { method: 'POST', body: JSON.stringify({ orderNumbers: ['MP-PLAIN', 'MP-DONE'], undo: true }) });

  // ── COMPLETE the API order MP-PLAIN through the real scan endpoints
  // (skipped when a previous run already did).
  const pre = (await J('/api/orders?range=all'));
  const preArr = Array.isArray(pre) ? pre : pre.orders || [];
  if (preArr.find(o => o.order_number === 'MP-PLAIN')?.scan_status !== 'done') {
    for (let i = 0; i < 2; i++) await J('/api/scan/increment', { method: 'POST', body: JSON.stringify({ orderNumber: 'MP-PLAIN', sku: 'MP-SKU-1' }) });
    const done = await J('/api/scan/complete', { method: 'POST',
      body: JSON.stringify({ orderNumber: 'MP-PLAIN', startTime: new Date().toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) });
    ok(done.ok !== false, `MP-PLAIN (API order) completed here (${JSON.stringify(done).slice(0, 60)})`);
  } else ok(true, 'MP-PLAIN already completed by a previous run');

  const hubBefore = await hubRow();

  // ── THE QUEUE offers it, and marks the marketplace-cancelled one instead.
  const q = await J('/api/orders/pickup-queue');
  const rowPlain = (q.rows || []).find(r => r.order_number === 'MP-PLAIN');
  const rowDone  = (q.rows || []).find(r => r.order_number === 'MP-DONE');
  ok(rowPlain && rowPlain.api_source === true && !rowPlain.platform_cancelled,
     'the API order sits in the collection queue as tickable');
  ok(rowDone && rowDone.platform_cancelled === true,
     'the marketplace-cancelled parcel is listed but FLAGGED — visible, never offered');

  // ── THE TICK CLOSES THE API ORDER NOW.
  const t1 = await J('/api/orders/pickup', { method: 'POST', body: JSON.stringify({ orderNumbers: ['MP-PLAIN'], method: 'manual' }) });
  ok(t1.updated === 1 && !(t1.refused || []).length, `a hand-tick closes the API order (${JSON.stringify(t1).slice(0, 80)})`);
  const all = await J('/api/orders?range=all');
  const arr = Array.isArray(all) ? all : all.orders || [];
  const mp = arr.find(o => o.order_number === 'MP-PLAIN');
  ok(mp?.pickup_status === 'picked_up' && mp?.pickup_method === 'manual',
     `recorded as picked up, method "manual" — never claimed as a courier scan (${mp?.pickup_method})`);

  // ── NOTHING WENT TO THE PLATFORM. The hub's record is byte-identical.
  const hubAfter = await hubRow();
  ok(JSON.stringify(hubAfter) === JSON.stringify(hubBefore),
     `the hub's own record is untouched — internal status only (status still "${hubAfter?.status}")`);

  // ── CANCELLED WORK IS NEVER CLOSEABLE.
  const t2 = await J('/api/orders/pickup', { method: 'POST', body: JSON.stringify({ orderNumbers: ['MP-OPEN'], method: 'manual' }) });
  ok((t2.refused || []).some(x => x.order === 'MP-OPEN' && /Not finished/.test(x.error)),
     `a CANCELLED order is refused (${JSON.stringify(t2.refused)})`);
  const t3 = await J('/api/orders/pickup', { method: 'POST', body: JSON.stringify({ orderNumbers: ['MP-DONE'], method: 'manual' }) });
  ok((t3.refused || []).some(x => x.order === 'MP-DONE' && /marketplace/i.test(x.error) && /reclassify/i.test(x.error)),
     `a marketplace-cancelled parcel is refused BY NAME with the way out (${(t3.refused || [])[0]?.error})`);

  // ── UNDO still works on the API order.
  const u = await J('/api/orders/pickup', { method: 'POST', body: JSON.stringify({ orderNumbers: ['MP-PLAIN'], undo: true }) });
  ok(u.updated === 1, 'undo reverses the tick');
  // re-close it so the fixture ends tidy
  await J('/api/orders/pickup', { method: 'POST', body: JSON.stringify({ orderNumbers: ['MP-PLAIN'], method: 'manual' }) });

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
