'use strict';
// Performance helpers (event-loop lag fix, Oct 2026). No behaviour change by
// themselves: a TTL cache, pagination parsing, a slim list projection and a
// cooperative yield. Callers opt in.
const TTL_MS = () => { const n = parseInt(process.env.PERF_CACHE_TTL_MS||'',10); return Number.isFinite(n)&&n>=0?n:45000; };
class TtlCache {
  constructor(ttlMs){ this.ttlMs = ttlMs==null?TTL_MS():ttlMs; this.map=new Map(); }
  get(key){ const e=this.map.get(key); if(!e) return undefined; if(Date.now()-e.at>this.ttlMs) return undefined; /* keep entry: peekStale() serves it (stale-while-revalidate) */ return e.value; }
  peekStale(key){ const e=this.map.get(key); return e?e.value:undefined; }
  isStale(key){ const e=this.map.get(key); return !e || Date.now()-e.at>this.ttlMs; }
  set(key,value){ this.map.set(key,{at:Date.now(),value}); if(this.map.size>500){ const k=this.map.keys().next().value; this.map.delete(k);} return value; }
  clear(){ this.map.clear(); }
  deletePrefix(p){ for(const k of [...this.map.keys()]) if(String(k).startsWith(p)) this.map.delete(k); }
}
function parsePagination(query={}){
  const hasPage = query.page!==undefined || query.pageSize!==undefined;
  const hasLimit = query.limit!==undefined || query.offset!==undefined;
  if(!hasPage && !hasLimit) return null;
  let pageSize = parseInt(query.pageSize||query.limit,10); if(!Number.isFinite(pageSize)||pageSize<1) pageSize=100;
  pageSize=Math.min(500,pageSize);
  let offset;
  if(hasPage){ let page=parseInt(query.page,10); if(!Number.isFinite(page)||page<1) page=1; offset=(page-1)*pageSize; return {page,pageSize,limit:pageSize,offset,paginated:true}; }
  offset=parseInt(query.offset,10); if(!Number.isFinite(offset)||offset<0) offset=0;
  return {page:Math.floor(offset/pageSize)+1,pageSize,limit:pageSize,offset,paginated:true};
}
function paginate(arr,p){ if(!p) return arr; return arr.slice(p.offset,p.offset+p.limit); }
function paginationHeaders(p,total){ if(!p) return {}; return {'X-Total-Count':String(total),'X-Page':String(p.page),'X-Page-Size':String(p.pageSize),'X-Offset':String(p.offset)}; }
// Slim list row: every field public/app.js list/scan rendering reads (incl.
// per-line stock_* so the stock pill still works), dropping raw-order bulk
// (addresses are kept - scan screen shows them; heavy nested audit/label
// payloads on the raw order are not list fields).
function slimLine(l){ if(!l||typeof l!=='object') return l; return {sku:l.sku,description:l.description,qty:l.qty,uom:l.uom,barcode:l.barcode,location:l.location,batch_number:l.batch_number,serial_number:l.serial_number,expiry_date:l.expiry_date,remarks_betime:l.remarks_betime,source_description:l.source_description,from_bundle:l.from_bundle,pick_locations:l.pick_locations,pick_shortfall:l.pick_shortfall,stock_onhand:l.stock_onhand,stock_available:l.stock_available,stock_free:l.stock_free,stock_owner:l.stock_owner}; }
function slimOrder(o){
  if(!o||typeof o!=='object') return o;
  const lines=(o.lines||o.items||[]).map(slimLine);
  return {order_number:o.order_number,customer_name:o.customer_name,tel:o.tel,delivery_address:o.delivery_address,carrier:o.carrier,waybill_number:o.waybill_number,waybills:o.waybills,issue_no:o.issue_no,pick_ticket:o.pick_ticket,po_number:o.po_number,channel_order_name:o.channel_order_name,platform:o.platform,shop_name:o.shop_name,date:o.date,total_qty:o.total_qty,lines,items:lines,client_name:o.client_name,batchId:o.batchId,uploadedAt:o.uploadedAt,idealscan_code:o.idealscan_code,scan_status:o.scan_status,scanned:o.scanned,mismatches:o.mismatches,startTime:o.startTime,endTime:o.endTime,operator:o.operator,keyfields_closed:o.keyfields_closed,claimed_by:o.claimed_by,reference_only:o.reference_only,reference_twin:o.reference_twin,api_source:o.api_source,stock_external:o.stock_external,has_waybill_pdf:o.has_waybill_pdf,has_order_label:o.has_order_label,label_pages:o.label_pages,transport_id:o.transport_id,fulfilment:o.fulfilment,has_bundle:o.has_bundle,bundle_skus:o.bundle_skus,pending_deletion:o.pending_deletion,archived:o.archived,placed_at:o.placed_at,unprocessed_at:o.unprocessed_at,unprocessed_reason:o.unprocessed_reason,auto_cancelled:o.auto_cancelled,auto_cancelled_why:o.auto_cancelled_why,auto_cancelled_short:o.auto_cancelled_short,hub_exception:o.hub_exception,platform_cancelled:o.platform_cancelled,client_cancelled:o.client_cancelled,zort_push:o.zort_push,zort_label:o.zort_label,alert_email_sent:o.alert_email_sent,alert_email_error:o.alert_email_error,attribution_hint:o.attribution_hint,delivery_proof:o.delivery_proof,cartons:o.cartons,active_carton_num:o.active_carton_num,wave_id:o.wave_id,wave_code:o.wave_code,active_wave_id:o.active_wave_id,active_wave_code:o.active_wave_code,active_wave_status:o.active_wave_status,pickup_status:o.pickup_status,picked_up_at:o.picked_up_at,picked_up_by:o.picked_up_by,pickup_method:o.pickup_method,collection_due:o.collection_due};
}
const yieldLoop = () => new Promise(r=>setImmediate(r));
async function chunkedEach(arr,batchSize,fn){ const n=Math.max(1,batchSize|0||20); for(let i=0;i<arr.length;i++){ const r=fn(arr[i],i); if(r&&typeof r.then==='function') await r; if(i%n===n-1) await yieldLoop(); } }
class RoutePerf {
  constructor(windowSize=120){ this.windowSize=windowSize; this.map=new Map(); this.lastAlert=new Map(); }
  record(route,durationMs){ let a=this.map.get(route); if(!a){a=[];this.map.set(route,a);} a.push(durationMs); if(a.length>this.windowSize)a.shift(); const sorted=[...a].sort((x,y)=>x-y); const p95=sorted[Math.min(sorted.length-1, Math.floor(sorted.length*0.95))]; return {count:a.length,p95}; }
  shouldAlert(route,thresholdMs=1500,cooldownMs=60000){ const now=Date.now(); const last=this.lastAlert.get(route)||0; if(now-last<cooldownMs) return false; const {count,p95}=this.recordPeek(route); if(count>=20 && p95>thresholdMs){ this.lastAlert.set(route,now); return true; } return false; }
  recordPeek(route){ const a=this.map.get(route)||[]; const sorted=[...a].sort((x,y)=>x-y); return {count:a.length,p95:sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*0.95))]:0}; }
}
module.exports={TtlCache,parsePagination,paginate,paginationHeaders,slimOrder,slimLine,yieldLoop,chunkedEach,TTL_MS,RoutePerf};
