// Split Lazada orders: re-fetching a two-parcel label PDF must keep BOTH boxes
// (live 174179133225806 ended up with LZSGD…382 twice and …651 lost), and a
// misread page of a fetched-for-order PDF is attached as the next parcel only
// when the postcode agrees (live 174163589942399, page 2 …443).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
eval(grab('function labelPagesOf(ref)', '// Attach one page to an order.'));
eval(grab('const _BAD_LABEL_KEY', '// Remove one page from an order'));
const referenceOnlyOrder = () => null;
const findBatchForOrder = () => null;   // no batches here: the waybill fill-if-blank finds no order and writes nothing

const db = { orderLabels: {} };
const N = '174179133225806';
const page = (imp, i, t) => ({ importId: imp, pageIndex: i, pageFile: `page_${i + 1}.pdf`, tracking: t });
// 11 Oct: first fetch — two pages, two boxes
assert.strictEqual(attachLabelPage(db, N, page('A', 0, 'LZSGD1015698651')), 'primary');
assert.strictEqual(attachLabelPage(db, N, page('A', 1, 'LZSGD1015698382')), 'parcel');
// 12 Oct: the same PDF fetched again
attachLabelPage(db, N, page('B', 0, 'LZSGD1015698651'));
attachLabelPage(db, N, page('B', 1, 'LZSGD1015698382'));
const held = labelPagesOf(db.orderLabels[N]).map(p => p.tracking).sort();
assert.deepStrictEqual(held, ['LZSGD1015698382', 'LZSGD1015698651'], 'both boxes held after a re-fetch');
assert.ok(labelPagesOf(db.orderLabels[N]).every(p => p.importId === 'B'), 'each box now points at the newest print');
// a plain correction of a single-label order still replaces the primary
const db2 = { orderLabels: {} };
attachLabelPage(db2, 'X', page('A', 0, 'T1'));
assert.strictEqual(attachLabelPage(db2, 'X', page('B', 0, 'T1')), 'replaced');
assert.strictEqual(db2.orderLabels.X.importId, 'B');

// the multi-page fetched-for-order rule is guarded by every check named in it
const block = grab('// A MULTI-PAGE PDF FETCHED FOR ONE ORDER', 'const importRecord = {');
for (const must of ['numPages > 1', "p.matchedOrderNumber === forTarget", "pg.matchStatus !== 'unmatched'",
                    "extracted?.postalCode", 'elsewhere', 'isAnotherParcel(db.orderLabels[forTarget], tr)']) {
  assert.ok(block.includes(must), 'guard: ' + must);
}
console.log('multi-awb-reimport: ok');
