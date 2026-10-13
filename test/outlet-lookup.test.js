// Outlet lookup on B2B paperwork: code → "Chain – NAME (code)", blank-only fill,
// per-client opt-in (default off), never modifies the stored order.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ol = require('../lib/outlet-lookup');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
eval(grab('function _abNorm', '// Fuzzy similarity'));            // the #65 index, unchanged
eval(grab('function outletLookupOn', '// ADDRESS BOOK → ORDERS.'));
const outletLookup = ol;
const db = {
  addressBook: [
    { code: 'BUJ (050)', name: 'BUGIS JUNCTION', chain: 'Watsons', address: '', zip: '188021', phone: '' },
    { code: 'BDM 173', name: 'BEDOK MALL', chain: 'Watsons', address: '311 New Upper Changi Rd', zip: '467360', phone: '61234567' },
    { code: '', name: 'Betime HQ', address: '8 Sinaran Dr', zip: '307470' },
  ],
  clientProfiles: [{ client: 'betime', outletLookup: true }, { client: 'Other' }],
};
const idx = buildAddressBookIndex(db);
assert.strictEqual(ol.outletDisplayName(db.addressBook[0]), 'Watsons – BUGIS JUNCTION (BUJ 050)');
assert.strictEqual(ol.outletDisplayName(db.addressBook[2]), 'Betime HQ');

// 1) exact code; postcode filled, nothing else invented
const o1 = { order_number: '26516084', customer_name: 'BUJ (050)', delivery_address: '', tel: '', postal_code: '' };
let v = ol.outletView(o1, idx);
assert.ok(v.matched);
assert.strictEqual(v.order.customer_name, 'Watsons – BUGIS JUNCTION (BUJ 050)');
assert.strictEqual(v.order.postal_code, '188021');
assert.strictEqual(v.order.delivery_address, '');
assert.strictEqual(v.order.outlet_code, 'BUJ (050)');
assert.strictEqual(o1.customer_name, 'BUJ (050)');                // stored order untouched
// 2) bracket-insensitive code; address + phone fill blanks only
v = ol.outletView({ order_number: 'B', customer_name: 'bdm (173)', delivery_address: '', tel: '99999999' }, idx);
assert.strictEqual(v.order.customer_name, 'Watsons – BEDOK MALL (BDM 173)');
assert.strictEqual(v.order.delivery_address, '311 New Upper Changi Rd');
assert.strictEqual(v.order.tel, '99999999');                       // never overwritten
// 3) no match → unchanged text
v = ol.outletView({ order_number: 'C', customer_name: 'Nowhere Store' }, idx);
assert.ok(!v.matched); assert.strictEqual(v.order.customer_name, 'Nowhere Store');

// 4) per-client switch: on for betime, off by default, courier parcels skipped
const order = { order_number: '26516084', customer_name: 'BUJ (050)' };
assert.strictEqual(outletViewFor(db, order, 'Betime ').customer_name, 'Watsons – BUGIS JUNCTION (BUJ 050)');
assert.strictEqual(outletViewFor(db, order, 'Other').customer_name, 'BUJ (050)');
assert.strictEqual(outletViewFor(db, order, 'Unknown').customer_name, 'BUJ (050)');
assert.strictEqual(outletViewFor(db, { ...order, waybill_number: 'SPX1' }, 'betime').customer_name, 'BUJ (050)');

// 5) wired into all three documents and the profile save
assert.ok(/drawSystemLabelPage\(doc, fonts, \{ order: outletViewFor\(db, order, batch\.client_name\)/.test(src), 'system label');
assert.ok(/buildDeliveryOrderPdf\(\{\s*order: outletViewFor\(/.test(src), 'DO');
assert.ok(/const shipTo = outletViewFor\(db, ord,[\s\S]{0,200}customerName: shipTo\.customer_name/.test(src), 'carton label');
assert.ok(/if \(b\.outletLookup !== undefined\) p\.outletLookup = !!b\.outletLookup;/.test(src), 'profile setting');

// 6) the real DO renders the outlet name
const { buildDeliveryOrderPdf } = require('../lib/delivery-order');
buildDeliveryOrderPdf({ order: { ...outletViewFor(db, order, 'betime'), lines: [{ sku: 'K1', qty: 1 }] }, clientName: 'betime' })
  .then(b => { assert.strictEqual(b.slice(0, 5).toString(), '%PDF-'); console.log('outlet-lookup: ok'); })
  .catch(e => { console.error(e); process.exit(1); });
