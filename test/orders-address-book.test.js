// Address book → orders: B2B/GI orders (no waybill) resolve their ship-to name
// or code in the same book Transport uses; blank fields only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
eval(grab('function _abNorm', '// Fuzzy similarity'));
eval(grab('function applyAddressBookToOrders', '// Every uploaded picking-list order ALSO'));
const db = { addressBook: [
  { code: 'BDM (173)', name: 'BEDOK MALL', chain: 'Watsons', address: '311 New Upper Changi Rd', zip: '467360', phone: '61234567' },
  { code: 'BETIME HQ', name: 'Betime HQ', address: '8 Sinaran Dr', zip: '307470', phone: '' },
] };
const orders = [
  { order_number: 'A', customer_name: 'bdm (173)', delivery_address: '', tel: '' },              // code, case-insensitive
  { order_number: 'B', customer_name: 'Watsons Bedok Mall', delivery_address: 'KEEP ME', tel: '' }, // chain+name; never overwrite
  { order_number: 'C', customer_name: 'Nowhere Store' },                                          // no match
  { order_number: 'D', customer_name: 'Betime HQ', waybill_number: 'SPX123' },                    // courier parcel skipped
  { order_number: 'E', customer_name: '', ship_to_code: 'BETIME HQ' },                            // code only
];
const r = applyAddressBookToOrders(db, orders);
assert.strictEqual(orders[0].delivery_address, '311 New Upper Changi Rd');
assert.strictEqual(orders[0].postal_code, '467360');
assert.strictEqual(orders[0].tel, '61234567');
assert.strictEqual(orders[1].delivery_address, 'KEEP ME');
assert.strictEqual(orders[1].postal_code, '467360');
assert.strictEqual(orders[2].delivery_address, undefined);
assert.strictEqual(orders[3].postal_code, undefined);
assert.strictEqual(orders[4].postal_code, '307470');
assert.deepStrictEqual(r.map(x => [x.order, x.matched]), [['A', true], ['B', true], ['C', false], ['E', true]]);
console.log('orders-address-book: ok');
