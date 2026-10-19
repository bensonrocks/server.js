'use strict';
// Pre-upload checker for spreadsheet order intake (GI / Keyfields path).
// Runs BEFORE orders are created. Reuses the real importer mapping
// (detectColumnMap + mapRow from lib/keyfields.js) — including the #102
// PONumber aliases — so "unmapped column" means: blanking that column
// changes nothing mapRow produces. That is checked differentially, not
// from a second hand-maintained alias list that could drift.
const { mapRow, detectColumnMap, normalizeKey } = require('./keyfields');

const QTY_KEYS = ['quantity','qty','pcs','pieces','d_expectedqty','released_qty_sap','released_qty'];
const PO_LIKE = /po\b|p\.?o\.?|purchase|ship_?ref|cust.*ref|reference/i;

function txt(v){ return v===null||v===undefined?'':String(v).trim(); }
function isEmpty(v){ return txt(v)===''; }

function qtySelection(raw, detected){
  const n={}; for(const k of Object.keys(raw||{})) n[normalizeKey(k)]=raw[k];
  const keys=[...QTY_KEYS]; if(detected && detected.qty_key) keys.splice(4,0,detected.qty_key);
  let seen=null;
  for(const k of [...new Set(keys)]){
    const v=n[k]; if(v===null||v===undefined||txt(v)==='') { if(!seen && k in n) seen={column:k,value:v,empty:true}; continue; }
    if((typeof v==='number'&&v===0)||txt(v)==='0'){ if(!seen) seen={column:k,value:v,zero:true}; continue; }
    return {column:k,value:v};
  }
  return seen; // empty or zero only, or null
}
function headerForNorm(records, norm){
  for(const r of records){ for(const k of Object.keys(r)) if(normalizeKey(k)===norm) return k; }
  return norm;
}
function suggestionFor(norm){
  if(/po|purchase/.test(norm)) return 'Rename this column to "PONumber" (or "PO Number") if it is the customer PO, then upload again — otherwise its values will not appear on carton labels.';
  if(/order|so_|sales/.test(norm)) return 'Rename this column to "Order No" if it holds the order number, then upload again.';
  if(/sku|item|product|material/.test(norm)) return 'Rename this column to "SKU" (or "Item Code") if it holds the product code, then upload again.';
  if(/qty|quantity/.test(norm)) return 'Rename this column to "Qty" if it holds the quantity, then upload again.';
  if(/cust|ship|consign|outlet|store/.test(norm)) return 'Rename this column to "ShipToName" (or "Customer Name") if it holds the delivery outlet, then upload again.';
  return 'If this data is needed in IdealOne, rename the column to the IdealOne field name it belongs to and upload again. If it is not needed, you can proceed — it will be dropped.';
}

function checkSpreadsheetRows(input={}){
  const records = Array.isArray(input.records)?input.records:[];
  const headers = (input.headers&&input.headers.length?input.headers:(records[0]?Object.keys(records[0]):[])).map(String);
  const rowOffset = Number.isFinite(input.rowOffset)?input.rowOffset:2; // spreadsheet row of records[0] (header = rowOffset-1)
  const knownSkus = input.knownSkus ? new Set([...input.knownSkus].map(s=>txt(s).toLowerCase()).filter(Boolean)) : null;
  const errors=[], warnings=[];
  const err=(o)=>errors.push({level:'error',...o});
  const warn=(o)=>warnings.push({level:'warning',...o});

  if(!records.length){ err({column:'(file)',message:'The file has no data rows. Nothing would be uploaded.',action:'Check the file has a header row followed by order rows, then upload again.'}); return finish({errors,warnings,headers,records,skipped:[]}); }
  if(!headers.length){ err({column:'(file)',message:'The file has no column headers. IdealOne cannot tell which column is which.',action:'Add a header row (for example: Order No, SKU, Qty, PONumber, ShipToName), then upload again.'}); return finish({errors,warnings,headers,records,skipped:[]}); }

  const detected = input.detected || detectColumnMap(records);
  const mapped = input.mapped || records.map(r=>mapRow(r,detected));
  const rowOf = i=>i+rowOffset;

  // --- required columns (judged by what mapRow actually produced) ---
  const anyOrder = mapped.some(r=>txt(r.order_number)&&r.order_number!=='UNKNOWN');
  const anySku = mapped.some(r=>txt(r.sku));
  const qtyColsPresent = new Set(); for(const r of records) for(const k of Object.keys(r)) qtyColsPresent.add(normalizeKey(k));
  const hasQtyCol = QTY_KEYS.some(k=>qtyColsPresent.has(k)) || !!(detected&&detected.qty_key&&qtyColsPresent.has(detected.qty_key));
  if(!anyOrder) err({column:'Order number',message:'No order number could be found in any row. There is no column IdealOne recognises as the order number, so every order would be created without one.',action:'Rename the column that holds the order number to "Order No" (or add one), then upload again.'});
  if(!anySku) err({column:'SKU',message:'No product SKU could be found in any row. There is no column IdealOne recognises as the SKU / item code.',action:'Rename the product-code column to "SKU" (or "Item Code"), then upload again.'});
  if(!hasQtyCol) err({column:'Qty',message:'There is no quantity column IdealOne recognises (Qty / Quantity / Expected Qty). Quantities would default to 1 per line, which is usually wrong.',action:'Rename the quantity column to "Qty", then upload again.'});

  // --- unmapped columns (differential against the real mapRow) ---
  const unmappedColumns=[];
  if(!input.skipUnmapped){
    const sampleIdx = records.map((_,i)=>i).filter(i=>mapped[i]&&txt(mapped[i].sku)||true).slice(0,200);
    const base = sampleIdx.map(i=>JSON.stringify(mapped[i]));
    for(const h of headers){
      const norm=normalizeKey(h); if(!norm||norm.startsWith('_col')) continue;
      // False-positive guard: a mapped qty column whose values are all 1 looks
      // "ignored" differentially (blanking it still defaults qty to 1 in mapRow).
      // A recognised/detected qty column is mapped by definition — never flag it.
      if(QTY_KEYS.includes(norm) || (detected && detected.qty_key && norm===normalizeKey(detected.qty_key))) continue;
      let example='', exRow=null, hasData=false;
      records.forEach((r,i)=>{ if(!isEmpty(r[h])){ hasData=true; if(!example){example=txt(r[h]).slice(0,60); exRow=rowOf(i);} } });
      if(!hasData) continue;
      let changed=false;
      for(let s=0;s<sampleIdx.length;s++){
        const i=sampleIdx[s]; const copy={...records[i]}; copy[h]=null;
        if(JSON.stringify(mapRow(copy,detected))!==base[s]){ changed=true; break; }
      }
      if(!changed){
        unmappedColumns.push({column:h,example,row:exRow});
        warn({column:h,value:example,row:exRow,message:`Column "${h}" contains data (for example "${example}" on row ${exRow}) but it is NOT mapped to any IdealOne field. If you proceed, every value in this column will be IGNORED and dropped — it will not appear on orders, picking lists or carton labels.`,action: suggestionFor(norm)});
      }
    }
  }

  // --- per-row checks + skipped rows ---
  const skipped=[];
  const seenLine=new Map();
  mapped.forEach((r,i)=>{
    const row=rowOf(i); const raw=records[i]||{};
    const sku=txt(r.sku), on=txt(r.order_number);
    const willSkip = !sku || !on || on==='UNKNOWN';
    if(willSkip){
      const reason=!sku?'no SKU — this row has no product code IdealOne can read':(!on||on==='UNKNOWN')?'no order number — this row has no order number IdealOne can read':'no SKU or order number';
      skipped.push({row,order_number:on,sku,qty:r.qty,reason});
      if(sku&&(!on||on==='UNKNOWN')) err({row,column:'Order number',message:`Row ${row} has no order number (SKU "${sku}", qty ${r.qty}). This row cannot be filed — IdealOne would not know which order it belongs to, so it will be SKIPPED.`,action:`Put the order number for SKU "${sku}" on row ${row}, then upload again.`});
      else warn({row,column:!sku?'SKU':'Order number',value:!sku?sku:on,message:`Row ${row} will be SKIPPED and will NOT be uploaded: ${reason}. (Order: "${on||'(blank)'}", SKU: "${sku||'(blank)'}")`,action:`Fix row ${row} in the file and upload again, or proceed to upload without this row.`});
      return;
    }
    // qty (raw, before mapRow's default-to-1 hides the problem)
    if(hasQtyCol){
      const sel=qtySelection(raw,detected);
      const colName=sel?headerForNorm([raw],sel.column):'Qty';
      if(!sel||sel.empty) err({row,column:colName,message:`Row ${row}: quantity is blank (order "${on}", SKU "${sku}"). IdealOne would guess 1, which may pick the wrong amount.`,action:`Put the quantity for SKU "${sku}" in the "${colName}" column on row ${row}, then upload again.`});
      else if(sel.zero) err({row,column:colName,value:'0',message:`Row ${row}: quantity is 0 (order "${on}", SKU "${sku}"). A line with zero quantity cannot be picked.`,action:`Fix the quantity on row ${row} (or delete that row from the file), then upload again.`});
      else { const num=Number(String(sel.value).replace(/,/g,'')); if(!Number.isFinite(num)) err({row,column:colName,value:txt(sel.value),message:`Row ${row}: quantity "${txt(sel.value)}" is not a number (order "${on}", SKU "${sku}").`,action:`Change the quantity on row ${row} to a whole number, then upload again.`}); else if(num<=0) err({row,column:colName,value:txt(sel.value),message:`Row ${row}: quantity "${txt(sel.value)}" must be more than zero (order "${on}", SKU "${sku}").`,action:`Fix the quantity on row ${row}, then upload again.`}); }
    }
    if(knownSkus&&knownSkus.size&&!knownSkus.has(sku.toLowerCase())){
      err({row,column:'SKU',value:sku,message:`Row ${row}: SKU "${sku}" (order "${on}") is not in this client's item master. IdealOne does not know this product, so it cannot be picked or stock-checked.`,action:`Fix the SKU on row ${row} to a code from the item master, or add "${sku}" to the item master first, then upload again.`});
    }
    const lineKey=[on,sku,txt(r.batch_number),txt(r.expiry_date)].join('|').toLowerCase();
    if(seenLine.has(lineKey)){
      const first=seenLine.get(lineKey);
      if(first.qty===r.qty) err({row,column:'SKU',value:sku,message:`Row ${row} duplicates row ${first.row}: same order "${on}", same SKU "${sku}"${r.batch_number?`, same batch "${r.batch_number}"`:''}, same qty ${r.qty}. Uploading both would double this line.`,action:`Delete one of rows ${first.row} and ${row} from the file (or correct the SKU/qty if they are really two different lines), then upload again.`});
      else warn({row,column:'SKU',value:sku,message:`Row ${row}: SKU "${sku}" already appears on row ${first.row} for order "${on}" with the same batch/expiry but a different qty (${first.qty} and ${r.qty}). They will be uploaded as two lines (combined qty ${(first.qty||0)+(r.qty||0)}).`,action:`Check rows ${first.row} and ${row}: if this is a duplicate entry, fix the file; if it is a genuine split line, proceed.`});
    } else seenLine.set(lineKey,{row,qty:r.qty});
  });

  // customer/outlet where required
  const ordersNoCustomer=new Map();
  mapped.forEach((r,i)=>{ if(txt(r.sku)&&txt(r.order_number)&&r.order_number!=='UNKNOWN'&&!txt(r.customer_name)&&!txt(r.ship_to_code)) { if(!ordersNoCustomer.has(r.order_number)) ordersNoCustomer.set(r.order_number,rowOf(i)); } });
  if(input.requireCustomer&&ordersNoCustomer.size){
    for(const [on,row] of [...ordersNoCustomer].slice(0,50)) err({row,column:'ShipToName / Customer',value:on,message:`Order "${on}" (first seen on row ${row}) has no customer / delivery outlet IdealOne can read. This intake needs one so the carton label shows where the order goes.`,action:`Add a "ShipToName" (or "Customer Name") column with the outlet for order "${on}", then upload again.`});
  } else if(ordersNoCustomer.size){
    warn({column:'ShipToName / Customer',message:`${ordersNoCustomer.size} order(s) have no customer / delivery outlet: ${[...ordersNoCustomer.keys()].slice(0,8).join(', ')}${ordersNoCustomer.size>8?'…':''}. Their carton labels will print no destination.`,action:'If these orders go to a store/outlet, add a "ShipToName" or "Customer Name" column and upload again. Otherwise you can proceed.'});
  }

  // whole-column-empty mapped fields other systems rely on
  if(mapped.length&&mapped.every(r=>!txt(r.po_number))){
    const poLike=unmappedColumns.find(c=>PO_LIKE.test(c.column));
    warn({column:'PO number',message: poLike?`No PO reference will be saved for any order. The file has a PO-like column "${poLike.column}" (for example "${poLike.example}") that is not mapped, and no mapped PO column has values — so carton labels will print without PO.`:'No PO reference in file — no order has a PO number, so carton labels will print without PO.',action: poLike?`Rename column "${poLike.column}" to "PONumber" if it is the customer PO, then upload again. Otherwise you can proceed and print carton labels without PO.`:'Add a "PONumber" column with the customer PO for each order, or proceed to print carton labels without PO.'});
  }
  if(mapped.length&&anySku&&mapped.every(r=>!txt(r.customer_name)&&!txt(r.ship_to_code))&&!input.requireCustomer){
    // already covered per-order above when some rows kept; avoid double-saying when all missing is same warning — keep only if no per-order warning emitted
  }
  return finish({errors,warnings,headers,records,mapped,skipped,unmappedColumns});
}
function finish({errors,warnings,headers,records,mapped,skipped=[],unmappedColumns=[]}){
  const orders=new Set((mapped||records.map(r=>mapRow(r,detectColumnMap(records)))).map(r=>txt(r.order_number)).filter(v=>v&&v!=='UNKNOWN'));
  // warnings are information only — never require an ack
  return { ok: errors.length===0, requiresAck: false, errors, warnings, skippedRows: skipped, unmappedColumns,
    summary:{ rows: records.length, orders: orders.size, keptRows: records.length-skipped.length, skippedRows: skipped.length, errors: errors.length, warnings: warnings.length, unmappedColumns: unmappedColumns.length, columns: headers.length } };
}
module.exports={checkSpreadsheetRows, qtySelection, suggestionFor};
