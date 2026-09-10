// The row must say what the upload MOVED, and the success line must state the
// client's whole position — the two facts that were missing when someone asked
// "why is the balance 664 and not 1236".
const B='http://localhost:4717', MK='201432547E';
const fails=[]; const ok=(c,m)=>{console.log((c?'PASS':'FAIL')+' - '+m); if(!c)fails.push(m);};
(async()=>{
  const l=await fetch(B+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'demo',password:'demo'})}).then(r=>r.json());
  const H={'x-auth-token':l.token,'x-master-key':MK}; const C='MovedCo'+Date.now();
  const up=async(csv,name,extra={})=>{const fd=new FormData();fd.append('file',new Blob([csv],{type:'text/csv'}),name);
    fd.append('clientId',C);for(const[k,v]of Object.entries(extra))fd.append(k,v);
    const r=await fetch(B+'/api/inventory/import-file',{method:'POST',headers:H,body:fd});return{status:r.status,d:await r.json()};};

  let {d}=await up('sku,name,stock_qty\nA,Alpha,100\nB,Bravo,200\n','seed.csv',{confirm_apply:'yes'});
  ok(d.unitsMoved===300,'seed reports it MOVED +300 pc(s)');
  ok(d.clientTotal===300,'…and that the client now holds 300');

  ({d}=await up('sku,name,stock_qty\nA,Alpha,50\n','top-up.csv',{confirm_apply:'yes'}));
  ok(d.unitsMoved===50,'an ADD of 50 reports +50 MOVED, not a post-state total');
  ok(d.clientTotal===350,'client now holds 350');

  // REPLACE is a SUPERSEDE: the file IS the position. A file naming only A
  // therefore lands the client on 10 — B is absent, so it goes to zero — and
  // the delta reported is −340, not −140. (This assertion used to encode the
  // old per-SKU rule, where B stayed standing; that is the behaviour the user
  // rejected outright: "just supersede, with no further calculations".)
  ({d}=await up('sku,name,stock_qty\nA,Alpha,10\n','recount.csv',{mode:'set',confirm_apply:'yes'}));
  ok(d.unitsMoved===-340,'a SUPERSEDE from 350 to the file\'s 10 reports −340 MOVED');
  ok(d.clientTotal===10,'client now holds 10 — the file\'s own sum');

  const rows=(await fetch(B+'/api/putaway/imports?client='+encodeURIComponent(C),{headers:H}).then(r=>r.json())).rows||[];
  const seed=rows.find(x=>x.filename==='seed.csv'), rec=rows.find(x=>x.filename==='recount.csv');
  console.log('  ROWS:',JSON.stringify(rows.map(x=>({f:x.filename,lines:x.lines,unitsMoved:x.unitsMoved}))));
  ok(seed?.unitsMoved===300,'the LIST row carries +300 for the seed');
  ok(rec?.unitsMoved===-340,'the LIST row carries −340 for the supersede');
  console.log('\n'+(fails.length?`${fails.length} FAILED`:'ALL PASS'));
  process.exit(fails.length?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
