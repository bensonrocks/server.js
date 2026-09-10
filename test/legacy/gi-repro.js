// INVESTIGATION ONLY — no app code is modified. This exercises the REAL
// buildLabelMatchIndexFor / matchLabelPage (copied verbatim out of server.js)
// and the REAL lib/label-extract.js against GI-numbered labels.
const { normStr, buildLabelMatchIndexFor, matchLabelPage } = require('./_fns.js');
const { extractLabelFields } = require('/home/user/server.js/lib/label-extract.js');

const show = (t, v) => console.log(String(t).padEnd(58), v);

console.log('\n=== A. What extractLabelFields sees on a GI label ===');
const giLabelText = [
  'KEYFIELDS LOGISTICS',
  'DELIVERY ORDER',
  'GI No: GI-25001234',
  'Pick Ticket: PT-778812',
  'To: ACME Pte Ltd',
  '20 Tuas Ave, Singapore 639999',
  'No. of Items: 3',
].join('\n');
const f = extractLabelFields(giLabelText);
show('extracted.orderNumber', JSON.stringify(f.orderNumber));
show('extracted.trackingNumber', JSON.stringify(f.trackingNumber));

console.log('\n=== B. Index keys built for GI orders of different lengths ===');
const orders = [
  { order_number: 'GI-25001234', issue_no: '', waybill_number: '', po_number: '' },  // PDF path
  { order_number: 'SO-1001', issue_no: 'GI-9931', waybill_number: '', po_number: '' }, // short GI
  { order_number: 'SO-1002', issue_no: '1300456', waybill_number: '', po_number: '' }, // 7-digit GI
  { order_number: 'SO-1003', issue_no: '130045678', waybill_number: '', po_number: '' }, // 9-digit GI
  { order_number: 'SO-1004', issue_no: '1300456789', waybill_number: '', po_number: '' }, // 10-digit GI
];
const idx = buildLabelMatchIndexFor(orders);
show('byOrderNo keys', [...idx.byOrderNo.keys()].join(' | '));
show('scanKeys (text-scan eligible)', idx.scanKeys.map(k => k.key).join(' | '));
for (const o of orders) {
  const key = normStr(o.issue_no || o.order_number);
  const eligible = idx.scanKeys.some(k => k.key === key);
  show(`  ${o.order_number} GI="${o.issue_no || o.order_number}" -> norm ${key} (${key.length})`,
       eligible ? 'scannable' : 'NOT IN scanKeys');
}

console.log('\n=== C. Matching a real GI label page against that index ===');
const cases = [
  ['GI on the PDF-path order (11 chars)', 'GI No: GI-25001234\nTo: ACME'],
  ['short GI in issue_no (GI-9931)',      'GI No: GI-9931\nTo: ACME'],
  ['7-digit GI in issue_no',              'GI No: 1300456\nTo: ACME'],
  ['9-digit GI in issue_no',              'GI No: 130045678\nTo: ACME'],
  ['10-digit GI in issue_no',             'GI No: 1300456789\nTo: ACME'],
];
for (const [what, text] of cases) {
  const hit = matchLabelPage(text, extractLabelFields(text), idx);
  show('  ' + what, hit ? `MATCHED ${hit.hit} via ${hit.method}` : 'UNMATCHED');
}

console.log('\n=== D. Does a GI label ever match on the FAST path? ===');
const giOnly = 'GI-25001234';
show('normStr(GI-25001234)', normStr(giOnly));
show('byOrderNo has it', idx.byOrderNo.has(normStr(giOnly)));
show('but extractLabelFields finds orderNumber =', JSON.stringify(extractLabelFields('GI No: GI-25001234').orderNumber));
show('so matchLabelPage never queries byOrderNo with it', 'text-scan is the ONLY route');

console.log('\n=== E. Leading zeros ===');
const z = buildLabelMatchIndexFor([{ order_number: 'A1', issue_no: '0012345678', waybill_number: '', po_number: '' }]);
for (const printed of ['0012345678', '12345678']) {
  const t = `GI No: ${printed}\n`;
  const hit = matchLabelPage(t, extractLabelFields(t), z);
  show(`  label prints ${printed}`, hit ? `MATCHED ${hit.hit}` : 'UNMATCHED');
}

console.log('\n=== F. normStr strips spaces/hyphens across the WHOLE page ===');
const g = buildLabelMatchIndexFor([{ order_number: 'REAL-ORDER', issue_no: '1300456789', waybill_number: '', po_number: '' }]);
const spaced = 'Ref 1300 456 789';
const split  = 'Weight 1.30 kg\nQty 0456789 pcs';
show('  "Ref 1300 456 789" (spaces inside the number)',
     matchLabelPage(spaced, extractLabelFields(spaced), g) ? 'MATCHED' : 'UNMATCHED');
show('  unrelated fields that concatenate to the key',
     matchLabelPage(split, extractLabelFields(split), g) ? 'FALSE MATCH' : 'no match');

console.log('\n=== G. First page to claim an order keeps it ===');
const h = buildLabelMatchIndexFor([
  { order_number: 'ORD-A', issue_no: '1300456789', waybill_number: '', po_number: '' },
  { order_number: 'ORD-B', issue_no: '1300456780', waybill_number: '', po_number: '' },
]);
const pageForB_alsoMentionsA = 'Consignment 1300456780\nBatched with 1300456789';
const r = matchLabelPage(pageForB_alsoMentionsA, extractLabelFields(pageForB_alsoMentionsA), h);
show("  B's page also printing A's GI", r ? `${r.hit} via ${r.method}` : 'UNMATCHED');
show('  scanKeys order (longest first, ties = insertion)', h.scanKeys.map(k => `${k.key}->${k.orderNumber}`).join(' | '));
