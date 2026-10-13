// Approving a keyed-in portal order carries the New Order form fields onto the
// order, and the office/portal DO (_sendDo) prints them, including for orders
// approved before this change (read from the submission, nothing written).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const portalNewOrder = require('../lib/portal-new-order');
const { applyNewOrderFields } = portalNewOrder;
const realPdf = require('../lib/delivery-order');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
// The approve route must apply the form fields to the summarised orders.
const approve = grab("app.post('/api/client-submissions/:id/approve'", 'applyAddressBookToOrders(db, orders)');
assert.ok(/s0\.new_order[\s\S]*portalNewOrder\.applyNewOrderFields\(o, s0\.new_order\)/.test(approve), 'approve applies new_order fields');

const nf = { order_number: 'TEST-20261013-001', ship_to_name: 'Test Store', address: '1 Test Road #01-01', postal: '123456',
  phone: '60000000', contact: 'Ann Tan', delivery_date: '2026-10-15', remarks: 'Leave at loading bay' };
// "Approve": the order as summarizeOrders builds it from the generated file.
const approved = { order_number: 'TEST-20261013-001', customer_name: 'Test Store', delivery_address: 'From file', tel: '',
  lines: [{ sku: 'PKG-BOX-S', description: 'Box S', qty: 20 }] };
applyNewOrderFields(approved, nf);
assert.strictEqual(approved.delivery_date, '2026-10-15');
assert.strictEqual(approved.contact, 'Ann Tan');
assert.strictEqual(approved.remarks, 'Leave at loading bay');
assert.strictEqual(approved.tel, '60000000');
assert.strictEqual(approved.postal_code, '123456');
assert.strictEqual(approved.delivery_address, 'From file');   // never overwrites
assert.strictEqual(approved.keyed_in_portal, true);
assert.strictEqual(applyNewOrderFields({ order_number: 'OTHER' }, nf).contact, undefined); // wrong order untouched

// "DO": run the real _sendDo with the real PDF builder, capturing the order it prints.
let printed;
const buildDeliveryOrderPdf = async a => { printed = a.order; return realPdf.buildDeliveryOrderPdf(a); };
const doNumber = realPdf.doNumber;
const subs = [{ client_name: 'TEST', new_order: nf }];
const clientSubs = () => subs, readDb = () => ({});
const outletViewFor = (db, o) => o;   // outlet lookup off (tested in outlet-lookup.test.js)
eval(grab('async function _sendDo', "app.get('/api/orders/:orderNumber/do'"));
const res = () => ({ h: {}, setHeader(k, v) { this.h[k] = v; }, end(b) { this.body = b; } });
(async () => {
  const b = { client_name: 'TEST', idealscan_code: 'IS-1', orderStates: {} };
  let r = res(); await _sendDo(r, { b, o: approved });
  assert.strictEqual(r.body.slice(0, 5).toString(), '%PDF-');
  assert.deepStrictEqual([printed.delivery_date, printed.contact, printed.remarks], ['2026-10-15', 'Ann Tan', 'Leave at loading bay']);
  // Legacy order approved before the change: fields come from the submission.
  const legacy = { order_number: 'TEST-20261013-001', customer_name: 'Test Store', lines: approved.lines };
  r = res(); await _sendDo(r, { b, o: legacy });
  assert.deepStrictEqual([printed.delivery_date, printed.contact, printed.remarks], ['2026-10-15', 'Ann Tan', 'Leave at loading bay']);
  assert.strictEqual(legacy.contact, undefined);                // stored order not modified
  // Another client's submission is never used.
  r = res(); await _sendDo(r, { b: { ...b, client_name: 'OTHER' }, o: { ...legacy } });
  assert.strictEqual(printed.contact, undefined);
  console.log('approve-carries-new-order: ok');
})().catch(e => { console.error(e); process.exit(1); });
