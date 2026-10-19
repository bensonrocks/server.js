// 19 Oct regression (GI-151078 / IS-261019-37): a Betime iWMS
// GoodsIssueAnalysis upload carried the customer PO (picking-list
// Reference 27050822, Watsons Toa Payoh) under "PONumber" — a header
// normalising to `ponumber`, which the po_number chain never matched.
// Every order in the 91-order batch landed with po_number='', so the
// carton label (server carton-slip `poNo: ord.po_number`, label PO row
// printed only when non-empty) had nothing to show. Same for the
// export's "External PO Number" and "ShipReference" columns.
const assert = require('assert');
const { mapRow } = require('../lib/keyfields.js');

const base = { Account: 'BETIME', GINo: 'GI-151078', 'ORDER NO.': 'TPY (090)', ShipToCode: 'TPY (090)', SKUCode: '7206', LHUQty: 6 };

let r = mapRow({ ...base, PONumber: '27050822' }, {});
assert.strictEqual(r.po_number, '27050822', 'PONumber lands as po_number');
assert.strictEqual(r.issue_no, 'GI-151078', 'GI still lands as issue_no');

r = mapRow({ ...base, 'External PO Number': '27050822' }, {});
assert.strictEqual(r.po_number, '27050822', 'External PO Number lands as po_number');

r = mapRow({ ...base, ShipReference: '27050822' }, {});
assert.strictEqual(r.po_number, '27050822', 'ShipReference lands as po_number');

r = mapRow({ ...base, 'Ship Reference': '27050822' }, {});
assert.strictEqual(r.po_number, '27050822', 'Ship Reference lands as po_number');

r = mapRow({ ...base, PONumber: '27050822', ShipReference: 'OTHER' }, {});
assert.strictEqual(r.po_number, '27050822', 'PONumber wins over ShipReference');

r = mapRow({ ...base, 'PO Number': 'PO-1' }, {});
assert.strictEqual(r.po_number, 'PO-1', 'existing PO Number mapping unchanged');

r = mapRow({ ...base }, {});
assert.strictEqual(r.po_number, '', 'blank PO stays blank — carton label PO row stays hidden, label unchanged');

console.log('gi-po-number-mapping: ok');
