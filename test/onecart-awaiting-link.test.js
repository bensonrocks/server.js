'use strict';
const test = require('node:test');
const assert = require('node:assert');
const oc = require('../lib/onecart');

test('TikTok AWAITING_SHIPMENT / AWAITING_COLLECTION are not "shipped"; real shipped words still are', () => {
  for (const w of ['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'READY_TO_SHIP', 'unshipped', 'to_ship']) assert.strictEqual(oc.isShippedStatus(w), false, w);
  for (const w of ['shipped', 'SHIPPED', 'completed', 'delivered', 'IN_TRANSIT_shipped']) assert.strictEqual(oc.isShippedStatus(w), true, w);
});

test('order record row → delivery-shaped row maps lines (bundle parent kept as one line)', () => {
  const d = oc.orderRecordToDeliveryRow({ id: 1, order_no: 'T1', platform: 'TikTok', status: 'AWAITING_SHIPMENT', shop_id: 5, shop_name: 'Fake',
    order_items: [{ sku: 'SKU_A', qty: 2, unit_price: 1 }, { sku: 'BOX_PARENT', qty: 1 }] });
  const m = oc.mapDeliveryOrder(d);
  assert.deepStrictEqual(m.rows.map(r => [r.sku, r.qty]), [['SKU_A', 2], ['BOX_PARENT', 1]]);
  assert.strictEqual(m.meta.onecart_id, '1');
  assert.strictEqual(m.meta.status, 'AWAITING_SHIPMENT');
});

test('getAwaitingOrders asks /orders with the status filter + order_items', async () => {
  const seen = [];
  const orig = global.fetch;
  global.fetch = async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ data: [{ id: 9, order_no: 'T9', status: 'AWAITING_SHIPMENT' }], meta: { has_next_page: false } }), { status: 200 }); };
  try {
    const r = await oc.getAwaitingOrders({ apiKey: 'k', endpoint: 'https://example.test/api/v2' });
    assert.strictEqual(r.rows.length, 1);
    const u = new URL(seen[0]);
    assert.strictEqual(u.pathname, '/api/v2/orders');
    assert.strictEqual(u.searchParams.get('status'), 'AWAITING_SHIPMENT,AWAITING_COLLECTION');
    assert.match(u.searchParams.get('_fields'), /order_items/);
  } finally { global.fetch = orig; }
});

test('canLinkManualOrder: only work mode, same client, no existing OneCart/ZORT link, not a sync/reference copy', () => {
  const store = { id: 'S', clientName: 'FakeClient', mode: 'work' };
  const manual = { batch: { client_name: 'FakeClient', uploaded_by: 'intake' }, order: { order_number: 'X' } };
  assert.strictEqual(oc.canLinkManualOrder(manual, store), true);
  assert.strictEqual(oc.canLinkManualOrder(manual, { ...store, mode: 'reference' }), false);
  assert.strictEqual(oc.canLinkManualOrder(manual, { ...store, clientName: 'Other' }), false);
  assert.strictEqual(oc.canLinkManualOrder({ ...manual, order: { onecart_id: '1' } }, store), false);
  assert.strictEqual(oc.canLinkManualOrder({ ...manual, order: { zort_id: 'z', zort_store_id: 'q' } }, store), false);
  assert.strictEqual(oc.canLinkManualOrder({ ...manual, batch: { client_name: 'FakeClient', uploaded_by: 'onecart-sync' } }, store), false);
  assert.strictEqual(oc.canLinkManualOrder({ ...manual, batch: { client_name: 'FakeClient', reference_only: true } }, store), false);
});
