// A row with SKU + qty but a BLANK Location, in supersede mode. Their real file
// has 3 of these (209 uploaded, 206 located). What happens to that SKU?
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const B='http://localhost:4716', MK='201432547E';
const fails=[]; const ok=(c,m)=>{console.log((c?'PASS':'FAIL')+' - '+m); if(!c)fails.push(m);};
(async()=>{
  const l=await fetch(B+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'demo',password:'demo'})}).then(r=>r.json());
  const H={'x-auth-token':l.token,'x-master-key':MK}; const C='NoLocCo'+Date.now();
  const xlsx=rows=>{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'S1');return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});};
  const put=async(buf,name,extra={})=>{const fd=new FormData();fd.append('file',new Blob([buf]),name);fd.append('client',C);
    for(const[k,v]of Object.entries(extra))fd.append(k,v);
    const r=await fetch(B+'/api/putaway/import',{method:'POST',headers:H,body:fd});return{status:r.status,d:await r.json()};};
  const inv=async()=>{const rows=await fetch(B+`/api/inventory?clientId=${C}`,{headers:H}).then(r=>r.json());
    const m={};for(const r of rows)m[r.sku]={on:r.stock_qty,bins:(r.bin_locations||[]).map(b=>`${b.location_id}×${b.qty}`).join(',')};return m;};
  const total=async()=>Object.values(await inv()).reduce((n,r)=>n+(Number(r.on)||0),0);

  await put(xlsx([
    {SKU:'HASLOC', Description:'Has a location', Location:'AA-001-001-A','AVailable LHU':100},
    {SKU:'NOLOC',  Description:'No location',    Location:'AA-001-001-B','AVailable LHU':200},
  ]),'seed.xlsx',{apply:'positions',mode:'add',confirm_apply:'yes'});
  ok(await total()===300,'seeded 300');

  // The sheet: HASLOC recounted, NOLOC has qty but a BLANK Location.
  const sheet=xlsx([
    {SKU:'HASLOC',Description:'Has a location',Location:'AA-002-002-A','AVailable LHU':60},
    {SKU:'NOLOC', Description:'No location',   Location:'',            'AVailable LHU':40},
  ]);
  let {status,d}=await put(sheet,'noloc.xlsx',{apply:'positions',mode:'set'});
  const p=d.preview||{};
  console.log('  PREVIEW:',JSON.stringify({rows:p.rows,units:p.units,currentTotal:p.currentTotal,afterTotal:p.afterTotal,errorCount:p.errorCount,errors:p.errors}));
  ok(status===409,'asks first');
  ok(p.errorCount>=1 && (p.errors||[]).some(e=>e.sku==='NOLOC'),'PREVIEW FLAGS the no-location row BY SKU before you commit');
  ok((p.untouchedSkus||[]).some(x=>x.sku==='NOLOC'&&x.keeps===200),'PREVIEW says NOLOC is LEFT ALONE and keeps its 200');
  ok(p.afterTotal===260,'PREVIEW total (260) accounts for the stock it cannot place');
  ok(!(p.zeroSkus||[]).some(x=>x.sku==='NOLOC'),'NOLOC is NOT claimed as going to zero');

  ({status,d}=await put(sheet,'noloc.xlsx',{apply:'positions',mode:'set',confirm_apply:'yes'}));
  const m=await inv();
  console.log('  AFTER:',JSON.stringify(m),'total',await total());
  ok(m.HASLOC?.on===60,'HASLOC recounted to 60');
  console.log('  NOLOC ended: on hand '+m.NOLOC?.on+', bins "'+(m.NOLOC?.bins||'')+'"');
  ok(m.NOLOC?.on===200 && m.NOLOC?.bins==='AA-001-001-B×200','NOLOC LEFT COMPLETELY ALONE — stock and bin both intact, not half-wiped');
  ok(await total()===260,'the real total (260) is EXACTLY what the preview promised');
  ok((d.untouched||[]).some(x=>x.sku==='NOLOC'),'the result reports NOLOC as untouched');
  console.log('\n'+(fails.length?`${fails.length} FAILED`:'ALL PASS'));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
