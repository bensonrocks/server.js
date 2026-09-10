// Mass SUPERSEDE with BRAND-NEW SKUs in the file: they must be CREATED, with
// their quantity, their location, and their description/barcode — not skipped.
// Built as a real XLSX in the client's own column shape (S/No, SKU, Packing,
// Description, Location, Barcode, AVailable LHU) so header matching is tested too.
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const B = 'http://localhost:4717', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const C = 'NewSkuCo' + Date.now();
  // Bins are GLOBAL to the warehouse, so a re-run would find last run's bins
  // already on the map and binsCreated would read 0. Own row code per run.
  const RB = 'Z' + String(Date.now()).slice(-2);

  const xlsx = rows => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sheet1');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  const putaway = async (buf, name, extra = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    fd.append('client', C);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const r = await fetch(B + '/api/putaway/import', { method: 'POST', headers: H, body: fd });
    return { status: r.status, d: await r.json() };
  };
  const inv = async () => {
    const rows = await fetch(B + `/api/inventory?clientId=${C}`, { headers: H }).then(r => r.json());
    const m = {}; for (const r of rows) m[r.sku] = {
      on: r.stock_qty, name: r.name, barcode: r.barcode,
      bins: (r.bin_locations || []).map(b => `${b.location_id}×${b.qty}`).sort().join(','),
    };
    return m;
  };
  const total = async () => Object.values(await inv()).reduce((n, r) => n + (Number(r.on) || 0), 0);

  // ---- Seed an EXISTING position: 2 SKUs, one of which the file will omit.
  await putaway(xlsx([
    { 'S/No': 1, SKU: 'OLD-KEEP',  Description: 'Old Kept',    Location: 'AA-001-001-A', 'AVailable LHU': 500 },
    { 'S/No': 2, SKU: 'OLD-GONE',  Description: 'Old Dropped', Location: 'AA-001-001-B', 'AVailable LHU': 300 },
  ]), 'seed.xlsx', { apply: 'positions', mode: 'add', confirm_apply: 'yes' });
  ok(await total() === 800, 'seeded 800 pcs across 2 SKUs');

  // ---- The real sheet: OLD-KEEP moved+recounted, plus TWO BRAND-NEW SKUs
  //      carrying qty, location, description and barcode. OLD-GONE is absent.
  const sheet = xlsx([
    { 'S/No': 1, SKU: 'OLD-KEEP', Packing: 'CTN', Description: 'Old Kept',      Location: 'AA-002-002-A', Barcode: '111', 'AVailable LHU': 400 },
    { 'S/No': 2, SKU: 'NEW-AAA',  Packing: 'CTN', Description: 'Brand New Alpha', Location: `${RB}-005-005-A`, Barcode: '9557496058448', 'AVailable LHU': 500 },
    { 'S/No': 3, SKU: 'NEW-BBB',  Packing: 'PC',  Description: 'Brand New Bravo', Location: `${RB}-005-005-B`, Barcode: '9557496099999', 'AVailable LHU': 336 },
  ]);

  // ---- The preview must NAME the new SKUs before anything is written.
  let { status, d } = await putaway(sheet, 'MAYER 1-09-26.xlsx', { apply: 'positions', mode: 'set' });
  ok(status === 409 && d.needsApplyConfirm, 'supersede asks first');
  const p = d.preview || {};
  console.log('  PREVIEW:', JSON.stringify({ rows: p.rows, units: p.units, currentTotal: p.currentTotal, afterTotal: p.afterTotal, newSkuCount: p.newSkuCount, newSkus: p.newSkus, newBinCount: p.newBinCount, zeroSkus: p.zeroSkus }));
  ok(p.units === 1236, 'preview reads all three quantities from "AVailable LHU" (1236)');
  ok(p.newSkuCount === 2 && (p.newSkus || []).includes('NEW-AAA') && (p.newSkus || []).includes('NEW-BBB'),
     'preview NAMES both brand-new SKUs as ones it will create');
  ok(p.afterTotal === 1236, 'preview states AFTER = 1236');
  ok((p.zeroSkus || []).some(x => x.sku === 'OLD-GONE'), 'preview names OLD-GONE as going to zero');
  ok(await total() === 800, 'nothing written by previewing');

  // ---- Apply.
  ({ status, d } = await putaway(sheet, 'MAYER 1-09-26.xlsx', { apply: 'positions', mode: 'set', confirm_apply: 'yes' }));
  ok(status === 200, 'supersede applied');
  console.log('  RESULT:', JSON.stringify({ rows: d.rows, units: d.units, skusCreated: d.skusCreated, binsCreated: d.binsCreated, zeroed: d.zeroed, zeroedUnits: d.zeroedUnits }));
  const m = await inv();

  // THE POINT OF THIS TEST — new SKUs are CREATED, with qty AND location.
  ok(!!m['NEW-AAA'], 'NEW-AAA was CREATED in the item master');
  ok(m['NEW-AAA']?.on === 500, 'NEW-AAA on hand = 500 (the sheet says so)');
  ok(m['NEW-AAA']?.bins === `${RB}-005-005-A×500`, `NEW-AAA BINNED at ${RB}-005-005-A ×500`);
  ok(m['NEW-AAA']?.name === 'Brand New Alpha', 'NEW-AAA took its DESCRIPTION from the sheet');
  ok(String(m['NEW-AAA']?.barcode) === '9557496058448', 'NEW-AAA took its BARCODE from the sheet');
  ok(!!m['NEW-BBB'] && m['NEW-BBB'].on === 336 && m['NEW-BBB'].bins === `${RB}-005-005-B×336`,
     `NEW-BBB created, 336 pcs, binned at ${RB}-005-005-B`);
  ok(d.skusCreated === 2, 'the response says 2 SKUs were created');
  ok(d.binsCreated >= 2, `bins that did not exist were created (${d.binsCreated})`);

  // …and the rest of the stock-take still holds.
  ok(m['OLD-KEEP']?.on === 400 && m['OLD-KEEP']?.bins === 'AA-002-002-A×400', 'OLD-KEEP recounted to 400 and MOVED');
  ok(m['OLD-GONE']?.on === 0 && !m['OLD-GONE']?.bins, 'OLD-GONE — absent from the file — zeroed and unbinned');
  ok(await total() === 1236, 'GRAND TOTAL is exactly 1236, the sum of the file');

  // ---- Reversible: the created SKUs go away again.
  const list = (await fetch(B + '/api/putaway/imports?client=' + encodeURIComponent(C), { headers: H }).then(r => r.json())).rows || [];
  const mine = list.find(x => x.filename === 'MAYER 1-09-26.xlsx' && !x.reversed_at);
  ok(!!mine && mine.reversible, 'the supersede is reversible for 3 days');
  if (mine) {
    const rv = await fetch(B + `/api/putaway/imports/${mine.id}/reverse`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });
    ok(rv.ok, 'reversing accepted');
    const m2 = await inv();
    ok(!m2['NEW-AAA'] && !m2['NEW-BBB'], 'the two CREATED SKUs are removed again by the undo');
    ok(await total() === 800, 'position restored to 800');
  }

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
