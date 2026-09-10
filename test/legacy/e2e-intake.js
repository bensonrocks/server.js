// E2E — the ORDER pick list (intake allocation) bridges through the barcode:
// order carries the marketplace variant SKU; stock is binned under the
// in-house SKU sharing the barcode. Uploaded through the REAL /api/upload.
const B = 'http://localhost:4663', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const csv = 'Order Number,SKU,Quantity\nPICKE2E-2,RCMMRC101XWEMY,1\n';
  const fd = new FormData();
  fd.append("orderFile", new Blob([csv], { type: 'text/csv' }), 'picke2e.csv');
  fd.append('client_name', 'Mayer2026');
  fd.append('arrange_delivery', 'no');
  const up = await fetch(B + '/api/upload', { method: 'POST', headers: H, body: fd });
  const ud = await up.json().catch(() => ({}));
  if (!up.ok) { console.log('UPLOAD FAILED', up.status, JSON.stringify(ud).slice(0, 400)); process.exit(1); }
  ok(true, 'upload accepted (' + (ud.orders ?? ud.orderCount ?? '?') + ' orders)');
  const orders = await fetch(B + '/api/orders?range=all', { headers: H }).then(r => r.json());
  const o = (Array.isArray(orders) ? orders : orders.orders || []).find(x => x.order_number === 'PICKE2E-2');
  if (!o) { console.log('order not found in list'); process.exit(1); }
  const line = (o.items || o.lines || []).find(x => x.sku === 'RCMMRC101XWEMY') || {};
  console.log('line:', JSON.stringify({ sku: line.sku, resolved_sku: line.resolved_sku, pick_locations: line.pick_locations, shortfall: line.pick_shortfall }));
  ok((line.pick_locations || []).some(p => p.location_id === 'AA-015-002-A' && p.qty === 1), 'ORDER pick list points at the bin of the barcode-sharing in-house SKU');
  ok(line.resolved_sku === 'RC-MMRC101', 'line records which SKU the stock is under (resolved_sku)');
  ok(!line.pick_shortfall, 'no false shortfall');
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
