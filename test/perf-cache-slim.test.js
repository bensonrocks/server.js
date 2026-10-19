// PERF (Oct 2026): slim/pagination, TTL caches, static ETag, yielded batches.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs=require('fs'), os=require('os'), path=require('path'), net=require('net');
const { spawn } = require('child_process');
const perf = require('../lib/perf');

test('parsePagination: page/pageSize and limit/offset, caps', ()=>{
  assert.equal(perf.parsePagination({}), null);
  assert.deepEqual(perf.parsePagination({page:'2',pageSize:'10'}), {page:2,pageSize:10,limit:10,offset:10,paginated:true});
  assert.deepEqual(perf.parsePagination({limit:'5',offset:'7'}), {page:2,pageSize:5,limit:5,offset:7,paginated:true});
  assert.equal(perf.parsePagination({pageSize:'9999'}).pageSize, 500);
});
test('slimOrder keeps list/scan fields incl stock, drops raw bulk', ()=>{
  const o=perf.slimOrder({order_number:'G1',scan_status:'pending',scanned:{A:1},fulfilment:{status:'ontime'},stock_external:false,lines:[{sku:'A',qty:2,stock_onhand:5,stock_free:5,location:'A1',huge:'x'}],secret_blob:{a:1}});
  assert.equal(o.lines[0].stock_onhand,5); assert.equal(o.lines[0].location,'A1'); assert.equal(o.lines[0].huge,undefined); assert.equal(o.secret_blob,undefined); assert.equal(o.fulfilment.status,'ontime'); assert.deepEqual(o.items,o.lines);
});
test('RoutePerf p95 alert', ()=>{ const r=new perf.RoutePerf(); for(let i=0;i<30;i++) r.record('GET /api/orders',2000); assert.ok(r.recordPeek('GET /api/orders').p95>=2000); assert.equal(r.shouldAlert('GET /api/orders'),true); assert.equal(r.shouldAlert('GET /api/orders'),false); });
test('TtlCache expires and chunkedEach yields to loop', async ()=>{
  const c=new perf.TtlCache(20); c.set('k',1); assert.equal(c.get('k'),1); await new Promise(r=>setTimeout(r,30)); assert.equal(c.get('k'),undefined); assert.equal(c.peekStale('k'),1);
  let order=[]; const p=perf.chunkedEach(Array.from({length:50},(_,i)=>i),5,(v)=>order.push(v)); setImmediate(()=>order.push('yielded')); await p; assert.ok(order.indexOf('yielded')<49, 'loop yielded mid-batch: '+order.indexOf('yielded')); assert.equal(order.filter(x=>x!=='yielded').length,50);
});

// e2e
const ROOT=path.resolve(__dirname,'..'); let DDIR,PORT,B,child,token,portalTok;
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const J=async r=>{const t=await r.text(); try{return JSON.parse(t)}catch{return{_raw:t}}};
const H=()=>({'Content-Type':'application/json','x-auth-token':token});
const MASTER='201432547E'; const MH={'Content-Type':'application/json','x-master-key':MASTER};
function freePort(){return new Promise(res=>{const s=net.createServer(); s.listen(0,()=>{const p=s.address().port; s.close(()=>res(p))})})}
async function waitUp(){for(let i=0;i<60;i++){try{if((await fetch(B+'/api/version')).status<500)return}catch{} await sleep(500)} throw new Error('no boot')}
async function boot(){const log=fs.openSync(path.join(DDIR,'server.log'),'a'); child=spawn(process.execPath,[path.join(ROOT,'server.js')],{env:{...process.env,PORT:String(PORT),DATA_DIR:DDIR},stdio:['ignore',log,log]}); await waitUp(); await sleep(1200)}
async function stop(){if(!child)return; child.kill('SIGTERM'); await new Promise(r=>{child.once('exit',r); setTimeout(r,5000)}); child=null; await sleep(300)}
function seed(db){
  const now=new Date().toISOString();
  db.batches=[{id:'b1',filename:'p.xlsx',idealscan_code:'IS-PERF-1',uploaded_at:now,uploaded_by:'demo',client_name:'ACMECO',order_count:30,row_count:30,orders:Array.from({length:30},(_,i)=>({order_number:'PERF-'+String(i).padStart(3,'0'),customer_name:'Cust '+i,waybill_number:'WB-'+i,date:now,total_qty:1,internal_blob:'HEAVY-'+'x'.repeat(2000),lines:[{sku:'SKU1',description:'Item',qty:1}]})),orderStates:Object.fromEntries(Array.from({length:30},(_,i)=>['PERF-'+String(i).padStart(3,'0'),{status:'pending',scanned:{}}]))}];
  db.transport=[{id:'TR-1',referenceId:'PERF-000',status:'pending'}];
  return db;
}
const dbPath=()=>path.join(DDIR,'tenants','default','db.json');
before(async()=>{
  DDIR=fs.mkdtempSync(path.join(os.tmpdir(),'idealone-perf-')); PORT=await freePort(); B=`http://127.0.0.1:${PORT}`;
  await boot(); await stop(); fs.writeFileSync(dbPath(), JSON.stringify(seed(JSON.parse(fs.readFileSync(dbPath(),'utf8'))))); await boot();
  const d=await J(await fetch(B+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'demo',password:'demo'})})); token=d.token; assert.ok(token);
  // portal user via master API (pattern from portal-order-drilldown.test.js)
  await fetch(B+'/api/master/client-profiles',{method:'POST',headers:MH,body:JSON.stringify({client:'ACMECO'})});
  await fetch(B+'/api/master/client-profiles/ACMECO/portal-users',{method:'POST',headers:MH,body:JSON.stringify({id:'ops',name:'ops',password:'Passw0rd!x',access:'full'})});
  const l=await J(await fetch(B+'/api/portal/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client:'ACMECO',user:'ops',password:'Passw0rd!x'})})); portalTok=l.token; assert.ok(portalTok, JSON.stringify(l));
});
after(async()=>{await stop(); try{fs.rmSync(DDIR,{recursive:true,force:true})}catch{}});

test('GET /api/orders default unchanged; slim+pagination opt-in', async()=>{
  const def=await fetch(B+'/api/orders?range=today',{headers:H()}); const dd=await J(def);
  assert.ok(Array.isArray(dd)&&dd.length===30); assert.equal(def.headers.get('x-total-count'),null);
  const slim=await fetch(B+'/api/orders?range=today&slim=1',{headers:H()}); const sd=await J(slim);
  assert.equal(slim.headers.get('x-orders-slim'),'1'); assert.equal(sd.length,30); assert.ok('stock_onhand' in sd[0].lines[0]); assert.equal(sd[0].scan_status,'pending');
  // REGRESSION GUARD: slim must never return full enrichment again.
  assert.ok(dd[0].internal_blob, 'seed sanity: default is full shape');
  assert.equal(sd[0].internal_blob, undefined, 'slim dropped heavy raw field');
  assert.ok(JSON.stringify(sd).length < JSON.stringify(dd).length/2, 'slim payload bounded vs full');
  const cap=await fetch(B+'/api/orders?range=today&pageSize=9999',{headers:H()}); assert.equal(cap.headers.get('x-page-size'),'500'); await J(cap);
  const pg=await fetch(B+'/api/orders?range=today&slim=1&page=2&pageSize=10',{headers:H()}); const pd=await J(pg);
  assert.equal(pd.length,10); assert.equal(pg.headers.get('x-total-count'),'30'); assert.equal(pd[0].order_number, sd[10].order_number);
  const lo=await fetch(B+'/api/orders?range=today&limit=5&offset=5',{headers:H()}); assert.equal((await J(lo)).length,5); assert.equal(lo.headers.get('x-offset'),'5');
});
test('GET /api/stats cached (hit header, same body)', async()=>{
  const r1=await fetch(B+'/api/stats',{headers:H()}); const b1=await J(r1);
  const r2=await fetch(B+'/api/stats',{headers:H()}); const b2=await J(r2);
  assert.equal(r2.headers.get('x-stats-cache'),'hit'); assert.deepEqual(b2,b1); assert.equal(b1.totalOrders,30);
});
test('daily-summary XLSX cached per date params', async()=>{
  const u='/api/master/report/daily-summary?from=2026-10-01&to=2026-10-19';
  const r1=await fetch(B+u,{headers:{'x-master-key':MASTER}}); assert.equal(r1.status,200); await r1.arrayBuffer();
  const r2=await fetch(B+u,{headers:{'x-master-key':MASTER}}); assert.equal(r2.headers.get('x-report-cache'),'hit'); const buf=await r2.arrayBuffer(); assert.ok(buf.byteLength>1000);
});
test('portal orders pagination + cache + overview/stock/inbound cache', async()=>{
  const ph={'x-auth-token':portalTok};
  const r1=await fetch(B+'/api/portal/orders',{headers:ph}); const d1=await J(r1); assert.ok(Array.isArray(d1)&&d1.length===30);
  const r2=await fetch(B+'/api/portal/orders',{headers:ph}); assert.equal(r2.headers.get('x-portal-cache'),'hit'); await J(r2);
  const pg=await fetch(B+'/api/portal/orders?page=1&pageSize=5',{headers:ph}); const pd=await J(pg); assert.equal(pd.length,5); assert.equal(pg.headers.get('x-total-count'),'30');
  for(const pth of ['/api/portal/overview','/api/portal/stock','/api/portal/inbound']){ const a=await fetch(B+pth,{headers:ph}); assert.equal(a.status,200,pth); await J(a); const b=await fetch(B+pth,{headers:ph}); assert.equal(b.headers.get('x-portal-cache'),'hit',pth); await J(b); }
});
test('static app.js ETag revalidation returns 304', async()=>{
  // Raw http: undici fetch does not reliably forward If-None-Match here.
  const http=require('http');
  const get=(headers)=>new Promise((res,rej)=>{ http.get(B+'/app.js',{headers},r=>{ const c=[]; r.on('data',d=>c.push(d)); r.on('end',()=>res({status:r.statusCode,headers:r.headers,body:Buffer.concat(c)})); }).on('error',rej); });
  const r1=await get({'accept-encoding':'identity'}); const etag=r1.headers.etag; assert.ok(etag); assert.match(r1.headers['cache-control']||'',/must-revalidate/); assert.ok(r1.body.length>1000000);
  const r2=await get({'If-None-Match':etag,'accept-encoding':'identity'}); assert.equal(r2.status,304);
});
test('scan increment still works (scan path unchanged)', async()=>{
  const r=await fetch(B+'/api/scan/increment',{method:'POST',headers:H(),body:JSON.stringify({orderNumber:'PERF-001',sku:'SKU1',eventId:'perf-scan-1'})});
  const d=await J(r); assert.equal(r.status,200,JSON.stringify(d)); assert.equal(d.scanned_qty,1);
});
