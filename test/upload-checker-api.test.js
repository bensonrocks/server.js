'use strict';
const {test,describe,before,after}=require('node:test'); const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net'); const {spawn}=require('child_process');
const SERVER=path.join(__dirname,'..','server.js'); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(res=>{const s=net.createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>res(p));});});
async function boot(D){const PORT=await freePort();const B=`http://127.0.0.1:${PORT}`;const log=fs.openSync(path.join(D,'server.log'),'a');const child=spawn(process.execPath,[SERVER],{env:{...process.env,PORT:String(PORT),DATA_DIR:D,MASTER_KEY:'mk-chk'},stdio:['ignore',log,log]});for(let i=0;i<60;i++){try{if((await fetch(B+'/api/ping')).ok)return{B,child};}catch{}await sleep(500);}child.kill();throw new Error('no start');}
const stop=c=>new Promise(r=>{c.once('exit',r);c.kill('SIGTERM');setTimeout(r,5000);}); const J={'Content-Type':'application/json'};
describe('upload checker API gate',()=>{
 let D,srv,H; before(async()=>{D=fs.mkdtempSync(path.join(os.tmpdir(),'idealone-chk-'));srv=await boot(D);assert.ok((await fetch(srv.B+'/api/master/users',{method:'POST',headers:{...J,'x-master-key':'mk-chk'},body:JSON.stringify({id:'ofc',password:'pw-ofc-123',role:'admin',name:'O'})})).ok);const tok=(await(await fetch(srv.B+'/api/auth/login',{method:'POST',headers:J,body:JSON.stringify({id:'ofc',password:'pw-ofc-123'})})).json()).token;H={'x-auth-token':tok};});
 after(async()=>{if(srv)await stop(srv.child);if(D)fs.rmSync(D,{recursive:true,force:true});});
 const send=(csv,extra={},ep='/api/upload')=>{const f=new FormData();f.append('orderFile',new Blob([csv],{type:'text/csv'}),'gi.csv');f.append('client_name','CheckerClient');for(const[k,v]of Object.entries(extra))f.append(k,v);return fetch(srv.B+ep,{method:'POST',headers:H,body:f});};
 test('preview reports unmapped PO-like column; upload requires ack; ack succeeds',async()=>{
   const csv='Order No,SKU,Qty,Cust PO Ref,ShipToName\nORD-1,SKU-1,2,PO-777,Store A\n';
   const pv=await(await send(csv,{},'/api/preview')).json(); assert.ok(pv.checker,JSON.stringify(pv)); assert.ok(pv.checker.warnings.some(w=>/Cust PO Ref/.test(w.message)&&/IGNORED/.test(w.message)),JSON.stringify(pv.checker.warnings));
   let r=await send(csv); assert.equal(r.status,409); let d=await r.json(); assert.equal(d.needsUploadCheckerAck,true);
   r=await send(csv,{upload_checker_ack:'yes'}); assert.equal(r.status,200,JSON.stringify(await r.clone().json().catch(()=>({})))); });
 test('bad qty is blocked with explicit row error',async()=>{
   const csv='Order No,SKU,Qty,PONumber,ShipToName\nORD-9,SKU-1,abc,PO-1,Store A\n';
   const pv=await(await send(csv,{},'/api/preview')).json(); assert.ok(pv.checker.errors.some(e=>e.row===2&&/not a number/.test(e.message)),JSON.stringify(pv.checker));
   const r=await send(csv,{upload_checker_ack:'yes'}); assert.equal(r.status,422); const d=await r.json(); assert.ok(d.checker.errors.length); });
});
