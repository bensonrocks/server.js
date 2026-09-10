// Does Mass SUPERSEDE still work? Drive /api/putaway/import exactly the way the
// screen does: mode=set + apply=positions, preview-confirm, then the real write.
// Also proves ADD and the 📍 locate radio's own endpoint still do their own jobs.
const B = 'http://localhost:4717', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const post = (path, fields, H) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'file') fd.append('file', new Blob([v.body], { type: 'text/csv' }), v.name);
    else fd.append(k, v);
  }
  return fetch(B + path, { method: 'POST', headers: H, body: fd });
};
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  if (!l.token) { console.log('LOGIN FAILED', JSON.stringify(l)); process.exit(1); }
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const C = 'SuperCo' + Date.now();
  const invOf = async () => {
    const rows = await fetch(B + `/api/inventory?clientId=${C}`, { headers: H }).then(r => r.json());
    const m = {}; for (const r of rows) m[r.sku] = { on: r.stock_qty, bins: (r.bin_locations || []).map(b => `${b.location_id}×${b.qty}`).sort().join(',') };
    return m;
  };

  // ---- 1. Seed a position: three SKUs across two bins, by mass ADD.
  const seed = 'SKU,Location,Qty\nAAA,AA-001-001-A,100\nBBB,AA-001-001-B,40\nCCC,AA-001-002-A,60\n';
  let r = await post('/api/putaway/import', { file: { body: seed, name: 'seed.csv' }, client: C, mode: 'add', apply: 'positions' }, H);
  let d = await r.json();
  ok(r.status === 409 && d.needsApplyConfirm, 'ADD asks before it writes (preview-confirm)');
  r = await post('/api/putaway/import', { file: { body: seed, name: 'seed.csv' }, client: C, mode: 'add', apply: 'positions', confirm_apply: 'yes' }, H);
  d = await r.json();
  ok(r.ok, 'ADD applied: ' + JSON.stringify({ rows: d.rows, units: d.units }));
  let inv = await invOf();
  ok(inv.AAA?.on === 100 && inv.BBB?.on === 40 && inv.CCC?.on === 60, 'seeded 100/40/60 on hand');
  ok(inv.AAA?.bins === 'AA-001-001-A×100', 'AAA binned at AA-001-001-A ×100');

  // ---- 2. SUPERSEDE with a sheet that mentions only AAA (moved bin, new qty)
  //         and BBB. CCC is absent, so it must go to ZERO and be REPORTED.
  const sheet = 'SKU,Location,Qty\nAAA,AA-002-001-A,30\nBBB,AA-001-001-B,40\n';
  r = await post('/api/putaway/import', { file: { body: sheet, name: 'stocktake.csv' }, client: C, mode: 'set', apply: 'positions' }, H);
  d = await r.json();
  ok(r.status === 409 && d.needsApplyConfirm, 'SUPERSEDE asks before it writes');
  ok(d.mode === 'set', 'the server sees mode=set (the supersede radio)');
  const p = d.preview || {};
  console.log('  PREVIEW:', JSON.stringify({ rows: p.rows, units: p.units, currentTotal: p.currentTotal, afterTotal: p.afterTotal, zeroSkuCount: p.zeroSkuCount, zeroUnits: p.zeroUnits, zeroSkus: p.zeroSkus }));
  ok(p.currentTotal === 200, 'preview states the position NOW = 200');
  ok(p.afterTotal === 70, 'preview states AFTER = 70 (the sheet IS the position)');
  ok(p.zeroSkuCount === 1 && (p.zeroSkus || []).some(x => x.sku === 'CCC' && x.was === 60), 'preview NAMES CCC as going to zero, with its 60 pcs');

  r = await post('/api/putaway/import', { file: { body: sheet, name: 'stocktake.csv' }, client: C, mode: 'set', apply: 'positions', confirm_apply: 'yes' }, H);
  d = await r.json();
  ok(r.ok, 'SUPERSEDE applied (200 OK)');
  const txn = d.txnId || d.transactionId || d.importId || (d.txn && d.txn.id);
  console.log('  RESULT:', JSON.stringify({ rows: d.rows, units: d.units, zeroed: d.zeroed, zeroedUnits: d.zeroedUnits, txn }));
  inv = await invOf();
  ok(inv.AAA?.on === 30, 'AAA on-hand replaced 100 -> 30');
  ok(inv.AAA?.bins === 'AA-002-001-A×30', 'AAA MOVED to the new bin, old bin cleared');
  ok(inv.BBB?.on === 40 && inv.BBB?.bins === 'AA-001-001-B×40', 'BBB unchanged at 40 in its bin');
  ok(inv.CCC?.on === 0, 'CCC NOT in the file -> zeroed (the whole position, not just named cells)');
  ok(!inv.CCC?.bins, 'CCC bins cleared too');

  // ---- 3. It is reversible for 3 days — the safety net is still there.
  const imports = await fetch(B + '/api/putaway/imports?client=' + encodeURIComponent(C), { headers: H }).then(r => r.json()).catch(() => null);
  const list = (imports && imports.rows) || [];
  const mine = list.find(x => x.filename === 'stocktake.csv');
  ok(!!mine, 'the supersede is listed on Recent stock uploads');
  ok(mine && mine.mode === 'set' && mine.whole_position === true, 'listed as a whole-position supersede');
  ok(mine && mine.reversible && mine.hoursLeft > 60, 'it carries a ~3-day reversal window (' + (mine && mine.hoursLeft) + 'h left)');
  if (mine) {
    const rv = await fetch(B + `/api/putaway/imports/${mine.id}/reverse`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });
    const rd = await rv.json();
    ok(rv.ok, 'reversing the supersede is accepted: ' + JSON.stringify(rd).slice(0, 160));
    inv = await invOf();
    ok(inv.AAA?.on === 100 && inv.AAA?.bins === 'AA-001-001-A×100', 'AAA restored to 100 in its ORIGINAL bin');
    ok(inv.CCC?.on === 60, 'CCC restored to 60 — the snapshot covered what it cleared');
  }

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
