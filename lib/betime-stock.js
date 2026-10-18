'use strict';
// Betime shared pool + labelled/unlabelled rules. Pure, testable.
// DESIGN (tracking-off): Betime profiles have stock_tracking=false (#83), so
// orderStockStateSrv returns null and auto-cancel never fires for Betime.
// Enforcement here is therefore ADVISORY (typed availability/warning) unless
// a Betime profile is deliberately switched to tracked — then typed
// availability replaces total availability in the stock verdict.
const BETIME_RE = /betime/i;
const isBetimeClient = n => BETIME_RE.test(String(n||''));
function betimePoolId(ids){ const f=(ids||[]).map(String).filter(isBetimeClient).sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())); return f.find(x=>x.toLowerCase()==='betime')||f[0]||'betime'; }
function resolvePoolClientId(name, ids){ return isBetimeClient(name)? betimePoolId(ids) : name; }
function parseStockType(v){ const s=String(v??'').trim().toLowerCase();
  if(['labelled','labeled','label','b2b'].includes(s)) return 'labelled';
  if(['unlabelled','unlabeled','unlabel','no label','b2c'].includes(s)) return 'unlabelled';
  return ''; }
function stockTypeOfRow(r){ return parseStockType(r.stocktype??r.stock_type??r.labeltype??r.labelled??r.type??''); }
// B2B/B2C per order — GROUND TRUTH in code: OneCart/Zort/Shopify pulls are
// marketplace (B2C); manual picking-list/GI uploads + portal key-ins are B2B
// (delivery-planner/GI world, outlet-lookup). Profile type is fallback.
function orderChannelType(batch={}, order={}, profileType=''){
  const src=String(batch.uploaded_by||'').toLowerCase();
  if(src.includes('onecart')||src.includes('zort')||src.includes('shopify')||order.onecart_id||order.zort_id||order.shopify_id) return 'B2C';
  if(src && src!=='system') return 'B2B'; // manual upload / portal / planner
  const t=String(profileType||'').toUpperCase(); return (t==='B2B'||t==='B2C')?t:''; }
function typedQty(row, channel){ if(!row) return 0; const l=Number(row.labelled_qty)||0, u=Number(row.unlabelled_qty)||0;
  // Legacy rows with no typed split: total is untyped — counts for neither
  // channel strictly; caller surfaces 'untyped'. Return -1 sentinel handled below.
  if(l+u===0) return Number(row.stock_qty)||0; // pre-feature stock: treat as available, flag untyped
  return channel==='B2B'? l : channel==='B2C'? u : (l+u); }
function typedState(row, need, channel){ if(!row) return {state:'none',have:0,need,wrongTypeOnly:false,untyped:false};
  const l=Number(row.labelled_qty)||0,u=Number(row.unlabelled_qty)||0,total=Number(row.stock_qty)||0;
  const untyped = (l+u===0 && total>0);
  const have = untyped? total : typedQty(row,channel);
  const wrongHave = channel==='B2B'? u : channel==='B2C'? l : 0;
  return { state: have<=0?'none':(have<need?'partial':'ok'), have, need, wrongTypeOnly: have<=0 && wrongHave>0 && !untyped, untyped }; }
module.exports={isBetimeClient,betimePoolId,resolvePoolClientId,parseStockType,stockTypeOfRow,orderChannelType,typedQty,typedState};
