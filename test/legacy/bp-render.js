const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const {chromium}=require('/home/user/server.js/node_modules/playwright');
const S=__dirname,PORT=4772,B=`http://localhost:${PORT}`,DDIR=path.join(S,'bulk-print-data');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const c=spawn('node',['/home/user/server.js/server.js'],{env:{...process.env,PORT:String(PORT),DATA_DIR:DDIR},stdio:['ignore',fs.openSync(path.join(S,'bp-render.log'),'a'),fs.openSync(path.join(S,'bp-render.log'),'a')],detached:true});
  for(let i=0;i<40;i++){try{if((await fetch(B+'/api/version')).status<500)break;}catch{}await sleep(500);} await sleep(2000);
  const tok=(await (await fetch(B+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'demo',password:'demo'})})).json()).token;
  const r=await fetch(B+'/api/orders/print-labels',{method:'POST',headers:{'Content-Type':'application/json','x-auth-token':tok},body:JSON.stringify({orders:['GI-200004','GI-200005','GI-200006']})});
  const pdf=Buffer.from(await r.arrayBuffer()); fs.writeFileSync(path.join(S,'bp-system.pdf'),pdf);
  // render with pdfjs in a browser page (Chromium's PDF viewer can't be screenshotted headless) — use pdf.js from node_modules served inline
  const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
  const page=await browser.newPage({viewport:{width:900,height:1300}});
  const pdfjsSrc=fs.readFileSync('/home/user/server.js/node_modules/pdfjs-dist/legacy/build/pdf.js','utf8');
  const workerSrc=fs.readFileSync('/home/user/server.js/node_modules/pdfjs-dist/legacy/build/pdf.worker.js','utf8');
  await page.setContent('<canvas id=c></canvas>');
  await page.addScriptTag({content:pdfjsSrc});
  await page.evaluate(w=>{ const blob=new Blob([w],{type:'text/javascript'}); pdfjsLib.GlobalWorkerOptions.workerSrc=URL.createObjectURL(blob); },workerSrc);
  const b64=pdf.toString('base64');
  for(const n of [1,2,3]){
    await page.evaluate(async({b64,n})=>{const data=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const doc=await pdfjsLib.getDocument({data}).promise;const p=await doc.getPage(n);const vp=p.getViewport({scale:3});const c=document.getElementById('c');c.width=vp.width;c.height=vp.height;await p.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;},{b64,n});
    const el=await page.$('#c'); await el.screenshot({path:path.join(S,`bp-sys-${n}.png`)});
  }
  await browser.close(); try{process.kill(-c.pid,'SIGTERM');}catch{} try{process.kill(c.pid,'SIGTERM');}catch{}
  console.log('done');
})().catch(e=>{console.error(e);process.exit(1);});
