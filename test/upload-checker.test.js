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
  assert.strictEqual(r.requiresAck,false); console.log('po-like unmapped warns (non-blocking)'); }
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
{ // mapped Qty column with all qty=1 must NOT be flagged ignored (blanking defaults to 1)
  const rows=[{'Order No':'ORD-1',SKU:'SKU-1',Qty:1,PONumber:'PO-1',ShipToName:'A'},{'Order No':'ORD-1',SKU:'SKU-2',Qty:1,PONumber:'PO-1',ShipToName:'A'}];
  const r=checkSpreadsheetRows({records:rows,knownSkus:KNOWN}); assert.ok(!r.unmappedColumns.some(c=>/qty/i.test(c.column)),JSON.stringify(r.unmappedColumns)); assert.ok(!r.warnings.some(w=>/Qty/.test(w.column||'')&&/IGNORED/.test(w.message)),JSON.stringify(r.warnings)); console.log('qty-all-1 not flagged ignored'); }
{ // UI (#105): checker is information only — never disables Approve, no 'cannot proceed' wording
  const app=require('fs').readFileSync(require('path').join(__dirname,'..','public','app.js'),'utf8');
  const srv=require('fs').readFileSync(require('path').join(__dirname,'..','server.js'),'utf8');
  assert.ok(!app.includes('checkerAckChk'), 'ack checkbox must be gone');
  assert.ok(!app.includes('needsUploadCheckerAck'), '409 ack retry must be gone');
  assert.ok(app.includes('for information only, upload will proceed'), 'checker panel must be plainly informational');
  assert.ok(!app.includes('must be fixed before this file can be uploaded'), 'no checker cannot-proceed wording');
  assert.ok(!/chk\.errors\.length\)[^\n]*confirmApproveBtn[^\n]*disabled/.test(app), 'Approve must never be disabled by checker errors');
  assert.ok(!srv.includes('uploadCheckerBlocked'), 'server must not return checker-blocked flag');
  assert.ok(!/checker[\s\S]{0,200}status\(422\)/.test(srv.slice(srv.indexOf('UPLOAD CHECKER (spreadsheet'), srv.indexOf('UPLOAD CHECKER (spreadsheet')+800)), 'server checker block must not 422');
  console.log('ui no checker gate'); }
{ const r=checkSpreadsheetRows({records:[{'Order No':'ORD-1',SKU:'NOPE-9',Qty:'abc',PONumber:'PO-1',ShipToName:'A'}],knownSkus:KNOWN});
  assert.strictEqual(r.blocking,false); assert.strictEqual(r.requiresAck,false); assert.strictEqual(r.ok,true); assert.ok(r.errors.length>=2, JSON.stringify(r.errors)); console.log('checker report informational flags'); }
console.log('upload-checker: ok');
