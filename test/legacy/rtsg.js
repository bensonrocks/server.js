const B = 'http://localhost:4636', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': l.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());
  const st = (await J('/api/master/zort/stores')).find(s => s.clientName === 'RgCo');
  await J('/api/inventory/import', { method: 'POST', body: JSON.stringify({ clientId: 'RgCo', items: [{ sku: 'RG-SKU', name: 'RTS Gate Widget', stock_qty: 10 }] }) });
  await J(`/api/master/zort/stores/${st.id}/pull`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 2000));
  const r = await J(`/api/master/zort/stores/${st.id}/labels/retry`, { method: 'POST' });
  console.log('RESULT:', JSON.stringify({ asked: r.asked, attached: r.attached, orders: r.orders, waiting: (r.stillWaiting || []).map(x => x.order), notReady: (r.notReady || []).map(x => x.order), skippedStock: (r.skippedStock || []).map(x => x.order) }));
  ok((r.orders || []).includes('RG-RTS'), 'RTS+in-stock+has-label -> fetched & attached');
  ok((r.stillWaiting || []).some(x => x.order === 'RG-NOLBL'), 'RTS+in-stock but label empty -> waiting (asked, not skipped)');
  ok((r.notReady || []).some(x => x.order === 'RG-PEND' && /not Ready to Ship/i.test(x.why)), 'PENDING -> not-ready, no label chased');
  ok((r.skippedStock || []).some(x => x.order === 'RG-SHORT'), "short-stock -> skipped on stock even though RTS'd");
  ok(!(r.orders || []).includes('RG-PEND') && !(r.orders || []).includes('RG-SHORT'), 'neither skipped order chased');
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
})();
