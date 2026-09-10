// TWO AUTO-CANCEL CLOCKS — no stock 10 min, insufficient stock 90 min.
// Phase is passed as argv[2]:
//   arm      — first sweep arms both clocks, cancels nothing, kinds correct
//   after11  — clocks backdated 11 min: NO-stock order cancels; partial holds
//   after91  — partial clock backdated 91 min: the partial cancels too, with
//              "short of AC-BCD" in the reason and the frozen stamp on it
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4636';
const MK = '201432547E';
const phase = process.argv[2] || 'arm';

(async () => {
  const login = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': login.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());
  const orderOf = async (n) => {
    const all = await J('/api/orders?range=all');
    return (Array.isArray(all) ? all : all.orders || []).find(o => o.order_number === n);
  };

  if (phase === 'arm') {
    // Make sure AcCo's shelf is what the fixture assumes.
    await J('/api/inventory/import', { method: 'POST', body: JSON.stringify({ clientId: 'AcCo', items: [
      { sku: 'AC-ABC', name: 'AC Widget A', stock_qty: 1 },
      { sku: 'AC-BCD', name: 'AC Widget B', stock_qty: 0 },
    ] }) });
    const pol = (await J('/api/master/orders/auto-cancel')).policy;
    ok(pol.minutes === 10, `no-stock default is now 10 minutes (${pol.minutes})`);
    ok(pol.partialMinutes === 90, `insufficient-stock default is 90 minutes (${pol.partialMinutes})`);

    const s1 = await J('/api/master/orders/auto-cancel-sweep', { method: 'POST', body: JSON.stringify({}) });
    ok((s1.cancelled || []).length === 0, `first sweep cancels nothing — it only arms (${(s1.cancelled || []).length})`);
    const armedResp = await J('/api/master/orders/auto-cancel');
    const byOrder = Object.fromEntries((armedResp.armed || []).map(a => [a.order, a]));
    ok(byOrder['AC-NONE']?.kind === 'none' && byOrder['AC-NONE'].minutesLeft <= 10,
       `AC-NONE on the 10-min clock (${JSON.stringify(byOrder['AC-NONE'])})`);
    ok(byOrder['AC-PART']?.kind === 'partial' && byOrder['AC-PART'].minutesLeft > 80,
       `AC-PART on the 90-min clock (${JSON.stringify(byOrder['AC-PART'])})`);
    ok(byOrder['AC-PART2']?.kind === 'partial', 'a quantity shortfall arms the partial clock too');
    ok(!byOrder['AC-OK'], 'the fully covered order is on no clock');
  }

  if (phase === 'after11') {
    const s = await J('/api/master/orders/auto-cancel-sweep', { method: 'POST', body: JSON.stringify({}) });
    const names = (s.cancelled || []).map(c => c.order);
    ok(names.includes('AC-NONE'), `after 11 min the NO-stock order is cancelled (${names.join(', ') || 'none'})`);
    ok(!names.includes('AC-PART') && !names.includes('AC-PART2'),
       'the partials HOLD — 11 min is nowhere near their 90');
    const none = await orderOf('AC-NONE');
    ok(none?.scan_status === 'unprocessed' && /No stock/i.test(none?.unprocessed_reason || ''),
       `AC-NONE cancelled with the no-stock reason ("${none?.unprocessed_reason}")`);
    ok((none?.auto_cancelled_short || []).some(x => x.sku === 'AC-BCD'),
       'and the frozen shortfall stamped on it for the pill');
    const part = await orderOf('AC-PART');
    ok(part?.scan_status === 'pending', `AC-PART is still live (${part?.scan_status})`);
  }

  if (phase === 'after91') {
    const s = await J('/api/master/orders/auto-cancel-sweep', { method: 'POST', body: JSON.stringify({}) });
    const names = (s.cancelled || []).map(c => c.order);
    ok(names.includes('AC-PART') && names.includes('AC-PART2'),
       `after 91 min the partials cancel too (${names.join(', ') || 'none'})`);
    const part = await orderOf('AC-PART');
    ok(/Insufficient stock/i.test(part?.unprocessed_reason || '') && /short of AC-BCD \(0 of 1\)/.test(part?.unprocessed_reason || ''),
       `the reason NAMES what it was short of ("${part?.unprocessed_reason}")`);
    ok(part?.auto_cancelled_why === 'short_stock'
       && (part?.auto_cancelled_short || []).some(x => x.sku === 'AC-BCD' && x.have === 0 && x.need === 1),
       'the frozen stamp carries the balances at cancellation');
    const p2 = await orderOf('AC-PART2');
    ok(/short of AC-ABC \(1 of 2\)/.test(p2?.unprocessed_reason || ''),
       `the quantity shortfall reads honestly ("${p2?.unprocessed_reason}")`);
    const okOrd = await orderOf('AC-OK');
    ok(okOrd?.scan_status === 'pending', `AC-OK untouched through it all (${okOrd?.scan_status})`);
    const armedResp = await J('/api/master/orders/auto-cancel');
    ok((armedResp.armed || []).every(a => !/^AC-/.test(a.order)), 'nothing of the fixture left on any clock');
  }

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
  if (fails.length) process.exit(1);
})();
