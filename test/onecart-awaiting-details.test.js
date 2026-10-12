'use strict';
// Fake values only.
const test = require('node:test');
const assert = require('node:assert');
const oc = require('../lib/onecart');

const rec = { id: 7, order_no: 'T7', platform: 'TikTok', status: 'AWAITING_SHIPMENT', shop_id: 5, shop_name: 'Fake Shop', company_name: 'Fake Co',
  order_items: [{ sku: 'SKU_A', qty: 1 }] };

test('awaiting-path row stores shop details (incl company_name) and leaves customer blank', () => {
  const m = oc.mapDeliveryOrder(oc.orderRecordToDeliveryRow(rec));
  assert.deepStrictEqual(m.meta.merchant, { shop_id: '5', shop_name: 'Fake Shop', platform: 'TikTok', company_name: 'Fake Co' });
  const o = { order_number: 'T7', customer_name: '', delivery_address: '', tel: '' };
  oc.applyOnecartDetails(o, m.meta);
  assert.deepStrictEqual(o.onecart_merchant, m.meta.merchant);
  assert.strictEqual(o.customer_name, '');
});

test('later pull: same order now on /delivery_orders fills the blanks, keeps manual values', () => {
  const o = { order_number: 'T7', customer_name: '', delivery_address: 'Singapore', tel: '+6599999999', onecart_merchant: { shop_id: '5' } };
  oc.applyOnecartDetails(o, oc.mapDeliveryOrder(oc.orderRecordToDeliveryRow(rec)).meta);   // pull 1: awaiting only
  const q = { id: 7, order_no: 'T7', platform: 'TikTok', status: 'AWAITING_COLLECTION', shop_id: 5, shop_name: 'Fake Shop',
    first_name: 'Jane', last_name: 'Doe', shipping_address: '1 Test Road', shipping_postal_code: null, shipping_phone_number: '+6500000000',
    line_items: [{ sku: 'SKU_A', quantity: 1 }] };
  const r = oc.applyOnecartDetails(o, oc.mapDeliveryOrder(q).meta);                       // pull 2: queue row
  assert.ok(r.changed);
  assert.strictEqual(o.customer_name, 'Jane Doe');
  assert.strictEqual(o.delivery_address, '1 Test Road');
  assert.strictEqual(o.tel, '+6599999999');           // manual value kept
  assert.strictEqual(o.onecart_merchant.company_name, 'Fake Co');
  assert.strictEqual(oc.applyOnecartDetails(o, oc.mapDeliveryOrder(q).meta).changed, false);
});
