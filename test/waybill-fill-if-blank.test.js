// Fill-if-blank waybill: attachLabelPage (primary/same only) and the admin
// set-waybill endpoint share fillWaybillIfBlank — never overwrite, never dup.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
eval(grab('function isReferenceBatch(b)', '\n'));
eval(grab('function findBatchForOrder(db, orderNumber)', '// The reference copy'));
eval(grab('function referenceOnlyOrder(db, orderNumber)', 'function workOrderForReference'));
eval(grab('function isCancelledOrderNo(db', 'function waybillFillBlocker'));
eval(grab('function labelPagesOf(ref)', '// Attach one page to an order.'));
eval(grab('const _BAD_LABEL_KEY', '// Remove one page from an order'));

const mk = () => ({ orderLabels: {}, auditLog: [], batches: [
  { id: 'b1', orders: [{ order_number: 'A', waybill_number: '' }, { order_number: 'B', waybill_number: 'HELD1' }, { order_number: 'C' }, { order_number: 'X' }], orderStates: { X: { status: 'unprocessed' } } },
  { id: 'r', reference_only: true, orders: [{ order_number: 'R', waybill_number: '' }] },
] });
const ord = (db, n) => db.batches.flatMap(b => b.orders).find(o => o.order_number === n);
const page = (imp, i, t) => ({ importId: imp, pageIndex: i, tracking: t });

// 1. primary page fills a blank waybill, audits label_waybill_filled
let db = mk();
assert.strictEqual(attachLabelPage(db, 'A', page('I', 0, 'T1')), 'primary');
assert.strictEqual(ord(db, 'A').waybill_number, 'T1');
assert.deepStrictEqual(db.auditLog.map(e => e.type), ['label_waybill_filled']);
// 'same' re-attach does not re-audit (no longer blank)
assert.strictEqual(attachLabelPage(db, 'A', page('I', 0, 'T1')), 'same');
assert.strictEqual(db.auditLog.length, 1);
// extra parcel never touches waybill
assert.strictEqual(attachLabelPage(db, 'A', page('I', 1, 'T2')), 'parcel');
assert.strictEqual(ord(db, 'A').waybill_number, 'T1');
assert.strictEqual(db.auditLog.length, 1);

// 2. existing waybill never overwritten
db = mk();
assert.strictEqual(attachLabelPage(db, 'B', page('I', 0, 'NEW')), 'primary');
assert.strictEqual(ord(db, 'B').waybill_number, 'HELD1');
assert.strictEqual(db.auditLog.length, 0);

// 3. duplicate tracking not filled
db = mk();
attachLabelPage(db, 'C', page('I', 0, 'held1'));
assert.ok(!ord(db, 'C').waybill_number);
assert.strictEqual(db.auditLog.length, 0);

// 4. reference copy and cancelled refused, nothing filled
db = mk();
assert.strictEqual(attachLabelPage(db, 'R', page('I', 0, 'T9')), 'reference');
assert.strictEqual(attachLabelPage(db, 'X', page('I', 0, 'T9')), 'cancelled');
assert.ok(!ord(db, 'R').waybill_number && !ord(db, 'X').waybill_number);

// 5. 'same' via a later fill when primary had no tracking
db = mk();
attachLabelPage(db, 'A', page('I', 0, ''));
assert.ok(!ord(db, 'A').waybill_number);
assert.strictEqual(attachLabelPage(db, 'A', page('I', 0, 'T5')), 'same');
assert.strictEqual(ord(db, 'A').waybill_number, 'T5');

// 6. manual fill (endpoint core)
db = mk();
let r = fillWaybillIfBlank(db, 'A', ' JT1 ', 'manual_waybill_set', { by: 'u1' });
assert.ok(r.ok); assert.strictEqual(ord(db, 'A').waybill_number, 'JT1');
assert.strictEqual(db.auditLog[0].type, 'manual_waybill_set'); assert.strictEqual(db.auditLog[0].by, 'u1');
assert.deepStrictEqual(Object.keys(ord(db, 'A')).sort(), ['order_number', 'waybill_number']);
assert.strictEqual(fillWaybillIfBlank(db, 'A', 'JT2', 'manual_waybill_set').code, 'not_blank');
assert.strictEqual(fillWaybillIfBlank(db, 'C', 'jt1', 'manual_waybill_set').code, 'duplicate');
assert.strictEqual(fillWaybillIfBlank(db, 'ZZ', 'JT3', 'manual_waybill_set').code, 'not_found');
assert.strictEqual(fillWaybillIfBlank(db, 'R', 'JT3', 'manual_waybill_set').code, 'reference');
assert.strictEqual(fillWaybillIfBlank(db, 'X', 'JT3', 'manual_waybill_set').code, 'cancelled');
assert.strictEqual(db.auditLog.length, 1);

// 7. endpoint is admin-gated and returns 409 on refusal
const ep = grab("app.post('/api/orders/:orderNumber/set-waybill'", "app.post('/api/orders/bulk-cancel'");
assert.ok(/role !== 'admin'\) return res.status\(403\)/.test(ep));
assert.ok(/: 409\)/.test(ep) && /'manual_waybill_set'/.test(ep));
console.log('waybill-fill-if-blank: ok');
