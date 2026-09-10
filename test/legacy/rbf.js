// resolveBinnedFor: the pick-list bridge must fold CLIENT case as well as SKU
// case and barcode — the live shape: bins under "Mayer2026", wave batch says
// "MAYER2026". And it must never bridge two genuinely different client names.
const path = '/home/user/server.js/lib/inventory-store.js';
const os = require('os'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/rbf-');
const inv = require(path);
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  await inv.init();
  // Stock recorded under "Mayer2026" (the Inventory screen's spelling).
  inv.upsert({ sku: 'FS1610DRXXBKML', name: 'Stand Fan 16in BK', barcode: '8850000001', clientId: 'Mayer2026' });
  inv.upsert({ sku: 'RCMMRC101XWEMY', name: 'Rice Cooker variant', barcode: '9557496056550', clientId: 'Mayer2026' });
  inv.upsert({ sku: 'RC-MMRC101', name: 'Rice Cooker 1L', barcode: '9557496056550', clientId: 'Mayer2026' });
  inv.createLocation('AA', '014', '003', 'C', 1000, 'dry');
  inv.createLocation('AA', '015', '002', 'A', 1000, 'dry');
  inv.placeStock('Mayer2026', 'FS1610DRXXBKML', 'AA-014-003-C', 30);
  inv.placeStock('Mayer2026', 'RC-MMRC101', 'AA-015-002-A', 7);
  // An unrelated client whose stock must NEVER be offered.
  inv.upsert({ sku: 'FS1610DRXXBKML', name: 'Other guy fan', barcode: '8850000001', clientId: 'BetimeCo' });
  inv.createLocation('BB', '001', '001', 'A', 1000, 'dry');
  inv.placeStock('BetimeCo', 'FS1610DRXXBKML', 'BB-001-001-A', 99);

  // 1. THE LIVE SHAPE: wave asks as "MAYER2026" (batch casing), stock under "Mayer2026".
  let r = inv.resolveBinnedFor('MAYER2026', { sku: 'FS1610DRXXBKML' });
  ok(r && r.client_id === 'Mayer2026' && r.sku === 'FS1610DRXXBKML', 'client case-variant bridges to the recorded bins (MAYER2026 -> Mayer2026)');
  // 2. Exact client still wins the fast path.
  r = inv.resolveBinnedFor('Mayer2026', { sku: 'FS1610DRXXBKML' });
  ok(r && r.client_id === 'Mayer2026', 'exact client unchanged');
  // 3. Client case + SKU case together.
  r = inv.resolveBinnedFor('MAYER2026', { sku: 'fs1610drxxbkml' });
  ok(r && r.sku === 'FS1610DRXXBKML', 'client case + SKU case both folded, stored spellings returned');
  // 4. Client case + barcode bridge (variant SKU, stock under the in-house SKU).
  r = inv.resolveBinnedFor('MAYER2026', { sku: 'RCMMRC101XWEMY', barcode: '9557496056550' });
  ok(r && r.client_id === 'Mayer2026' && r.sku === 'RC-MMRC101', 'client case + barcode bridges variant SKU to the binned in-house SKU');
  // 5. A DIFFERENT client name never bridges — BetimeCo's 99 units are not Mayer's.
  r = inv.resolveBinnedFor('MAYER2026', { sku: 'NOPE-SKU', barcode: 'no-such-bc' });
  ok(r === null, 'nothing binned for this client -> null (never another client\'s stock)');
  // 6. And the allocator agrees end to end: allocate with the resolved ref.
  r = inv.resolveBinnedFor('MAYER2026', { sku: 'FS1610DRXXBKML' });
  const a = inv.allocatePick(r.client_id, r.sku, 5, 'fefo', 1, inv.newPickClaim());
  ok(a.picks.length === 1 && a.picks[0].location_id === 'AA-014-003-C' && a.shortfall === 0, 'allocatePick on the resolved ref returns the real bin AA-014-003-C');
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
