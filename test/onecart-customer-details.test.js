'use strict';
// Fake, redacted values only — no real customer data.
const test = require('node:test');
const assert = require('node:assert');
const oc = require('../lib/onecart');
const search = require('../lib/orders-search');

test('delivery_orders recipient fields map to customer_name / address+postcode / tel, shop details kept', () => {
  const m = oc.mapDeliveryOrder({ id: 1, order_no: 'A1', platform: 'Shopee', shop_id: 9, shop_name: 'Fake Shop', first_name: 'Jane', last_name: 'Doe',
    shipping_address: '1 Test Road #01-01', shipping_postal_code: '000001', shipping_phone_number: '+6500000000', status: 'READY_TO_SHIP',
    line_items: [{ sku: 'S1', quantity: 1 }] }, { company_name: 'Fake Co' });
  assert.strictEqual(m.rows[0].customer_name, 'Jane Doe');
  assert.strictEqual(m.rows[0].delivery_address, '1 Test Road #01-01 000001');
  assert.strictEqual(m.rows[0].tel, '+6500000000');
  assert.deepStrictEqual(m.meta.merchant, { shop_id: '9', shop_name: 'Fake Shop', platform: 'Shopee', company_name: 'Fake Co' });
});

test('sparse Shopify-like row: "Singapore" is not an address; raw_data supplies name/address/phone and #SK alias', () => {
  const d = { id: 2, order_no: '100000000001', platform: 'Shopify', shipping_address: 'Singapore', line_items: [{ sku: 'S1', quantity: 1 }],
    raw_data: { name: '#SK0001', shipping_address: { name: 'Test Person', address1: '2 Fake St', address2: 'Unit 3', city: 'Singapore', zip: '000002', phone: '+6511111111' } } };
  const m = oc.mapDeliveryOrder(d);
  assert.strictEqual(m.rows[0].customer_name, 'Test Person');
  assert.strictEqual(m.rows[0].delivery_address, '2 Fake St, Unit 3 000002');
  assert.strictEqual(m.rows[0].tel, '+6511111111');
  assert.strictEqual(m.meta.channel_order_name, '#SK0001');
  assert.strictEqual(m.rows[0].po_number, '#SK0001');
});

test('no recipient anywhere → blanks, not "Singapore"', () => {
  const m = oc.mapDeliveryOrder({ id: 3, order_no: 'X', shipping_address: 'Singapore', line_items: [{ sku: 'S', quantity: 1 }] });
  assert.strictEqual(m.rows[0].delivery_address, '');
  assert.strictEqual(m.meta.channel_order_name, '');
});

test('search finds the channel alias with and without #', () => {
  const db = { batches: [{ client_name: 'C', idealscan_code: 'IS-1', orders: [{ order_number: '100000000001', channel_order_name: '#SK0001', po_number: '#SK0001', lines: [] }] }] };
  assert.deepStrictEqual(search.findMatchingOrderNumbers(db, 'SK0001'), ['100000000001']);
  assert.deepStrictEqual(search.findMatchingOrderNumbers(db, '#SK0001'), ['100000000001']);
});
