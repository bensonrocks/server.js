// Pre-upload checker: PONumber-class silent drops must become explicit.
const assert=require('assert');
const {checkSpreadsheetRows}=require('../lib/upload-checker');
const KNOWN=new Set(['SKU-1','SKU-2']);
const clean=[
 {'Order No':'ORD-1',SKU:'SKU-1',Qty:2,PONumber:'PO-900',ShipToName:'Store A'},
 {'Order No':'ORD-1',SKU:'SKU-2',Qty:1,PONumber:'PO-900',ShipToName:'Store A'},
];
{ const r=checkSpreadsheetRows({records:clean,knownSkus:KNOWN}); assert.strictEqual(r.ok,true,JSON.stringify(r.errors)); assert.strictEqual(r.warnings.length,0,JSON.stringify(r.warnings)); assert.strictEqual(r.summary.orders,1); console.log('clean passes'); }
{ // PONumber regression class: unknown PO-ish column with data
  const rows=[{'Order No':'ORD-1',SKU:'SKU-1',Qty:2,'Cust PO Ref':'PO-777',ShipToName:'Store A'}];
  const r=checkSpreadsheetRows({records:rows,knownSkus:KNOWN});
  assert.ok(r.warnings.some(w=>/Cust PO Ref/.test(w.message)&&/IGNORED/.test(w.message)&&/PO-777/.test(w.message)),JSON.stringify(r.warnings));
  assert.ok(r.warnings.some(w=>/carton labels will print without PO/i.test(w.message)));
  assert.strictEqual(r.requiresAck,true); console.log('po-like unmapped warns'); }
{ const rows=[{'Order No':'ORD-1',SKU:'NOPE-9',Qty:1,PONumber:'PO-1',ShipToName:'A'}];
  const r=checkSpreadsheetRows({records:rows,knownSkus:KNOWN}); assert.ok(r.errors.some(e=>e.row===2&&/NOPE-9/.test(e.message)&&/Fix the SKU on row 2/.test(e.action)),JSON.stringify(r.errors)); console.log('unknown sku error'); }
{ const rows=[{'Order No':'',SKU:'SKU-1',Qty:1,PONumber:'PO-1'},{'Order No':'ORD-2',SKU:'SKU-1',Qty:'abc',PONumber:'PO-1'}];
  const r=checkSpreadsheetRows({records:rows,knownSkus:KNOWN});
  assert.ok(r.errors.some(e=>e.row===2&&/no order number/i.test(e.message)),JSON.stringify(r.errors));
  assert.ok(r.errors.some(e=>e.row===3&&/not a number/.test(e.message)&&/abc/.test(e.message)),JSON.stringify(r.errors)); console.log('missing order + bad qty'); }
{ const rows=[...clean,{'Order No':'',SKU:'',Qty:'',PONumber:'',ShipToName:''},{'Order No':'TOTAL',SKU:'Grand Total',Qty:'',PONumber:'PO-900',ShipToName:''}];
  // second junk row: label row with no usable sku/order pairing is surfaced, never silent
  const r=checkSpreadsheetRows({records:rows,knownSkus:KNOWN});
  assert.ok(r.skippedRows.length>=1&&r.warnings.some(w=>/SKIPPED/.test(w.message)),JSON.stringify(r)); console.log('junk row surfaced'); }
{ const rows=[{'Order No':'',SKU:'SKU-1',Qty:1}]; const r=checkSpreadsheetRows({records:rows,knownSkus:KNOWN,requireCustomer:true});
  assert.ok(r.errors.some(e=>/No order number could be found/.test(e.message)),JSON.stringify(r.errors)); console.log('missing required column'); }
{ const rows=[clean[0],clean[0]]; const r=checkSpreadsheetRows({records:rows,knownSkus:KNOWN}); assert.ok(r.errors.some(e=>/duplicates row 2/.test(e.message)),JSON.stringify(r.errors)); console.log('duplicate conflict'); }
{ // #102 mapped PONumber must NOT be flagged unmapped
  const r=checkSpreadsheetRows({records:clean,knownSkus:KNOWN}); assert.ok(!r.unmappedColumns.some(c=>/ponumber/i.test(c.column))); console.log('ponumber mapped'); }
console.log('upload-checker: ok');
