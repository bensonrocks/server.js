// binLocationsBySku: a SKU with binned stock lists its bins; one never put away
// (on-hand 0) returns []. Mirrors the live Mayer rice-cooker case exactly.
const path = '/home/user/server.js/lib/inventory-store.js';
const os = require('os'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/binloc-');
const inv = require(path);
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  await inv.init();
  const CID = 'MayerX';
  // A binned fan (stock in two bins) and the rice cooker registered but NEVER put away.
  inv.upsert({ sku: 'FS1610DRXXBKML', name: 'Fan', barcode: '8850000001', clientId: CID });
  inv.upsert({ sku: 'RCMMRC101XWEMY', name: 'Rice Cooker', barcode: '9557496056550', clientId: CID });
  inv.createLocation('AA', '014', '003', 'C', 1000, 'dry');
  inv.createLocation('AA', '015', '002', 'A', 1000, 'dry');
  inv.placeStock(CID, 'FS1610DRXXBKML', 'AA-014-003-C', 30);
  inv.placeStock(CID, 'FS1610DRXXBKML', 'AA-015-002-A', 5);
  // Rice cooker: nothing placed (on-hand 0, the live case).

  const m = inv.binLocationsBySku(CID);
  const fan = m.get('FS1610DRXXBKML') || [];
  ok(fan.length === 2, 'binned fan lists both bins');
  ok(fan[0].location_id === 'AA-014-003-C' && fan[0].qty === 30, 'biggest bin first (30)');
  ok(fan[1].qty === 5, 'second bin qty 5');
  ok(!m.has('RCMMRC101XWEMY'), 'un-binned rice cooker is NOT in the map (renders "not binned")');
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
