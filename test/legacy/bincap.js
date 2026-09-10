// ONE LEDGER invariant: binned can never exceed on-hand. enforceBinCap +
// reconcileBinOverage + the adjust() hook.
const os = require('os'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/bincap-');
const inv = require('/home/user/server.js/lib/inventory-store.js');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  await inv.init();
  const C = 'CapCo';
  inv.upsert({ sku: 'AAA', name: 'Widget A', clientId: C, stock_qty: 20 });
  inv.createLocation('AA', '001', '001', 'A', 1000, 'dry');
  inv.createLocation('AA', '001', '001', 'B', 1000, 'dry');
  // Two lots: an OLD dated lot (12) and a NEWER undated lot (8).
  inv.placeStock(C, 'AAA', 'AA-001-001-A', 12, { expiry_date: '2027-01-01', received_at: '2026-01-01' });
  inv.placeStock(C, 'AAA', 'AA-001-001-B', 8);

  // 1. Consistent -> no-op.
  ok(inv.enforceBinCap(C, 'AAA') === null, 'binned == on-hand -> no-op');

  // 2. A write-off through adjust() trims bins automatically, NEWEST lot first.
  inv.adjust('AAA', C, -5, 'adjustment', 'damage write-off');
  ok(inv.get('AAA', C).stock_qty === 15, 'on-hand 20 -> 15');
  ok(inv.binnedQty(C, 'AAA') === 15, 'bins auto-capped at 15 by the adjust hook');
  const locs = inv.binLocationsBySku(C).get('AAA') || [];
  const binB = locs.find(l => l.location_id === 'AA-001-001-B');
  ok(binB && binB.qty === 3, 'newest lot trimmed first (8 -> 3), dated older lot untouched');
  ok(locs.find(l => l.location_id === 'AA-001-001-A').qty === 12, 'FEFO-dated lot survives whole');

  // 3. Staging (on-hand > binned) is legitimate and untouched.
  inv.upsert({ sku: 'BBB', name: 'Widget B', clientId: C, stock_qty: 10 });
  inv.placeStock(C, 'BBB', 'AA-001-001-A', 4);
  ok(inv.enforceBinCap(C, 'BBB') === null, 'on-hand > binned (staging) -> untouched');
  ok(inv.binnedQty(C, 'BBB') === 4, 'BBB bins intact');

  // 4. Manufactured overage (the historical divergence) -> boot sweep fixes it.
  //    Simulate by setting on-hand below binned directly via upsert.
  inv.upsert({ sku: 'AAA', name: 'Widget A', clientId: C, stock_qty: 9 });
  const sweep = inv.reconcileBinOverage();               // default: REPORT ONLY
  ok(sweep.found.some(f => f.sku === 'AAA' && f.over === 6), 'sweep REPORTS AAA over by 6');
  ok(sweep.fixed.length === 0 && inv.binnedQty(C, 'AAA') === 15, 'report-only: nothing trimmed (ambiguous at rest)');
  // 5. Explicit apply trims — the human-invoked reconcile.
  const applied = inv.reconcileBinOverage({ apply: true });
  ok(applied.fixed.some(f => f.sku === 'AAA' && f.units === 6), 'apply:true trims AAA 15 -> 9');
  ok(inv.binnedQty(C, 'AAA') === 9, 'AAA binned == on-hand after apply');
  ok(inv.reconcileBinOverage().found.length === 0, 'clean store: nothing found');
  // 6. Orphan lots for a SKU no longer in the master are REPORTED (on-hand 0).
  inv.upsert({ sku: 'GONE', name: 'Ghost', clientId: C, stock_qty: 5 });
  inv.placeStock(C, 'GONE', 'AA-001-001-B', 5);
  inv.remove('GONE', C);
  const s2 = inv.reconcileBinOverage();
  ok(s2.found.some(f => f.sku === 'GONE' && f.over === 5), 'orphan lots (SKU removed) reported by sweep');
  ok(inv.reconcileBinOverage({ apply: true }).fixed.some(f => f.sku === 'GONE'), 'apply clears the orphan lots');
  ok(inv.binnedQty(C, 'GONE') === 0, 'no phantom bins for a removed SKU after apply');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
