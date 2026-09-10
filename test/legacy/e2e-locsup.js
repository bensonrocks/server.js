// Inventory -> "Upload stock file": locate_mode=supersede must MOVE a SKU that
// is already binned, leave quantities alone, leave un-named SKUs alone, and
// still be undoable for 3 days. Default (fill) must behave exactly as before.
const B = 'http://localhost:4717', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  if (!l.token) { console.log('LOGIN FAILED', JSON.stringify(l)); process.exit(1); }
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const C = 'MoveCo' + Date.now();
  const up = async (csv, name, locate_mode) => {
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), name);
    fd.append('clientId', C); fd.append('confirm_apply','yes');
    if (locate_mode) fd.append('locate_mode', locate_mode);
    return fetch(B + '/api/inventory/import-file', { method: 'POST', headers: H, body: fd }).then(r => r.json());
  };
  const snap = async () => {
    const rows = await fetch(B + `/api/inventory?clientId=${C}`, { headers: H }).then(r => r.json());
    const m = {}; for (const r of rows) m[r.sku] = { on: r.stock_qty, bins: (r.bin_locations || []).map(b => `${b.location_id}×${b.qty}`).sort().join(',') };
    return m;
  };

  // ---- 1. Seed: three SKUs, all binned, via the ordinary upload.
  let d = await up('sku,name,stock_qty,Location\nAAA,Widget A,10,AA-001-001-A\nBBB,Widget B,5,AA-001-001-B\nCCC,Widget C,7,AA-001-002-A\n', 'seed.csv');
  ok(d.locationsRecorded === 3, 'seed: 3 SKUs located');
  let s = await snap();
  ok(s.AAA?.on === 10 && s.AAA?.bins === 'AA-001-001-A×10', 'AAA seeded 10 @ AA-001-001-A');

  // ---- 2. DEFAULT (fill) is unchanged: a file naming a DIFFERENT bin for an
  //         already-binned SKU must NOT move it. This is the old behaviour and
  //         it has to stay the default.
  d = await up('sku,name,stock_qty,Location\nAAA,Widget A,0,AA-009-009-A\n', 'nomove.csv');
  s = await snap();
  ok(s.AAA?.bins === 'AA-001-001-A×10', 'DEFAULT (fill): already-binned AAA is NOT moved');
  ok(d.locateMode === 'fill', 'server reports locateMode=fill when not asked');

  // ---- 3. SUPERSEDE: the same file MOVES it.
  d = await up('sku,name,stock_qty,Location\nAAA,Widget A,0,AA-002-002-B\nBBB,Widget B,0,AA-002-002-B\n', 'move.csv', 'supersede');
  console.log('  RESULT:', JSON.stringify({ locateMode: d.locateMode, located: d.locationsRecorded, units: d.locationUnits, relocated: d.relocated, relocatedSkus: d.relocatedSkus, txn: !!d.txnId }));
  ok(d.locateMode === 'supersede', 'server reports locateMode=supersede');
  s = await snap();
  ok(s.AAA?.bins === 'AA-002-002-B×10', 'AAA MOVED to AA-002-002-B, old bin cleared');
  ok(s.BBB?.bins === 'AA-002-002-B×5', 'BBB moved into the same bin');
  ok(s.AAA?.on === 10 && s.BBB?.on === 5, 'QUANTITIES UNCHANGED by the move (10 and 5)');
  ok(s.CCC?.on === 7 && s.CCC?.bins === 'AA-001-002-A×7', 'CCC — not in the file — keeps its stock AND its bin');
  ok((d.relocatedSkus || []).some(x => x.sku === 'AAA' && (x.from || []).includes('AA-001-001-A')),
     'the move is NAMED with the bin it came off');
  ok(/SUPERSEDED/.test(d.locationNote || ''), 'the note says superseded, not "recorded"');

  // ---- 4. Still undoable for 3 days — the destructive bit is in the snapshot.
  const list = (await fetch(B + '/api/putaway/imports?client=' + encodeURIComponent(C), { headers: H }).then(r => r.json())).rows || [];
  const mine = list.find(x => x.filename === 'move.csv');
  ok(!!mine && mine.reversible, 'the relocation is listed and reversible');
  if (mine) {
    const rv = await fetch(B + `/api/putaway/imports/${mine.id}/reverse`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });
    const rd = await rv.json();
    ok(rv.ok, 'reversing accepted: ' + JSON.stringify(rd).slice(0, 140));
    s = await snap();
    ok(s.AAA?.bins === 'AA-001-001-A×10', 'undo put AAA back in AA-001-001-A');
    ok(s.BBB?.bins === 'AA-001-001-B×5', 'undo put BBB back in AA-001-001-B');
    ok(s.AAA?.on === 10 && s.BBB?.on === 5 && s.CCC?.on === 7, 'undo moved no quantity');
  }

  // ---- 5. A SKU not in the item master is reported, never created.
  d = await up('sku,name,stock_qty,Location\nAAA,Widget A,0,AA-003-003-A\n', 'ok.csv', 'supersede');
  s = await snap();
  ok(s.AAA?.bins === 'AA-003-003-A×10', 'a second supersede moves it again');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
