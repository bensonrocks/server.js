// resolveBinnedSku: bridge an order SKU to the stocked SKU via case OR barcode.
const path = '/home/user/server.js/lib/inventory-store.js';
const os = require('os'), fs = require('fs');
const DIR = fs.mkdtempSync(os.tmpdir() + '/rbs-');
process.env.DATA_DIR = DIR;
const inv = require(path);
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  await inv.init();
  const CID = 'MayerX';
  // Catalogue: the ORDER references a marketplace variant RCMMRC101XWEMY (barcode
  // 9557496056550); the stock is binned under the in-house SKU RC-MMRC101 which
  // shares the barcode. Plus a case-variant putaway of a fan.
  inv.upsert({ sku: 'RCMMRC101XWEMY', name: 'Mayer Rice Cooker (variant)', barcode: '9557496056550', clientId: CID });
  inv.upsert({ sku: 'RC-MMRC101',     name: 'Mayer 1.0L Rice Cooker',      barcode: '9557496056550', clientId: CID });
  inv.upsert({ sku: 'FS1610DRXXBKML', name: 'Mistral 16in DC Stand Fan BK', barcode: '8850000001', clientId: CID });

  // Bins.
  inv.createLocation('AA', '014', '003', 'C', 1000, 'dry');
  inv.createLocation('AA', '015', '002', 'A', 1000, 'dry');
  const locRice = 'AA-014-003-C', locFan = 'AA-015-002-A';

  // Place 20 of the IN-HOUSE rice cooker SKU (not the variant the order carries).
  inv.placeStock(CID, 'RC-MMRC101', locRice, 20);
  // Place a fan under a LOWERCASE spelling to exercise the case bridge.
  inv.placeStock(CID, 'fs1610drxxbkml', locFan, 15);

  // 1. Order carries the variant SKU + barcode; stock is under RC-MMRC101.
  ok(inv.resolveBinnedSku(CID, { sku: 'RCMMRC101XWEMY', barcode: '9557496056550' }) === 'RC-MMRC101',
     'variant SKU bridges via barcode to the in-house stocked SKU');
  // 2. Order carries the in-house SKU exactly -> itself.
  ok(inv.resolveBinnedSku(CID, { sku: 'RC-MMRC101' }) === 'RC-MMRC101',
     'exact stocked SKU returns itself');
  // 3. Case mismatch: order says FS1610DRXXBKML, stock binned under lowercase.
  ok(inv.resolveBinnedSku(CID, { sku: 'FS1610DRXXBKML', barcode: '8850000001' }) === 'fs1610drxxbkml',
     'case-mismatched SKU resolves to the exact stored (lowercase) spelling');
  // 4. Barcode alone, no SKU.
  ok(inv.resolveBinnedSku(CID, { barcode: '9557496056550' }) === 'RC-MMRC101',
     'barcode alone finds the stocked SKU');
  // 5. Nothing binned / unknown -> ''.
  ok(inv.resolveBinnedSku(CID, { sku: 'NOPE', barcode: '0000' }) === '',
     'no stock, no barcode match -> empty string');
  // 6. A SKU whose barcode has NO binned stock anywhere -> '' (honest miss).
  inv.upsert({ sku: 'GHOST', name: 'Ghost', barcode: '7777', clientId: CID });
  ok(inv.resolveBinnedSku(CID, { sku: 'GHOST', barcode: '7777' }) === '',
     'registered but never binned -> empty (no location can be conjured)');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
