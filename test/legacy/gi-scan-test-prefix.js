// The GI must ALWAYS be captured, whatever wins order_number — otherwise the
// GI-###### barcode printed on every Betime picking list matches no stored
// field and the scan-to-find-order bar cannot find the order.
// Shapes taken from the real printed picking list (GI-138891 / PT 550983 /
// Reference "260828 Bundling request: AO-000328 to AO-000329 - Koli") and from
// the reported Orders screen (18-digit TikTok ids as order_number, no GI).
const k = require('/home/user/server.js/lib/_keyfields-prefix-tmp.js');

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

// The scan-to-find-order bar's real key set (app.js waybillLookupGo / directMatch
// and server.js /api/waybill-lookup both compare these, leading-zero tolerant).
const SCAN_KEYS = ['order_number', 'waybill_number', 'issue_no', 'pick_ticket', 'po_number'];
const strip0 = s => String(s || '').trim().toUpperCase().replace(/^0+/, '');
const scannable = (m, printed) =>
  SCAN_KEYS.some(f => m[f] && strip0(m[f]) === strip0(printed));

const map = row => k.mapRow(row);

console.log('=== 1. THE REPORTED SHAPE — "GI No" column + a populated Reference ===');
{
  // Reference carries the marketplace order id, exactly as on the Orders screen.
  const m = map({ 'GI No': 'GI-141037', 'Reference': '585836014589150279',
                  'Account': 'BETIME', 'SKU Code': '8006', 'Quantity': 2 });
  ok(m.order_number === '585836014589150279', `order_number is the marketplace id (${m.order_number})`);
  ok(m.issue_no === 'GI-141037', `THE GI IS KEPT (issue_no = ${JSON.stringify(m.issue_no)}) — was "" before the fix`);
  ok(scannable(m, 'GI-141037'), 'scanning the GI-141037 barcode off the picking list FINDS the order');
}

console.log('\n=== 2. "GINo" and "GI Number" spellings ===');
for (const col of ['GINo', 'GI Number']) {
  const m = map({ [col]: 'GI-141039', 'Reference': '585835366510593147', 'SKU Code': '8006', 'Quantity': 1 });
  ok(m.issue_no === 'GI-141039' && scannable(m, 'GI-141039'), `"${col}" column is captured and scans`);
}

console.log('\n=== 3. THE PRINTED PICKING LIST (GI-138891) — "Issue No" spelling ===');
{
  const m = map({ 'Issue No': 'GI-138891', 'Pick Ticket': '550983',
                  'Reference': '260828 Bundling request: AO-000328 to AO-000329 - Koli',
                  'Account': 'BETIME', 'Sku': 'K5008', 'Total LHU': 360 });
  ok(m.issue_no === 'GI-138891', `GI kept (${m.issue_no})`);
  ok(scannable(m, 'GI-138891'), 'the LEFT barcode (GI-138891) scans');
  ok(m.pick_ticket === '550983' && scannable(m, '550983'), 'the RIGHT barcode (pick ticket 550983) scans too');
}

console.log('\n=== 4. A GI-only file — no Reference column ===');
{
  const m = map({ 'GI No': 'GI-141032', 'SKU Code': '8006', 'Quantity': 1 });
  ok(m.order_number === 'GI-141032', `the GI is still the order number (${m.order_number})`);
  ok(scannable(m, 'GI-141032'), 'and it scans');
  // The pill rule: identical values must not print the number twice.
  const giPillText = o => {
    const gi = String(o?.issue_no || '').trim();
    if (!gi) return '';
    return gi.toUpperCase() === String(o?.order_number || '').trim().toUpperCase() ? '' : gi;
  };
  ok(giPillText(m) === '', 'no GI pill when it would merely echo the order number');
  ok(giPillText({ order_number: '585836014589150279', issue_no: 'GI-141037' }) === 'GI-141037',
     'but the pill DOES show when the GI is a different number from the order number');
}

console.log('\n=== 5. REGRESSION — nothing else moved ===');
{
  const m = map({ 'iWMS GINo': 'GI-140001', 'Reference': '585835367652099818', 'SKU Code': '8006', 'Quantity': 1 });
  ok(m.issue_no === 'GI-140001', 'the iWMS GINo spelling still maps exactly as before');
}
{
  // A plain client file with no GI anywhere must not gain one.
  const m = map({ 'Order No': 'SO-9001', 'SKU': 'ABC', 'Quantity': 3, 'Description': 'Widget' });
  ok(m.order_number === 'SO-9001', `plain SKU/Quantity file unchanged (${m.order_number})`);
  ok(m.issue_no === '', 'no GI is invented where the file has none');
}
{
  // The Keyfields d- schema.
  const m = map({ 'd-exref2': 'KF-5001', 'd-SKUCODE': 'THT-64-427-3', 'd-expectedqty': 4 });
  ok(m.order_number === 'KF-5001' && m.issue_no === '', 'Keyfields d- schema unchanged');
}
{
  // "SO Ref | Waybill Ref" — the real client outbound file.
  const m = map({ 'SO Ref': 'SO-77', 'Waybill Ref': 'LZSGD1015082878', 'SKU': 'X1', 'Qty': 1 });
  ok(m.order_number === 'SO-77' && m.waybill_number === 'LZSGD1015082878' && m.issue_no === '',
     'SO Ref / Waybill Ref file unchanged');
}

console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
process.exit(fails.length ? 1 : 0);
