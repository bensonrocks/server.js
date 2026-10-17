// A Shopee Xpress (SPX) label's tracking number is SPXSG + digits + ONE check
// letter (SPXSG06870759966A). The extractor's generic pattern wanted the
// digits to end the token, so every SPX label came back with trackingNumber
// blank. A picking-list order is matched by its GI / order number, not by a
// waybill (it has none yet), so the ONLY way PR #94's fill-if-blank can give it
// one is the label's own tracking — and that was always empty: attachLabelPage
// got tracking undefined and never filled. Live: GI/Shopee orders on 17 Oct.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { extractLabelFields } = require('../lib/label-extract');
const { looksLikeTrackingNumber } = require('../lib/ocr-parse');

// 1. extraction: SPX tracking is read, order id still read, nothing else moves
const spxText = [
  'SPXSG06870759966A   SPXSG06870759966A',
  'Priority',
  '#06-605,Singapore',
  'RIVERVALE CRESCENT, 541157',
  'GRE-54C4-B1',
  'Order ID: 261017T9FG835D',
].join('\n');
const f = extractLabelFields(spxText);
assert.strictEqual(f.trackingNumber, 'SPXSG06870759966A');
assert.strictEqual(f.orderNumber, '261017T9FG835D');
// lower-case print still normalises to the stored upper-case form
assert.strictEqual(extractLabelFields('spxsg06870759966a').trackingNumber, 'SPXSG06870759966A');
// a plain all-digit SPX number still reads as before
assert.strictEqual(extractLabelFields('SPXSG068707599661').trackingNumber, 'SPXSG068707599661');
// other carriers unchanged
assert.strictEqual(extractLabelFields('TXSGD12345678901').trackingNumber, 'TXSGD12345678901');
assert.strictEqual(extractLabelFields('JTTT000003712706').trackingNumber, 'JTTT000003712706');
// not a tracking number: two trailing letters, or a bare word, is not SPX
assert.strictEqual(extractLabelFields('SPXSG06870759966AB').trackingNumber, '');

// 2. the picking-list parsers share this shape test (consignee box)
assert.strictEqual(looksLikeTrackingNumber('SPXSG06870759966A'), true);
assert.strictEqual(looksLikeTrackingNumber('SPXSG 0687 0759 966A'), true);
assert.strictEqual(looksLikeTrackingNumber('SPXSG06870759966AB'), false);
assert.strictEqual(looksLikeTrackingNumber('261017T9FG835D'), false);

// 3. end to end through the real writer: a picking-list GI order with a blank
//    waybill, matched by GI, gets the SPX tracking filled (and audited).
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
eval(grab('function isReferenceBatch(b)', '\n'));
eval(grab('function findBatchForOrder(db, orderNumber)', '// The reference copy'));
eval(grab('function referenceOnlyOrder(db, orderNumber)', 'function workOrderForReference'));
eval(grab('function isCancelledOrderNo(db', 'function waybillFillBlocker'));
eval(grab('function labelPagesOf(ref)', '// Attach one page to an order.'));
eval(grab('const _BAD_LABEL_KEY', '// Remove one page from an order'));
eval(grab('function labelTrackingOf(page)', '\n'));

const db = { orderLabels: {}, auditLog: [], batches: [
  { id: 'pick', filename: 'picking-list.pdf', orders: [{ order_number: 'GI-150900', issue_no: 'GI-150900', waybill_number: '' }] },
] };
const page = { pageIndex: 0, pageFile: 'page_1.pdf', extracted: extractLabelFields(spxText + '\nGI-150900') };
const role = attachLabelPage(db, 'GI-150900', { importId: 'I1', pageIndex: 0, pageFile: 'page_1.pdf', tracking: labelTrackingOf(page) || undefined });
assert.strictEqual(role, 'primary');
assert.strictEqual(db.batches[0].orders[0].waybill_number, 'SPXSG06870759966A');
assert.deepStrictEqual(db.auditLog.map(e => [e.type, e.order, e.tracking]), [['label_waybill_filled', 'GI-150900', 'SPXSG06870759966A']]);
console.log('spx-label-tracking-fill: ok');
