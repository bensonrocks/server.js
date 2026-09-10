// JUDGED ON WHAT THE ORDER CAN ACTUALLY HAVE, AND CHECKED THE MOMENT IT LANDS.
// The decisive case is TWO orders for ONE unit:
//   • the FIRST reserved it and must be left alone (green, no clock)
//   • the SECOND got nothing — physically the unit is on the shelf, but under
//     someone else's name — so it must read short and arm its clock
// Under the old on-hand rule BOTH read "Stock OK" and neither was cancelled
// until the first one shipped, which is the reported overnight delay.
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4636';
const MK = '201432547E';
const phase = process.argv[2] || 'land';

(async () => {
  const login = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': login.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());
  const orderOf = async (n) => {
    const all = await J('/api/orders?range=all');
    return (Array.isArray(all) ? all : all.orders || []).find(o => o.order_number === n);
  };

  if (phase === 'land') {
    const pol = (await J('/api/master/orders/auto-cancel')).policy;
    ok(pol.minutes === 30 && pol.partialMinutes === 30,
       `both waits are 30 minutes (${pol.minutes}/${pol.partialMinutes})`);

    // ONE unit on the shelf for AV-SKU.
    await J('/api/inventory/import', { method: 'POST', body: JSON.stringify({ clientId: 'AvCo', items: [
      { sku: 'AV-SKU', name: 'Avail Test Widget', stock_qty: 1 },
    ] }) });

    // THE PULL LANDS TWO ORDERS, each wanting that one unit.
    const stores = await J('/api/master/zort/stores');
    const store = stores.find(s => s.clientName === 'AvCo');
    ok(!!store, `AvCo store connected (${store?.id})`);
    const r = await J(`/api/master/zort/stores/${store.id}/pull`, { method: 'POST' });
    const res = r.result || r;
    ok((res.created || 0) === 2, `both orders imported (${res.created})`);

    // THE FIRST ONE WON THE UNIT.
    const a = await orderOf('AV-FIRST');
    const bO = await orderOf('AV-SECOND');
    const freeOf = o => (o?.items || o?.lines || []).map(l => l.stock_free);
    ok(freeOf(a)[0] === 1, `the first order can have its unit (stock_free ${JSON.stringify(freeOf(a))})`);
    ok(freeOf(bO)[0] === 0, `the second can have NOTHING — the unit is spoken for (stock_free ${JSON.stringify(freeOf(bO))})`);
    ok(Number(freeOf(bO)[0]) !== Number((bO?.items || bO?.lines || [])[0]?.stock_onhand),
       'and that differs from raw on-hand — which is what the old rule read');

    // THE CLOCK ARMED AT LANDING, not at the next sweep — and only on the
    // second order.
    const armed = await J('/api/master/orders/auto-cancel');
    const byOrder = Object.fromEntries((armed.armed || []).map(x => [x.order, x]));
    ok(!!byOrder['AV-SECOND'], `the second order is on the clock the moment it landed (${JSON.stringify(byOrder['AV-SECOND'] || null)})`);
    ok(byOrder['AV-SECOND']?.minutesLeft <= 30, `with a 30-minute wait (${byOrder['AV-SECOND']?.minutesLeft} left)`);
    ok(!byOrder['AV-FIRST'], 'and the FIRST order is on no clock — it can be picked');
    ok((await orderOf('AV-FIRST'))?.scan_status === 'pending'
       && (await orderOf('AV-SECOND'))?.scan_status === 'pending', 'nothing is cancelled yet');
  }

  if (phase === 'after31') {
    const s = await J('/api/master/orders/auto-cancel-sweep', { method: 'POST', body: JSON.stringify({}) });
    const names = (s.cancelled || []).map(c => c.order);
    ok(names.includes('AV-SECOND'), `after 31 minutes the second order is cancelled (${names.join(', ') || 'none'})`);
    ok(!names.includes('AV-FIRST'), 'the first is NOT — it holds the unit');
    const bO = await orderOf('AV-SECOND');
    ok(bO?.scan_status === 'unprocessed' && /No stock/i.test(bO?.unprocessed_reason || ''),
       `cancelled with the no-stock reason ("${bO?.unprocessed_reason}")`);
    ok((await orderOf('AV-FIRST'))?.scan_status === 'pending', 'and the first is still live and pickable');
  }

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
