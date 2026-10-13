const assert = require('assert');
const n = require('../lib/portal-new-order');
const { buildDeliveryOrderPdf } = require('../lib/delivery-order');
// numbering: sanitised prefix, SGT day, per client per day, skips clashes, resets daily
const t = new Date('2026-10-13T17:30:00Z'); // 01:30 SGT on the 14th
assert.strictEqual(n.sgDay(t), '20261014');
assert.strictEqual(n.clientPrefix('Betime - E-Com (SG)'), 'BETIMEECOMSG');
const db = {};
assert.strictEqual(n.nextPortalOrderNumber(db, 'TEST', () => false, t), 'TEST-20261014-001');
const taken = new Set(['TEST-20261014-002']);
assert.strictEqual(n.nextPortalOrderNumber(db, 'TEST', x => taken.has(x), t), 'TEST-20261014-003');
assert.strictEqual(n.nextPortalOrderNumber(db, 'Other', () => false, t), 'OTHER-20261014-001');
assert.strictEqual(n.nextPortalOrderNumber(db, 'TEST', () => false, new Date('2026-10-14T17:00:00Z')), 'TEST-20261015-001');
// validation against the client's own item master
const items = new Map([['PKG-BOX-S', { sku: 'PKG-BOX-S', name: 'Box S' }], ['PKG-TAPE-48', { sku: 'PKG-TAPE-48', name: 'Tape' }]]);
let v = n.validateNewOrder({ ship_to_name: 'Test Store', address: '1 Test Rd', postal: '123456',
  lines: [{ sku: 'PKG-BOX-S', qty: 2 }, { sku: 'PKG-BOX-S', qty: 3 }, { sku: 'PKG-TAPE-48', qty: '1' }] }, items);
assert.deepStrictEqual(v.errors, []);
assert.deepStrictEqual(v.order.lines.map(l => [l.sku, l.qty]), [['PKG-BOX-S', 5], ['PKG-TAPE-48', 1]]);
v = n.validateNewOrder({ ship_to_name: '', address: '', postal: '12', lines: [{ sku: 'NOPE', qty: 1 }] }, items);
assert.ok(v.errors.length >= 4);
(async () => {
  const buf = await buildDeliveryOrderPdf({ order: { order_number: 'TEST-20261014-001', customer_name: 'Test Store', delivery_address: '1 Test Rd', postal_code: '123456',
    contact: 'Ann', delivery_date: '2026-10-15', remarks: 'Leave at loading bay', lines: v.order.lines.length ? v.order.lines : [{ sku: 'PKG-BOX-S', qty: 5 }] }, clientName: 'TEST' });
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  console.log('portal-new-order: ok');
})().catch(e => { console.error(e); process.exit(1); });
