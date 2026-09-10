// locateExistingStock: stock uploaded as on-hand with NO bin (the "Stock OK,
// no location" case). Applying a SKU+Location sheet must bin the on-hand
// WITHOUT changing quantities, and never bin beyond on-hand.
const path = '/home/user/server.js/lib/inventory-store.js';
const os = require('os'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/locex-');
const inv = require(path);
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  await inv.init();
  const CID = 'MayerX';
  // Three SKUs loaded via a plain stock upload: on-hand set, NO bins.
  inv.upsert({ sku: 'AAA', name: 'Widget A', clientId: CID, stock_qty: 20 });
  inv.upsert({ sku: 'BBB', name: 'Widget B', clientId: CID, stock_qty: 5 });
  inv.upsert({ sku: 'CCC', name: 'Widget C', clientId: CID, stock_qty: 10 });
  // CCC is ALREADY binned (came through putaway) — must be left alone.
  inv.createLocation('AA', '014', '003', 'C', 100000, 'dry');
  inv.placeStock(CID, 'CCC', 'AA-014-003-C', 10);

  const before = { AAA: inv.get('AAA', CID).stock_qty, BBB: inv.get('BBB', CID).stock_qty, CCC: inv.get('CCC', CID).stock_qty };

  // The sheet: SKU + Location (+ qty). AAA split across two bins; BBB one bin;
  // CCC already binned; DDD not in the master; EEE sheet qty exceeds on-hand.
  inv.upsert({ sku: 'EEE', name: 'Widget E', clientId: CID, stock_qty: 3 });
  const rows = [
    { sku: 'AAA', location: 'AA-015-002-A', qty: 12 },
    { sku: 'AAA', location: 'AA-015-002-B', qty: 8 },
    { sku: 'BBB', location: 'AA-015-002-A', qty: 5 },
    { sku: 'CCC', location: 'AA-016-001-A', qty: 10 },   // already binned -> skip
    { sku: 'DDD', location: 'AA-015-002-A', qty: 4 },    // not in master -> report
    { sku: 'EEE', location: 'AA-015-002-C', qty: 99 },   // cap at on-hand 3
  ];
  const out = inv.locateExistingStock(CID, rows, { operator: 'tester' });

  // Quantities unchanged.
  ok(inv.get('AAA', CID).stock_qty === before.AAA, 'AAA on-hand unchanged (20)');
  ok(inv.get('BBB', CID).stock_qty === before.BBB, 'BBB on-hand unchanged (5)');
  ok(inv.get('CCC', CID).stock_qty === before.CCC, 'CCC on-hand unchanged (10)');
  ok(inv.get('EEE', CID).stock_qty === 3, 'EEE on-hand unchanged (3)');

  // AAA now binned 12+8=20 across two bins.
  ok(inv.binnedQty(CID, 'AAA') === 20, 'AAA fully binned (20 across 2 bins)');
  const aaaLocs = inv.binLocationsBySku(CID).get('AAA') || [];
  ok(aaaLocs.length === 2, 'AAA shows two bin locations');
  // BBB binned 5.
  ok(inv.binnedQty(CID, 'BBB') === 5, 'BBB binned 5');
  // CCC untouched at its original bin (still 10, not doubled).
  ok(inv.binnedQty(CID, 'CCC') === 10, 'CCC still 10 (not re-binned)');
  ok(out.alreadyLocated.includes('CCC'), 'CCC reported already-located');
  // DDD not created.
  ok(!inv.get('DDD', CID), 'DDD not created in master');
  ok(out.notInMaster.includes('DDD'), 'DDD reported not-in-master');
  // EEE capped at on-hand 3.
  ok(inv.binnedQty(CID, 'EEE') === 3, 'EEE capped at on-hand (3, not 99)');
  ok(out.overflow.some(o => o.sku === 'EEE'), 'EEE overflow reported');

  // Resolve for a wave: AAA now resolves to a binned location.
  ok(inv.resolveBinnedSku(CID, { sku: 'AAA' }) === 'AAA', 'AAA resolves to a stocked bin for the wave pick');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
