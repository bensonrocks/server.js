// 12 Oct regression: an iWMS GoodsIssueAnalysis file whose ORDER NO. holds a
// store name ("Takashimaya Atrium") must not lose that order as "skipped".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { mapRow, detectColumnMap } = require('../lib/keyfields.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
eval(grab('const _LABEL_WORDS', '// ── Location-code-shaped'));
eval(grab('function rescueOrderNumbers', '// Returns { unsupported }'));
const ws = XLSX.readFile(path.join(__dirname, 'fixtures', 'gi-analysis-store-name-order-no.xlsx')).Sheets.GIanalysis;
const recs = XLSX.utils.sheet_to_json(ws, { range: 4, defval: '' });
const det = detectColumnMap ? detectColumnMap(recs) : {};
const before = recs.map(r => mapRow(r, det)).filter(r => r.sku && !isMetadataRow(r));
const all = rescueOrderNumbers(recs.map(r => mapRow(r, det)));
const after = all.filter(r => r.sku && !isMetadataRow(r));
assert.ok(before.length < recs.length, 'fixture reproduces the skip');
assert.strictEqual(after.length, recs.length, 'no rows skipped after rescue');
assert.ok(after.some(r => r.order_number === 'GI-149584' && r.customer_name === 'Takashimaya Atrium'));
assert.strictEqual(collectSkipped(all, after, 1).length, 0);
console.log('upload-skipped-rows-rescue: ok');
