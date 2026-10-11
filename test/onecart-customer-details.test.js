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

test('applyOnecartDetails never overwrites non-blank manual values; fills blanks and "Singapore"', () => {
  const o = { customer_name: 'Manual Name', delivery_address: 'Singapore', tel: '', po_number: 'PO-MANUAL', onecart_merchant: { shop_name: 'Kept' } };
  const meta = { customer: { name: 'Jane Doe', address: '1 Test Road 000001', tel: '+6500000000' }, channel_order_name: '#SK0001',
    merchant: { shop_id: '9', shop_name: 'Other', platform: 'Shopify', company_name: 'Fake Co' } };
  const dry = oc.applyOnecartDetails({ ...o }, meta, { dryRun: true });
  assert.deepStrictEqual(dry.fields.sort(), ['channel_order_name', 'delivery_address', 'onecart_merchant', 'tel']);
  const r = oc.applyOnecartDetails(o, meta);
  assert.ok(r.changed);
  assert.strictEqual(o.customer_name, 'Manual Name');
  assert.strictEqual(o.po_number, 'PO-MANUAL');
  assert.strictEqual(o.delivery_address, '1 Test Road 000001');
  assert.strictEqual(o.tel, '+6500000000');
  assert.strictEqual(o.channel_order_name, '#SK0001');
  assert.deepStrictEqual(o.onecart_merchant, { shop_name: 'Kept', shop_id: '9', platform: 'Shopify', company_name: 'Fake Co' });
  assert.strictEqual(oc.applyOnecartDetails(o, meta).changed, false);
});

test('planDetailsBackfill: dry-run changes nothing, only own-store orders, bounded, reference stays reference', () => {
  const batches = [
    { reference_only: true, idealscan_code: 'IS-R', orders: [{ order_number: 'R1', onecart_id: '1', onecart_store_id: 'S', delivery_address: 'Singapore' }] },
    { idealscan_code: 'IS-M', orders: [{ order_number: 'M1', onecart_id: '2', onecart_store_id: 'OTHER' }] },
  ];
  const q = [{ id: 1, order_no: 'R1', first_name: 'Jane', shipping_address: '1 Test Rd', line_items: [] }, { id: 2, order_no: 'M1', first_name: 'X', line_items: [] }];
  const p = oc.planDetailsBackfill(batches, q, 'S');
  assert.strictEqual(p.wouldFill, 1); assert.strictEqual(p.reference, 1);
  assert.strictEqual(batches[0].orders[0].delivery_address, 'Singapore');
  assert.strictEqual(batches[0].reference_only, true);
  assert.strictEqual(oc.planDetailsBackfill(batches, q, 'S', { maxOrders: 0 }).examined <= 1, true);
  oc.planDetailsBackfill(batches, q, 'S', { dryRun: false });
  assert.strictEqual(batches[0].orders[0].customer_name, 'Jane');
  assert.strictEqual(batches[0].reference_only, true);
  assert.strictEqual(batches[1].orders[0].customer_name, undefined);
});
