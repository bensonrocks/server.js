// INVESTIGATION ONLY — false-positive surface of the whole-page text scan.
const { normStr, buildLabelMatchIndexFor, matchLabelPage } = require('./_fns.js');
const { extractLabelFields } = require('/home/user/server.js/lib/label-extract.js');
const show = (t, v) => console.log(String(t).padEnd(60), v);
const M = (text, idx) => { const h = matchLabelPage(text, extractLabelFields(text), idx); return h ? `${h.hit} via ${h.method}` : 'no match'; };

console.log('\n=== H. Recycled date-letter order numbers vs a printed date ===');
// CLAUDE.md: "Clients RECYCLE order numbers (date-letter codes like 20260716-H)"
const idxH = buildLabelMatchIndexFor([
  { order_number: '20260716-H', issue_no: 'GI-3300112', waybill_number: '', po_number: '' },
  { order_number: 'THE-REAL-ONE', issue_no: 'GI-3300998', waybill_number: 'SPXSG041234567', po_number: '' },
]);
show('scanKeys', idxH.scanKeys.map(k => `${k.key}->${k.orderNumber}`).join(' | '));
const pageOfAnotherOrder = 'Ship date 2026-07-16 H\nTracking SPXSG041234567\nTo: Someone';
show('  a DIFFERENT order label printing that date', M(pageOfAnotherOrder, idxH));
show('  normStr of that page contains 20260716H',
     normStr(pageOfAnotherOrder).includes('20260716H'));

console.log('\n=== I. Longest-key-wins does not mean right-key-wins ===');
const idxI = buildLabelMatchIndexFor([
  { order_number: 'ORD-OLD', issue_no: '', waybill_number: 'SPXSG0412345678', po_number: '' }, // 15
  { order_number: 'ORD-NEW', issue_no: 'GI-33009981', waybill_number: '', po_number: '' },     // 10
]);
const p = 'GI No: GI-33009981\nPrev consignment SPXSG0412345678 returned\n';
show("  page whose GI is ORD-NEW but mentions ORD-OLD's waybill", M(p, idxI));

console.log('\n=== J. What a page needs before the FAST path can be used ===');
for (const [what, txt] of [
  ['Lazada-style order id',  'Order No: 1690123456789012'],
  ['Shopee-style order id',  'Order ID: 260726PNCVDSYK'],
  ['GI number',              'GI No: GI-33009981'],
  ['GI number, no prefix',   'Order No: GI-33009981'],
  ['Issue No caption',       'Issue No: 33009981'],
]) {
  const f = extractLabelFields(txt);
  show(`  ${what}`, `orderNumber=${JSON.stringify(f.orderNumber)} tracking=${JSON.stringify(f.trackingNumber)}`);
}

console.log('\n=== K. A GI read as a TRACKING number goes to the wrong map ===');
const idxK = buildLabelMatchIndexFor([{ order_number: 'ORD-X', issue_no: 'GI33009981', waybill_number: '', po_number: '' }]);
const tk = 'GI33009981\nTo: ACME';
show('  extract sees', JSON.stringify(extractLabelFields(tk)));
show('  byWaybill has GI33009981', idxK.byWaybill.has('GI33009981'));
show('  byOrderNo has GI33009981', idxK.byOrderNo.has('GI33009981'));
show('  result', M(tk, idxK));
