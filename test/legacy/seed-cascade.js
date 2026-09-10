// The two remaining cases, seeded so they can be read back through the REAL
// GET /api/label-imports/:id. Run with the server STOPPED.
const fs = require('fs');
const P = process.env.DDIR + '/tenants/default/db.json';
const db = JSON.parse(fs.readFileSync(P, 'utf8'));

db.batches = [{
  id: 'batch-casc', idealscan_code: 'IS-260905-02', client_name: 'CascadeCo',
  filename: 'casc.xlsx', uploaded_at: new Date().toISOString(), uploaded_by: 'demo',
  orders: [
    // The order whose real label must NOT be lost to an earlier guess.
    // po_number is a key the EXTRACTOR cannot read as a field, so a page
    // carrying only it can match by scan alone — a genuine guess.
    { order_number: 'CSC-100', waybill_number: '', issue_no: 'GI-88001234', po_number: 'PO88123456',
      customer_name: 'Alpha', carrier: 'Offline', total_qty: 1,
      lines: [{ sku: 'S1', description: 'A', qty: 1 }] },
    // Two orders a page can name at once, neither extractable as a field.
    { order_number: 'CSC-200', waybill_number: '', issue_no: '5512345678',
      customer_name: 'Bravo', carrier: 'Offline', total_qty: 1,
      lines: [{ sku: 'S2', description: 'B', qty: 1 }] },
    { order_number: 'CSC-300', waybill_number: '', issue_no: '5599999999',
      customer_name: 'Chas', carrier: 'Offline', total_qty: 1,
      lines: [{ sku: 'S3', description: 'C', qty: 1 }] },
    // Nothing else claims this one, so its scan match SURVIVES — the case the
    // "matched by finding the number in the text" note exists for.
    { order_number: 'CSC-400', waybill_number: '', issue_no: '', po_number: 'PO44567890',
      customer_name: 'Delta', carrier: 'Offline', total_qty: 1,
      lines: [{ sku: 'S4', description: 'D', qty: 1 }] },
  ],
  orderStates: {},
}];
db.labelImports = [];
db.orderLabels  = {};
fs.writeFileSync(P, JSON.stringify(db, null, 2));
console.log('seeded');
