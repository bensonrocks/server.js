// The reported case: an order line's SKU differs from the SKU the stock is
// binned under, bridged only by the barcode. enrichWaveWithBins must resolve
// through the barcode and find the location; and the wave row must carry the
// barcode for the picklist.
const B = 'http://localhost:4636', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': l.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());
  const CID = 'WbinCo';

  // Item master: the REAL stocked product FS1610 with barcode 8850000001, and a
  // separate placeholder FS1605 (marketplace SKU) carrying the SAME barcode.
  await J('/api/inventory/import', { method: 'POST', body: JSON.stringify({ clientId: CID, items: [
    { sku: 'FS1610DRXXBKML', name: 'Mistral 16in DC Stand Fan BK', barcode: '8850000001', stock_qty: 50 },
  ] }) });
  // Place FS1610 into a bin.
  const put = await J('/api/putaway/import?apply=positions', { method: 'POST', body: JSON.stringify({}) }).catch(() => ({}));
  // Direct placeStock via the manual putaway route:
  const loc = await J('/api/inventory/locations', {}).catch(() => ({}));

  // Simplest: use the stock-position setter through the file-less path — place
  // 20 of FS1610 into AA-014-003-C.
  await J(`/api/inventory/${encodeURIComponent('FS1610DRXXBKML')}/place`, { method: 'POST',
    body: JSON.stringify({ clientId: CID, location: 'AA-014-003-C', qty: 20 }) }).catch(() => ({}));

  console.log('placed?', JSON.stringify(await J(`/api/inventory/bins?clientId=${CID}`).catch(() => ({}))).slice(0, 200));
  console.log('\n(this scratch test needs the place endpoint — see run output)');
})();
