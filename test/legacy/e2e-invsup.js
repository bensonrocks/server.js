// THE REPORTED SHAPE, on the Inventory tab's own uploader: a stock file that
// lists a SKU once PER LOCATION, uploaded as ⚛ REPLACE. The old per-SKU write
// took whichever row it saw LAST, so a SKU in three bins came out holding one
// bin's figure, and every SKU the sheet omitted stayed standing — which is how
// a 1,244-pc file landed on 661. After the fix the file IS the position.
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const B = 'http://localhost:4717', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  if (!l.token) { console.log('LOGIN FAILED'); process.exit(1); }
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const C = 'InvSupCo' + Date.now();

  const xlsx = rows => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sheet1');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  // The INVENTORY TAB route — the one the floor actually uses.
  const up = async (buf, name, extra = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    fd.append('clientId', C);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const r = await fetch(B + '/api/inventory/import-file', { method: 'POST', headers: H, body: fd });
    return { status: r.status, d: await r.json() };
  };
  const inv = async () => {
    const rows = await fetch(B + `/api/inventory?clientId=${C}`, { headers: H }).then(r => r.json());
    const m = {}; for (const r of rows) m[r.sku] = {
      on: Number(r.stock_qty) || 0,
      bins: (r.bin_locations || []).map(b => `${b.location_id}×${b.qty}`).sort().join(','),
    };
    return m;
  };
  const total = async () => Object.values(await inv()).reduce((n, r) => n + r.on, 0);

  // ── Seed the position that is about to be superseded: 1,741 pcs.
  await up(xlsx([
    { SKU: 'AAA', Description: 'Alpha',  Location: 'AA-001-001-A', 'AVailable LHU': 1000 },
    { SKU: 'BBB', Description: 'Bravo',  Location: 'AA-002-001-A', 'AVailable LHU': 200 },
    { SKU: 'DDD', Description: 'Delta',  Location: 'AA-003-001-A', 'AVailable LHU': 541 },
  ]), 'seed.xlsx', { mode: 'add', confirm_apply: 'yes' });
  ok(await total() === 1741, 'seeded 1741 pcs on hand');

  // ── The real client shape. AAA is listed FOUR times: TWICE IN THE SAME BIN
  //    (71 + 29 — two batches on one pallet, an ordinary way to write a stock
  //    sheet) and once each in two others, so AAA = 240. BBB once. CCC counted
  //    with NO Location at all. DDD is absent from the file entirely.
  //    The file's own sum is 1244 — which is what on hand must read afterwards.
  const sheet = xlsx([
    { 'S/No': 1, SKU: 'AAA', Description: 'Alpha', Location: 'AA-005-001-A', 'AVailable LHU': 71 },
    { 'S/No': 2, SKU: 'AAA', Description: 'Alpha', Location: 'AA-005-001-A', 'AVailable LHU': 29 },
    { 'S/No': 3, SKU: 'AAA', Description: 'Alpha', Location: 'AA-005-001-B', 'AVailable LHU': 80 },
    { 'S/No': 4, SKU: 'AAA', Description: 'Alpha', Location: 'AA-005-002-A', 'AVailable LHU': 60 },
    { 'S/No': 5, SKU: 'BBB', Description: 'Bravo', Location: 'AA-002-001-A', 'AVailable LHU': 500 },
    { 'S/No': 6, SKU: 'CCC', Description: 'Charlie', Location: '',           'AVailable LHU': 504 },
  ]);

  // ── It asks first, and the arithmetic it states is the file's own sum.
  let { status, d } = await up(sheet, 'INVENTORY MAYER 01-09-26 PM.xlsx', { mode: 'set' });
  ok(status === 409 && d.needsApplyConfirm, 'REPLACE asks before it writes');
  const p = d.preview || {};
  console.log('  PREVIEW:', JSON.stringify({ rows: p.rows, units: p.units, currentTotal: p.currentTotal, afterTotal: p.afterTotal,
    zeroSkus: p.zeroSkus, unbinnedRows: p.unbinnedRows, unbinnedUnits: p.unbinnedUnits, newSkus: p.newSkus }));
  ok(p.currentTotal === 1741, 'states ON HAND NOW = 1741');
  ok(p.afterTotal === 1244, '★ states AFTER = 1244 — the file\'s own sum, not a per-SKU overwrite');
  ok(p.units === 1244, 'the file reads as 1244 pcs');
  ok((p.zeroSkus || []).some(x => x.sku === 'DDD' && x.was === 541), 'NAMES DDD (541 pc) as going to zero');
  ok(p.unbinnedRows === 1 && p.unbinnedUnits === 504, 'names the 504 pcs counted with no Location');
  ok(!p.untouchedSkus, 'nothing is described as "left as it is" any more');
  ok(await total() === 1741, 'nothing written by asking');

  // ── Apply.
  ({ status, d } = await up(sheet, 'INVENTORY MAYER 01-09-26 PM.xlsx', { mode: 'set', confirm_apply: 'yes' }));
  ok(status === 200, 'supersede applied');
  console.log('  RESULT:', JSON.stringify({ applied: d.applied, units: d.units, unitsMoved: d.unitsMoved,
    clientTotal: d.clientTotal, zeroed: d.zeroed, unbinned: d.unbinned }));
  const m = await inv();
  console.log('  AFTER:', JSON.stringify(m));

  ok(await total() === 1244, '★★ ON HAND == THE FILE\'S SUM (1244), exactly');
  ok(d.clientTotal === 1244, 'the screen is told 1244 (no reload needed to check it)');
  ok(m.AAA?.on === 240, 'AAA summed across ALL FOUR rows (71+29+80+60 = 240)');
  ok(m.AAA?.bins.includes('AA-005-001-A×100'),
     '★ the TWO rows naming the SAME bin SUM to 100 — they used to overwrite, losing 29');
  ok(m.AAA?.bins === 'AA-005-001-A×100,AA-005-001-B×80,AA-005-002-A×60', 'AAA sits in all three bins the file names');
  ok(m.BBB?.on === 500 && m.BBB?.bins === 'AA-002-001-A×500', 'BBB replaced 200 → 500 in its bin');
  ok(m.CCC?.on === 504 && !m.CCC?.bins, 'CCC counted (504) but NOT binned — the file gave no location');
  ok(m.DDD?.on === 0 && !m.DDD?.bins, 'DDD — absent from the file — zeroed and unbinned');
  ok((d.zeroed || []).some(x => x.sku === 'DDD'), 'the result names what it zeroed');
  ok((d.unbinned || []).some(x => x.sku === 'CCC' && x.qty === 504), 'the result names what it could not bin');
  ok(d.unitsMoved === -497, 'reports the real movement (1244 − 1741 = −497)');

  // ── Still undoable for 3 days, and the undo restores the WHOLE position.
  const list = (await fetch(B + '/api/putaway/imports?client=' + encodeURIComponent(C), { headers: H }).then(r => r.json())).rows || [];
  const mine = list.find(x => x.filename === 'INVENTORY MAYER 01-09-26 PM.xlsx' && !x.reversed_at);
  ok(!!mine && mine.reversible, 'listed on Recent stock uploads and reversible');
  ok(mine && mine.whole_position === true, 'recorded as a WHOLE-POSITION supersede');
  if (mine) {
    const rv = await fetch(B + `/api/putaway/imports/${mine.id}/reverse`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });
    ok(rv.ok, 'reversing accepted');
    const m2 = await inv();
    ok(await total() === 1741, 'undo restores the full 1741 — including DDD');
    ok(m2.AAA?.bins === 'AA-001-001-A×1000', 'AAA is back in its original bin');
  }

  // ── REGRESSION: ADD is untouched and still adds.
  ({ status, d } = await up(xlsx([{ SKU: 'AAA', Location: 'AA-001-001-A', 'AVailable LHU': 10 }]), 'add.xlsx',
                            { mode: 'add', confirm_apply: 'yes' }));
  ok(status === 200 && (await inv()).AAA.on === 1010, 'ADD still adds on top (1000 → 1010)');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
