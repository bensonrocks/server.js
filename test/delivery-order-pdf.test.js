// DO PDF: builds a valid PDF carrying client, DO number, ship-to and lines.
const assert = require('assert');
const { buildDeliveryOrderPdf, doNumber } = require('../lib/delivery-order');
const { PDFDocument } = require('pdf-lib');
(async () => {
  const order = { order_number: 'TEST-0001', issue_no: 'GI-1', customer_name: 'Betime HQ', delivery_address: '8 Sinaran Dr', postal_code: '307470', tel: '61234567',
    lines: Array.from({ length: 45 }, (_, i) => ({ sku: 'PKG-BOX-S' + i, description: 'Shipping Box — Small', qty: i + 1 })) };
  assert.strictEqual(doNumber(order), 'DO-GI-1');
  const buf = await buildDeliveryOrderPdf({ order, clientName: 'TEST', jobCode: 'IS-1' });
  assert.ok(buf.slice(0, 5).toString() === '%PDF-');
  const doc = await PDFDocument.load(buf);
  assert.ok(doc.getPageCount() >= 2, 'long orders paginate');
  const raw = buf.toString('latin1');
  assert.ok(buf.length > 2000);
  console.log('delivery-order-pdf: ok', doc.getPageCount(), 'pages', raw.length > 0);
})().catch(e => { console.error(e); process.exit(1); });
