// 15 Oct: BETIME - ECOM upload blocked — "NV-PROMO 2" (a real item-master SKU)
// under a no-space header was dropped as a label/summary row by the #63 gate.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mapRow, detectColumnMap } = require('../lib/keyfields.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
eval(grab('const _LABEL_WORDS', '// ── Location-code-shaped'));
eval(grab('function rescueOrderNumbers', '// Returns { unsupported }'));
const rows = (hdr, list) => { const recs = list.map(([on, sku]) => ({ 'Order No': on, [hdr]: sku, Qty: '1', Description: 'x' })); const det = detectColumnMap(recs); return recs.map(r => mapRow(r, det)); };
const keep = (rs, known) => rs.filter(r => r.sku && !isMetadataRow(r, known));

// (b) no-space headers are recognised SKU columns
for (const h of ['ItemCode', 'SKUCode', 'ProductCode', 'ItemNo', 'sku_code', 'SKU Code']) {
  const r = rows(h, [['261014KTCTXCQY', '7010']])[0];
  assert.strictEqual(r.sku, '7010', h); assert.strictEqual(r._skuSource, 'schema', h + ' is schema');
}
// NV-PROMO 2 under ItemCode is kept (no item master needed now the header is known)
assert.strictEqual(keep(rows('ItemCode', [['261014KTCTXCQY', 'NV-PROMO 2']])).length, 1);

// (a) AI-detected column: a spaced SKU is kept only when it's in the item master
const det = [{ c1: '261014KTCTXCQY', c2: 'NV-PROMO 2', c3: '1' }].map(r => ({ ...mapRow({}, {}), order_number: r.c1, sku: r.c2, _skuSource: 'detected' }));
assert.strictEqual(keep(det).length, 0, 'unknown spaced SKU still dropped');
assert.strictEqual(keep(det, new Set(['nv-promo 2'])).length, 1, 'item-master SKU kept');
assert.strictEqual(isMetadataRow({ ...det[0], sku: ' NV-Promo 2 ' }, new Set(['nv-promo 2'])), false, 'case-insensitive, trimmed');

// Summary labels are still dropped — detected or under a recognised header
const lbl = [['261014KTCTXCQY', 'Total Whole Qty'], ['261014KTCTXCQY', 'Grand Total Loose']];
assert.strictEqual(keep(rows('ItemCode', lbl), new Set(['nv-promo 2'])).length, 0, 'labels under ItemCode dropped');
assert.strictEqual(keep(rows('SKU', lbl)).length, 0, 'labels under SKU dropped');
assert.strictEqual(keep(lbl.map(([on, sku]) => ({ order_number: on, sku, _skuSource: 'detected' })), new Set(['nv-promo 2'])).length, 0);

// knownSkuSetFor is built once per upload and passed through every parser path
assert.match(src, /function knownSkuSetFor\(clientName\)/);
assert.ok((src.match(/isMetadataRow\(r, known\)/g) || []).length >= 4, 'all parse paths use the set');
assert.match(src, /parseUploadedFile\(orderFile\.buffer, orderFile\.originalname, \{ clientName: req\.body\?\.client_name \}\)/);
console.log('sku-with-space: ok');
