// End-to-end: "Upload stock file" WITH a Location column must set on-hand AND
// bin it — one upload, combined ledger — and the location must surface.
const B = 'http://localhost:4661', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  if (!l.token) { console.log('LOGIN FAILED', JSON.stringify(l)); process.exit(1); }
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const CID = 'UniCo';

  // A stock file with SKU / name / Available LHU / Location — the Mayer shape.
  const csv = 'sku,name,Available LHU,Location\nRICE-1,Rice Cooker 1L,7,AA-014-003-C\nFAN-2,Stand Fan 16in,12,AA-015-002-A\n';
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'mayer_stock.csv');
  fd.append('clientId', CID);
  fd.append('mode', 'add');
  const up = await fetch(B + '/api/inventory/import-file', { method: 'POST', headers: H, body: fd }).then(r => r.json());
  console.log('UPLOAD:', JSON.stringify({ applied: up.applied, locationsRecorded: up.locationsRecorded, locationUnits: up.locationUnits, binsCreated: up.binsCreated, note: up.locationNote }));
  ok(up.applied === 2, 'both SKUs applied to on-hand');
  ok(up.locationsRecorded === 2, 'both SKUs located in the SAME upload');
  ok(up.locationUnits === 19, '19 units binned (7 + 12)');

  // Read inventory back — on-hand set AND bin_locations present.
  const inv = await fetch(B + `/api/inventory?clientId=${CID}`, { headers: H }).then(r => r.json());
  const rice = inv.find(r => r.sku === 'RICE-1'); const fan = inv.find(r => r.sku === 'FAN-2');
  ok(rice && rice.stock_qty === 7, 'RICE-1 on-hand = 7 (Available LHU read as qty)');
  ok(rice && (rice.bin_locations || []).some(b => b.location_id === 'AA-014-003-C' && b.qty === 7), 'RICE-1 bin recorded AA-014-003-C ×7');
  ok(fan && fan.stock_qty === 12, 'FAN-2 on-hand = 12');
  ok(fan && (fan.bin_locations || []).some(b => b.location_id === 'AA-015-002-A' && b.qty === 12), 'FAN-2 bin recorded AA-015-002-A ×12');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
