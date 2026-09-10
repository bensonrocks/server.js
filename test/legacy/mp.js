// MARKETPLACE-SIDE CANCELLATION (integrationStatus) — the 170217257037005 fix.
// Against a hub whose own status never moves for a cancel:
//   1. an order arriving already marketplace-cancelled is never imported;
//   2. an untouched order cancelled later is auto-cancelled here, reason named;
//   3. a COMPLETED order is NEVER regressed — flagged loudly instead, with the
//      hub's own word on the trail (this is the reported case, hub "success");
//   4. a re-pull re-stamps nothing;  5. no integrationStatus → nothing happens.
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4636';
const MK = '201432547E';

(async () => {
  const login = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': login.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());
  const T0 = new Date().toISOString();

  const stores = await J('/api/master/zort/stores');
  const store = stores.find(s => s.clientName === 'ChaseCo');
  const pull = () => J(`/api/master/zort/stores/${store.id}/pull`, { method: 'POST' });
  const orderOf = async (n) => {
    const all = await J('/api/orders?range=all&cancelled=all').catch(() => []);
    const arr = Array.isArray(all) ? all : all.orders || [];
    return arr.find(o => o.order_number === n)
      // the everyday list filters some cancelled shapes — fall back to search
      || (Array.isArray(all) ? all : []).find(o => o.order_number === n);
  };
  // No audit-read API exists — read db.json off disk. Persistence is
  // DEFERRED (setImmediate), so settle first or the read misses the write.
  const auditCount = async (type, order) => {
    await new Promise(r => setTimeout(r, 1500));
    const db = JSON.parse(require('fs').readFileSync(
      '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad/sup/tenants/default/db.json', 'utf8'));
    return (db.auditLog || []).filter(e => e.type === type && e.at >= T0 && (!order || e.order === order)).length;
  };

  // ── 1. FIRST PULL: MP-NEW never imports; the other three do.
  const p1 = await pull();
  const r1 = p1.result || p1;
  ok((r1.skippedByStatus || {})['marketplace-cancelled'] === 1,
     `the already-cancelled arrival is skipped and counted (${JSON.stringify(r1.skippedByStatus)})`);
  ok(!(await orderOf('MP-NEW')), 'MP-NEW is NOT on our books');
  for (const n of ['MP-OPEN', 'MP-DONE', 'MP-PLAIN']) {
    ok(!!(await orderOf(n)), `${n} imported as floor work`);
  }

  // ── COMPLETE MP-DONE through the real scan endpoints.
  for (let i = 0; i < 2; i++) {
    const r = await J('/api/scan/increment', { method: 'POST', body: JSON.stringify({ orderNumber: 'MP-DONE', sku: 'MP-SKU-1' }) });
    if (r.error) console.log('scan err:', r.error);
  }
  const done = await J('/api/scan/complete', { method: 'POST',
    body: JSON.stringify({ orderNumber: 'MP-DONE', startTime: T0, endTime: new Date().toISOString(), operator: 'demo' }) });
  ok(done.ok !== false && !done.mismatches?.length, `MP-DONE completed here (${JSON.stringify(done).slice(0, 80)})`);

  // ── 2 + 3. THE MARKETPLACE CANCELS BOTH — ZORT's own status stays put
  // (and for MP-DONE it even moves to "success", the exact reported shape).
  await fetch('http://localhost:4928/_cancel?n=MP-OPEN');
  await fetch('http://localhost:4928/_cancel?n=MP-DONE&success=1');
  const p2 = await pull();
  const r2 = p2.result || p2;
  ok(r2.marketplaceCancelled === 1, `one untouched order auto-cancelled (${r2.marketplaceCancelled})`);
  ok((r2.marketplaceCancelConflicts || []).some(x => x.order === 'MP-DONE'),
     `the completed one is reported as a CONFLICT instead (${JSON.stringify(r2.marketplaceCancelConflicts)})`);

  const open = await orderOf('MP-OPEN');
  ok(open?.scan_status === 'unprocessed', `MP-OPEN is cancelled here (${open?.scan_status})`);
  ok(/marketplace/i.test(open?.unprocessed_reason || '') && /cancel/i.test(open?.unprocessed_reason || ''),
     `with the marketplace named in the reason ("${open?.unprocessed_reason}")`);
  ok(!!open?.unprocessed_at, `and the cancellation day stamped (${open?.unprocessed_at?.slice(0, 10)})`);

  const doneOrd = await orderOf('MP-DONE');
  ok(doneOrd?.scan_status === 'done', `MP-DONE is STILL done — completed work never regressed (${doneOrd?.scan_status})`);
  ok(!!doneOrd?.platform_cancelled, 'but carries the platform_cancelled flag');
  ok(/cancel/i.test(doneOrd?.platform_cancelled?.status || ''),
     `with the marketplace's own word on it ("${doneOrd?.platform_cancelled?.status}")`);

  const plain = await orderOf('MP-PLAIN');
  ok(plain?.scan_status === 'pending' && !plain?.platform_cancelled,
     `MP-PLAIN untouched — no integrationStatus, nothing invented (${plain?.scan_status})`);

  ok((await auditCount('sync_marketplace_cancelled', 'MP-OPEN')) === 1, 'the auto-cancel is on the trail');
  ok((await auditCount('sync_marketplace_cancel_conflict', 'MP-DONE')) === 1, 'and so is the conflict, under its own event');

  // ── 4. A RE-PULL CHANGES NOTHING.
  const p3 = await pull();
  const r3 = p3.result || p3;
  ok((r3.marketplaceCancelled || 0) === 0 && !(r3.marketplaceCancelConflicts || []).length,
     `a second pull re-stamps nothing (${r3.marketplaceCancelled}/${(r3.marketplaceCancelConflicts || []).length})`);
  ok((await auditCount('sync_marketplace_cancel_conflict', 'MP-DONE')) === 1, 'the trail did not grow');

  // ── 5. 🔍 FIND ORDER now reports BOTH statuses.
  const lk = await J(`/api/master/zort/stores/${store.id}/lookup`, { method: 'POST', body: JSON.stringify({ numbers: ['MP-DONE'] }) });
  const row = (lk.rows || [])[0] || {};
  ok(/cancel/i.test(row.integrationStatus || ''),
     `the lookup carries the marketplace status ("${row.zortStatus}" / "${row.integrationStatus}")`);

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
