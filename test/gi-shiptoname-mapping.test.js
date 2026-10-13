// 12 Oct regression: iWMS GoodsIssueAnalysis "ShipToName" (no spaces) must map
// to customer_name, so B2B carton labels print the delivery location.
const assert = require('assert');
const path = require('path');
const XLSX = require('xlsx');
const { mapRow, detectColumnMap } = require('../lib/keyfields.js');
const ws = XLSX.readFile(path.join(__dirname, 'fixtures', 'gi-analysis-store-name-order-no.xlsx')).Sheets.GIanalysis;
const recs = XLSX.utils.sheet_to_json(ws, { range: 4, defval: '' });
const det = detectColumnMap ? detectColumnMap(recs) : {};
const rows = recs.map(r => mapRow(r, det));
assert.ok(rows.length > 0);
for (const r of rows) assert.ok(String(r.customer_name).trim(), `row ${r.order_number} has a ship-to`);
assert.ok(rows.some(r => r.customer_name === 'Takashimaya Atrium'));
assert.ok(rows.some(r => /^WA001-|^GA-|BETIME/i.test(r.customer_name)));
// ShipToCode alone also lands
const only = mapRow({ 'ORDER NO.': 'X1', SKUCode: '5110', LHUQty: 1, ShipToCode: 'ST-9' }, {});
assert.strictEqual(only.customer_name, 'ST-9');
assert.strictEqual(only.ship_to_code, 'ST-9');
console.log('gi-shiptoname-mapping: ok');
