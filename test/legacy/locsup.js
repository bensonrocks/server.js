// Does the Inventory "Upload stock file" path SUPERSEDE an existing location,
// or only fill in a blank one? locateExistingStock is what it calls.
const os=require('os'),fs=require('fs');
process.env.DATA_DIR=fs.mkdtempSync(os.tmpdir()+'/locsup-');
const inv=require('/home/user/server.js/lib/inventory-store.js');
const ok=(c,m)=>console.log((c?'PASS':'FAIL')+' - '+m);
(async()=>{ await inv.init(); const C='LocCo';
  inv.upsert({sku:'AAA',name:'A',clientId:C,stock_qty:10});
  inv.createLocation('AA','001','001','A',1000,'dry');
  inv.createLocation('AA','002','002','B',1000,'dry');
  inv.placeStock(C,'AAA','AA-001-001-A',10);          // already binned in A
  const bins=()=> (inv.binLocationsBySku(C).get('AAA')||[]).map(b=>`${b.location_id}x${b.qty}`).sort().join(',');
  console.log('  before:',bins());
  const out=inv.locateExistingStock(C,[{sku:'AAA',location:'AA-002-002-B',qty:10}],{operator:'t'});
  console.log('  after :',bins(),'| result:',JSON.stringify({located:out.located,units:out.units,alreadyLocated:out.alreadyLocated}));
  ok(bins()==='AA-001-001-Ax10','a SKU already fully binned is SKIPPED, not moved');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
