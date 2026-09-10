// "Don't let this happen again" — every way a label could land on the WRONG
// order, against the REAL matcher.
const { normStr, buildLabelMatchIndexFor, matchLabelPage } = require('./_fns.js');
const { extractLabelFields } = require('/home/user/server.js/lib/label-extract.js');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const M = (t, i) => matchLabelPage(t, extractLabelFields(t), i);
const R = r => !r ? 'none' : r.ambiguous ? 'AMBIGUOUS:' + r.candidates.map(c => c.order).sort().join(',')
                                         : `${r.hit}|${r.method}|${r.confidence}`;

console.log('\n=== 1. A DATE that normalises into a recycled order number ===');
// This is the case I left OPEN last time and asserted as a known limit.
const d = buildLabelMatchIndexFor([
  { order_number: '20260716-H', issue_no: '', waybill_number: '', po_number: '' },
  { order_number: 'ORD-Z', issue_no: 'GI-4400221', waybill_number: '', po_number: '' },
]);
ok(R(M('GI No: GI-4400221\nPrinted 2026-07-16 H shift', d)) === 'ORD-Z|gi_number|exact',
   'the page with its own GI still goes to ORD-Z');
const dateOnly = M('Printed 2026-07-16 H shift\nTo: ACME\nno other id', d);
ok(!dateOnly || dateOnly.ambiguous || dateOnly.hit !== '20260716-H',
   `a page carrying ONLY that date no longer claims the order (${R(dateOnly)})`);

console.log('\n=== 2. A key sitting INSIDE a longer number ===');
const e = buildLabelMatchIndexFor([{ order_number: 'ORD-E', issue_no: '234567890123', waybill_number: '', po_number: '' }]);
ok(R(M('Consignment 1234567890123456\n', e)) === 'none',
   'a key embedded in a longer run is not a match');
ok(R(M('Ref: 234567890123\n', e)) === 'ORD-E|issue_no_scan|scan',
   'the same key on its own boundary still matches');

console.log('\n=== 3. THE PAGE NAMES TWO ORDERS — nothing is attached ===');
const t = buildLabelMatchIndexFor([
  { order_number: 'ORD-OLD', issue_no: '4412345678', waybill_number: '', po_number: '' },
  { order_number: 'ORD-TWO', issue_no: '4499999999', waybill_number: '', po_number: '' },
]);
const two = M('batched 4412345678 with 4499999999\n', t);
ok(two && two.ambiguous, `two candidates refuse rather than pick (${R(two)})`);
ok(two && two.candidates.length === 2 && two.candidates.every(c => c.order && c.via),
   'and both are NAMED with how each was found, for a human to settle');
ok(R(M('batched 4412345678 only\n', t)) === 'ORD-OLD|issue_no_scan|scan',
   'one candidate still matches, flagged as a scan guess');

console.log('\n=== 4. A CAPTIONED FIELD OUTRANKS THE SCAN, so evidence wins ===');
const c = buildLabelMatchIndexFor([
  { order_number: 'ORD-A', issue_no: '', waybill_number: 'LZSGD1015379600', po_number: '' },
  { order_number: 'ORD-B', issue_no: 'GI-77001234', waybill_number: '', po_number: '' },
]);
ok(R(M('GI No: GI-77001234\nold consignment LZSGD1015379600\n', c)) === 'ORD-B|gi_number|exact',
   'an exact GI beats a foreign tracking number on the same page, and is EXACT');

console.log('\n=== 5. CONFIDENCE IS REPORTED, so a guess is never a certainty ===');
ok(M('Tracking LZSGD1015379600\n', c).confidence === 'exact', 'a tracking number read off the label is exact');
// A PO number is not a shape extractLabelFields recognises, so it can only be
// found by the scan — which is exactly what "guess" is reserved for.
const p2 = buildLabelMatchIndexFor([{ order_number: 'ORD-P', issue_no: '', waybill_number: '', po_number: 'PO88123456' }]);
const g = M('customer ref PO88123456 printed loose\n', p2);
ok(g && g.hit === 'ORD-P' && g.confidence === 'scan',
   `a bare text hit is reported as a guess (${R(g)})`);
ok(M('PO No: PO88123456\n', p2).confidence === 'scan',
   'and it stays a guess even when captioned — the extractor reads no PO field, so nothing corroborates it');

console.log('\n=== 6. LEADING ZEROS — the miss I left open ===');
const z = buildLabelMatchIndexFor([{ order_number: 'ORD-Z0', issue_no: '0012345678', waybill_number: '', po_number: '' }]);
ok(R(M('GI No: 0012345678\n', z)).startsWith('ORD-Z0|'), 'the exact form matches');
const zl = M('GI No: 12345678\n', z);
ok(zl && zl.hit === 'ORD-Z0' && /leading_zero/.test(zl.method),
   `and the zero-stripped form now matches too, saying so (${R(zl)})`);

console.log('\n=== 7. REGRESSION — nothing that worked has stopped ===');
const reg = buildLabelMatchIndexFor([
  { order_number: '172429924275375', issue_no: '', waybill_number: 'LZSGD1015379600', po_number: '' },
  { order_number: 'GI-25001234', issue_no: '', waybill_number: '', po_number: '' },
  { order_number: 'SO-1001', issue_no: 'GI-9931', waybill_number: '', po_number: '' },
  { order_number: 'SO-1002', issue_no: '1300456', waybill_number: '', po_number: '' },
]);
ok(R(M('Tracking LZSGD1015379600\nOrder No: 172428924275375', reg)) === '172429924275375|tracking_number|exact',
   "the reported screenshot's page still matches via tracking");
ok(R(M('Order No: 172429924275375', reg)) === '172429924275375|order_number|exact', 'Lazada order number');
ok(R(M('GI No: GI-25001234\nTo: ACME', reg)) === 'GI-25001234|gi_number|exact', 'long GI');
ok(R(M('GI No: GI-9931\nTo: ACME', reg)) === 'SO-1001|gi_number|exact', 'short GI (below the scan floor)');
ok(R(M('Issue No: 1300456\nTo: ACME', reg)) === 'SO-1002|gi_number|exact', '7-digit issue no');
ok(R(M('GI No: GI-99999999\n', reg)) === 'none', 'an unknown GI still matches nothing');

console.log('\n=== 8. The scan still rescues an OCR page with no caption ===');
ok(R(M('LZSGD1015379600\nsome garbled ocr text\n', reg)).startsWith('172429924275375|'),
   'a bare tracking number in OCR text still finds its order');

console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
process.exit(fails.length ? 1 : 0);
