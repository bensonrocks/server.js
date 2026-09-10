// Sibling feature sharing the changed function: the 📍 Apply LOCATIONS radio.
const B='http://localhost:4717', MK='201432547E';
const fails=[]; const ok=(c,m)=>{console.log((c?'PASS':'FAIL')+' - '+m); if(!c)fails.push(m);};
(async()=>{
  const l=await fetch(B+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'demo',password:'demo'})}).then(r=>r.json());
  const H={'x-auth-token':l.token,'x-master-key':MK}; const C='ApplyCo'+Date.now();
  // stock with NO locations (the "Stock OK but no location" shape)
  let fd=new FormData(); fd.append('file',new Blob(['sku,name,stock_qty\nPPP,Part P,9\n'],{type:'text/csv'}),'s.csv'); fd.append('clientId',C); fd.append('confirm_apply','yes');
  await fetch(B+'/api/inventory/import-file',{method:'POST',headers:H,body:fd}).then(r=>r.json());
  // now apply locations via the dedicated endpoint
  fd=new FormData(); fd.append('file',new Blob(['SKU,Location,Qty\nPPP,BB-001-001-A,9\n'],{type:'text/csv'}),'loc.csv'); fd.append('client',C);
  const d=await fetch(B+'/api/putaway/apply-locations',{method:'POST',headers:H,body:fd}).then(r=>r.json());
  ok(d.located===1&&d.units===9,'apply-locations still bins the on-hand: '+JSON.stringify({located:d.located,units:d.units}));
  const rows=await fetch(B+`/api/inventory?clientId=${C}`,{headers:H}).then(r=>r.json());
  const p=rows.find(r=>r.sku==='PPP');
  ok(p&&p.stock_qty===9,'quantity untouched (9)');
  ok(p&&(p.bin_locations||[]).some(b=>b.location_id==='BB-001-001-A'&&b.qty===9),'binned at BB-001-001-A ×9');
  console.log('\n'+(fails.length?`${fails.length} FAILED`:'ALL PASS'));
  process.exit(fails.length?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
