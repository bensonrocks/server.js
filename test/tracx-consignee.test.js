// A CARRIER TRACKING NUMBER IN THE CONSIGNEE BOX IS THE WAYBILL, NOT A NAME.
//
// Reported from the floor with a photo of a Betime picking list and the words
// "tracx labels always having issues". The list reads:
//     Consignee          TXSGD03906517       <- the TracX waybill
//     Consignee Address  TingTing            <- the buyer's name
// Keyfields swaps the two. Every parser here filed the waybill as the
// customer's NAME and left waybill_number blank (the PDF path put the
// Reference — the marketplace id — there instead), so a TracX label, which
// prints exactly that waybill, had nothing on the order to match.
//
// Pure-function checks, no server: the text parser on the photo's own text,
// the XLSX row mapper on the same shape, and the shape test itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOcrPicklist, looksLikeTrackingNumber } = require('../lib/ocr-parse');
const { mapRow } = require('../lib/keyfields');

// The photo, as OCR hands it over. Identifiers are the real ones on the
// paper (an order number and a waybill, no person's address).
const PHOTO_TEXT = `
GI-144376                    Picking List                     *556540*
Issue No            GI-144376
Pick Ticket         556540
Issuing Date/Time   21/Sep/2026 10:05:27AM
Delivery Date       21/Sep/2026
Truck No
Status              35-Pick in Progress
Account             BETIME
Reference           173174129789495
PO Number
Consignee           TXSGD03906517
Consignee Address   TingTing
SNo Location   Sku      Sku Description                              WholeUom  LooseUom  Total LHU  BatchNo/LotNo
1  AC-004-001-C  NX4664  Nuxe Hair Prodigieux High Shine Conditioner 200ml   1 EACH   CARTO   1   RT
2  AC-006-004-A  5602    Nuxe RDM F & B Ultra-rich Clnsg Gel (Dry/Sens) 400ml - 5602   1 EACH   CARTO   1   N125J056
3  DMG-2         5503M   Nuxe HP Floral Multi-p Dry Oil 10ml - 5503M   1 EACH   CARTO   1   D132K013
Total Whole Qty :    3
Remarks: TracX Logis
`;

test('the shape test knows a waybill from a name', () => {
  assert.equal(looksLikeTrackingNumber('TXSGD03906517'), true);
  assert.equal(looksLikeTrackingNumber('SPXSG063702823079'), true);
  assert.equal(looksLikeTrackingNumber('LZSGD1015082878'), true);
  assert.equal(looksLikeTrackingNumber('QSP222141513'), true);       // the TracXLogis shape
  assert.equal(looksLikeTrackingNumber('TingTing'), false);
  assert.equal(looksLikeTrackingNumber('BETIME'), false);
  assert.equal(looksLikeTrackingNumber('Nuxe Hair Prodigieux'), false);
  assert.equal(looksLikeTrackingNumber('173174129789495'), false);    // a marketplace id is not a waybill
  assert.equal(looksLikeTrackingNumber(''), false);
  assert.equal(looksLikeTrackingNumber(undefined), false);
});

test('photo text parser: the Consignee waybill lands as waybill_number, the Reference as po_number', () => {
  const rows = parseOcrPicklist(PHOTO_TEXT);
  assert.ok(rows.length >= 1, `at least one line parsed (got ${rows.length})`);
  const r = rows[0];
  assert.equal(r.waybill_number, 'TXSGD03906517', 'the TracX waybill is the order\'s waybill');
  assert.equal(r.po_number, '173174129789495', 'the marketplace id rides as po_number');
  assert.equal(r.issue_no, 'GI-144376');
  assert.equal(r.pick_ticket, '556540');
  assert.notEqual(r.customer_name, 'TXSGD03906517', 'a waybill is never the customer\'s name');
  // On this parser the Account box has always outranked Consignee for the
  // name (it doubles as client_name, which decides WHOSE batch this is) — so
  // the name is still BETIME, not the buyer. Deliberately unchanged.
  assert.equal(r.customer_name, 'BETIME');
  // The lines themselves are unchanged by this — the documented location and
  // SKU rules still hold on the photo's own three shapes.
  const skus = rows.map(x => x.sku);
  assert.ok(skus.includes('NX4664'), `NX4664 parsed (${skus.join(',')})`);
  for (const x of rows) assert.ok(!/^(AC|DMG)-/.test(x.sku), 'a location never becomes a SKU');
});

test('photo text parser: a plain consignee name is still a name and no waybill is invented', () => {
  const rows = parseOcrPicklist(PHOTO_TEXT.replace('Consignee           TXSGD03906517', 'Consignee           Acme Retail Pte Ltd'));
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].waybill_number, '', 'no waybill is invented from a name');
  assert.equal(rows[0].customer_name, 'BETIME', 'the Account still names the client');
});

test('photo text parser: with no Account box, a name in the Consignee box is the customer, a waybill there is not', () => {
  const noAccount = PHOTO_TEXT.replace('Account             BETIME\n', '');
  const a = parseOcrPicklist(noAccount.replace('Consignee           TXSGD03906517', 'Consignee           Acme Retail Pte Ltd'));
  assert.equal(a[0].customer_name, 'Acme Retail Pte Ltd');
  assert.equal(a[0].waybill_number, '');
  const b = parseOcrPicklist(noAccount);
  assert.equal(b[0].waybill_number, 'TXSGD03906517');
  assert.notEqual(b[0].customer_name, 'TXSGD03906517');
  assert.equal(b[0].customer_name, 'TingTing', 'the buyer\'s name comes from "Consignee Address"');
});

test('XLSX row mapper: a tracking-shaped Consignee column becomes the waybill, not the customer', () => {
  const r = mapRow({ 'Issue No': 'GI-144376', 'Consignee': 'TXSGD03906517', 'SKU': 'NX4664', 'Qty': 1, 'Reference': '173174129789495' });
  assert.equal(r.waybill_number, 'TXSGD03906517');
  assert.notEqual(r.customer_name, 'TXSGD03906517');
});

test('XLSX row mapper: a real Tracking No column still wins over the Consignee box', () => {
  const r = mapRow({ 'Issue No': 'GI-1', 'Consignee': 'TXSGD03906517', 'Tracking No': 'TXSGD00000001', 'SKU': 'A', 'Qty': 1 });
  assert.equal(r.waybill_number, 'TXSGD00000001');
});

test('XLSX row mapper: an ordinary consignee is untouched', () => {
  const r = mapRow({ 'Issue No': 'GI-2', 'Consignee': 'TingTing', 'SKU': 'A', 'Qty': 1 });
  assert.equal(r.customer_name, 'TingTing');
  assert.equal(r.waybill_number, '');
});
