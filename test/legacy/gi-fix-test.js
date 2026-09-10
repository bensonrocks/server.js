// The GI fixes, against the REAL matchLabelPage + lib/label-extract.js.
// Every case that FAILED before the fix is asserted here, plus regressions on
// the Lazada/Shopee paths that must not have moved.
const { normStr, buildLabelMatchIndexFor, matchLabelPage } = require('./_fns.js');
const { extractLabelFields } = require('/home/user/server.js/lib/label-extract.js');

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const M = (text, idx) => { const h = matchLabelPage(text, extractLabelFields(text), idx); return h ? `${h.hit}|${h.method}` : null; };

// ── The GI shapes that were unmatchable ─────────────────────────────────────
const orders = [
  { order_number: 'GI-25001234', issue_no: '',           waybill_number: '', po_number: '' },
  { order_number: 'SO-1001',     issue_no: 'GI-9931',    waybill_number: '', po_number: '' },
  { order_number: 'SO-1002',     issue_no: '1300456',    waybill_number: '', po_number: '' },
  { order_number: 'SO-1003',     issue_no: '130045678',  waybill_number: '', po_number: '' },
  { order_number: 'SO-1004',     issue_no: '1300456789', waybill_number: '', po_number: '' },
];
const idx = buildLabelMatchIndexFor(orders);

console.log('\n=== The five GI shapes (4 of these could never match before) ===');
ok(M('GI No: GI-25001234\nTo: ACME', idx) === 'GI-25001234|gi_number', 'GI-25001234 (long, PDF path)');
ok(M('GI No: GI-9931\nTo: ACME',     idx) === 'SO-1001|gi_number',     'GI-9931 — 6 chars, BELOW the scan floor');
ok(M('Issue No: 1300456\nTo: ACME',  idx) === 'SO-1002|gi_number',     '7-digit issue no');
ok(M('Issue No: 130045678\nTo: ACME',idx) === 'SO-1003|gi_number',     '9-digit issue no');
ok(M('GI No: 1300456789\nTo: ACME',  idx) === 'SO-1004|gi_number',     '10-digit issue no (was scan, now exact)');
ok(M('iWMS GINo 1300456\nTo: ACME',  idx) === 'SO-1002|gi_number',     'iWMS GINo caption');
ok(M('GI 25001234\nTo: ACME',        idx) === 'GI-25001234|gi_number', 'GI printed with a space, not a hyphen');

console.log('\n=== The page\'s own GI now outranks a foreign tracking number ===');
const idxI = buildLabelMatchIndexFor([
  { order_number: 'ORD-OLD', issue_no: '',            waybill_number: 'SPXSG0412345678', po_number: '' },
  { order_number: 'ORD-NEW', issue_no: 'GI-33009981', waybill_number: '', po_number: '' },
]);
ok(M('GI No: GI-33009981\nPrev consignment SPXSG0412345678 returned\n', idxI) === 'ORD-NEW|gi_number',
   "reproduced case I: was ORD-OLD via tracking, now ORD-NEW via its own GI");

console.log('\n=== A printed DATE no longer outranks the page\'s own GI ===');
const idxH = buildLabelMatchIndexFor([
  { order_number: '20260716-H', issue_no: '',            waybill_number: '', po_number: '' },
  { order_number: 'ORD-Z',      issue_no: 'GI-4400221',  waybill_number: '', po_number: '' },
]);
ok(M('GI No: GI-4400221\nPrinted 2026-07-16 H shift\nTo: ACME', idxH) === 'ORD-Z|gi_number',
   'reproduced case H: was 20260716-H via the stripped date, now ORD-Z');
// SUPERSEDED — this used to assert the limitation ("a page with NO GI can
// still be claimed by a stripped date"). That hole is now closed: a scan match
// may not be glued together across a whitespace gap, so the date cannot become
// the order number. See no-wrong-order.js for the full suite.
ok(M('Printed 2026-07-16 H shift\nTo: ACME\nno other id', idxH) === null,
   'a page carrying ONLY that date no longer claims the order');

console.log('\n=== A GI that belongs to no order is not forced onto one ===');
ok(M('GI No: GI-99999999\nTo: ACME', idx) === null, 'unknown GI stays unmatched');

console.log('\n=== REGRESSION — the marketplace paths must not have moved ===');
const idxM = buildLabelMatchIndexFor([
  { order_number: '172429924275375', issue_no: '', waybill_number: 'LZSGD1015379600', po_number: '' },
  { order_number: 'SHP-1',           issue_no: '', waybill_number: '', po_number: '' },
]);
ok(M('Order No: 172429924275375\nLZSGD1015379600', idxM) === '172429924275375|order_number',
   'Lazada order number still matches on the fast path');
ok(M('Tracking LZSGD1015379600\nOrder No: 172428924275375', idxM) === '172429924275375|tracking_number',
   "your screenshot's page: still matches via tracking, unchanged");
const shopee = extractLabelFields('Order ID: 260726PNCVDSYK');
ok(shopee.orderNumber === '260726PNCVDSYK' && !shopee.giNumber, 'Shopee order id unchanged, no GI invented');
const laz = extractLabelFields('Order No: 1690123456789012\nTracking LZSGD1015379600');
ok(laz.orderNumber === '1690123456789012' && laz.trackingNumber === 'LZSGD1015379600' && !laz.giNumber,
   'Lazada extraction unchanged, no GI invented');

console.log('\n=== The GI pattern does not fire on ordinary label words ===');
for (const t of ['ORIGIN: SINGAPORE', 'GIFT WRAP INCLUDED', 'PACKAGING: BOX', 'REGION SG']) {
  ok(!extractLabelFields(t).giNumber, `no GI read from "${t}"`);
}

console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
process.exit(fails.length ? 1 : 0);
