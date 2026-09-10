// Seed the EXACT shape from the reported screenshot, plus a GI order, so the
// identity check can be read back through the real endpoint.
// Run with the server STOPPED — a running one holds the db in memory and would
// re-persist over this file.
const fs = require('fs');
const P = process.env.DDIR + '/tenants/default/db.json';
const db = JSON.parse(fs.readFileSync(P, 'utf8'));

db.batches = [{
  id: 'batch-idtest', idealscan_code: 'IS-260905-01', client_name: 'MAYER2026',
  filename: 'idtest.xlsx', uploaded_at: new Date().toISOString(), uploaded_by: 'demo',
  orders: [
    { order_number: '172429924275375', waybill_number: 'LZSGD1015379600', issue_no: '',
      customer_name: 'Mivkey Manders', carrier: 'Lazada', total_qty: 1,
      lines: [{ sku: 'SK-1', description: 'Thing', qty: 1 }] },
    { order_number: 'SO-7788', waybill_number: '', issue_no: 'GI-9931',
      customer_name: 'ACME Pte Ltd', carrier: 'Offline', total_qty: 2,
      lines: [{ sku: 'SK-2', description: 'Other', qty: 2 }] },
  ],
  orderStates: {},
}];

db.labelImports = [{
  id: 'imp-idtest', filename: '172429924275375.pdf',
  uploadedAt: new Date().toISOString(), uploadedBy: 'demo', pageCount: 3,
  pages: [
    // 1 — THE REPORTED PAGE: tracking exact, order no. one digit out (OCR).
    { pageIndex: 0, pageFile: 'page_1.pdf', matchStatus: 'matched',
      matchedOrderNumber: '172429924275375', matchMethod: 'tracking_number',
      rawText: 'Tracking LZSGD1015379600 Order No: 172428924275375 To: Mivkey Manders',
      extracted: { trackingNumber: 'LZSGD1015379600', orderNumber: '172428924275375',
                   giNumber: '', recipientName: 'Mivkey Manders' } },
    // 2 — a GI page, matched on its own GI.
    { pageIndex: 1, pageFile: 'page_2.pdf', matchStatus: 'matched',
      matchedOrderNumber: 'SO-7788', matchMethod: 'gi_number',
      rawText: 'GI No: GI-9931 To: ACME Pte Ltd',
      extracted: { trackingNumber: '', orderNumber: '', giNumber: 'GI-9931',
                   recipientName: 'ACME Pte Ltd' } },
    // 3 — a page carrying a number belonging to NOTHING on this order.
    { pageIndex: 2, pageFile: 'page_3.pdf', matchStatus: 'matched',
      matchedOrderNumber: 'SO-7788', matchMethod: 'manual',
      rawText: 'Order No: 999888777666555',
      extracted: { trackingNumber: '', orderNumber: '999888777666555', giNumber: '' } },
  ],
}];

fs.writeFileSync(P, JSON.stringify(db, null, 2));
console.log('seeded');
