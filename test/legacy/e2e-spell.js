// ONE SPELLING, end to end: the master is loaded first under "MayerX"; every
// later door typed as a case-variant must land on that same account and adopt
// that same spelling — never mint a second one.
const B = 'http://localhost:4665', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': l.token, 'x-master-key': MK };

  // 1. Onboarding order of events: the ITEM MASTER first, under "MayerX".
  await fetch(B + '/api/inventory/import', { method: 'POST', headers: H, body: JSON.stringify({ clientId: 'MayerX', items: [{ sku: 'SP-1', name: 'Spell Widget', barcode: '111222333', stock_qty: 4 }] }) });

  // 2. Stock upload typed ALL-CAPS -> must land on the SAME account.
  const csv = 'sku,name,qty,Location\nSP-1,Spell Widget,6,AA-020-001-A\n';
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'caps.csv');
  fd.append('clientId', 'MAYERX'); fd.append('mode', 'add');
  const up = await fetch(B + '/api/inventory/import-file', { method: 'POST', headers: { 'x-auth-token': l.token, 'x-master-key': MK }, body: fd }).then(r => r.json());
  ok(up.clientId === 'MayerX', `caps upload adopts the master's spelling (got ${up.clientId})`);

  // 3. Read back under three casings -> one account, 10 units, binned.
  for (const spell of ['MayerX', 'MAYERX', 'mayerx']) {
    const rows = await fetch(B + `/api/inventory?clientId=${spell}`, { headers: H }).then(r => r.json());
    const r0 = rows.find(x => x.sku === 'SP-1') || {};
    ok(r0.stock_qty === 10, `"${spell}" reads the ONE account (on-hand 10)`);
  }
  const rows = await fetch(B + '/api/inventory?clientId=mayerx', { headers: H }).then(r => r.json());
  ok((rows[0].bin_locations || []).some(b => b.location_id === 'AA-020-001-A' && b.qty === 6), 'location recorded on the one account');

  // 4. First ORDER arrives ALL-CAPS (the ZORT-attribution shape) -> the batch
  //    adopts the master's spelling instead of minting MAYERX.
  const ocsv = 'Order Number,SKU,Quantity\nSPELL-1,SP-1,1\n';
  const ofd = new FormData();
  ofd.append('orderFile', new Blob([ocsv], { type: 'text/csv' }), 'spell.csv');
  ofd.append('client_name', 'MAYERX'); ofd.append('arrange_delivery', 'no');
  const our = await fetch(B + '/api/upload', { method: 'POST', headers: { 'x-auth-token': l.token, 'x-master-key': MK }, body: ofd });
  ok(our.ok, 'order upload accepted');
  const orders = await fetch(B + '/api/orders?range=all', { headers: H }).then(r => r.json());
  const o = (Array.isArray(orders) ? orders : orders.orders || []).find(x => x.order_number === 'SPELL-1') || {};
  ok(o.client === 'MayerX' || o.client_name === 'MayerX', `batch adopted "MayerX" (got ${o.client || o.client_name})`);
  const line = (o.items || o.lines || []).find(x => x.sku === 'SP-1') || {};
  ok((line.pick_locations || []).some(p => p.location_id === 'AA-020-001-A'), 'and its pick list carries the location');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
