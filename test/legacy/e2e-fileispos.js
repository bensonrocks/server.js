// THE FILE IS THE POSITION. After a supersede, on-hand == the sheet's sum,
// with no arithmetic left over — including rows that carry NO Location.
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const B='http://localhost:4717', MK='201432547E';
const fails=[]; const ok=(c,m)=>{console.log((c?'PASS':'FAIL')+' - '+m); if(!c)fails.push(m);};
(async()=>{
  const l=await fetch(B+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'demo',password:'demo'})}).then(r=>r.json());
  const H={'x-auth-token':l.token,'x-master-key':MK}; const C='PosCo'+Date.now();
  const xlsx=rows=>{const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'S1');return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});};
  const put=async(buf,name,extra={})=>{const fd=new FormData();fd.append('file',new Blob([buf]),name);fd.append('client',C);
    for(const[k,v]of Object.entries(extra))fd.append(k,v);
    const r=await fetch(B+'/api/putaway/import',{method:'POST',headers:H,body:fd});return{status:r.status,d:await r.json()};};
  const inv=async()=>{const rows=await fetch(B+`/api/inventory?clientId=${C}`,{headers:H}).then(r=>r.json());
    const m={};for(const r of rows)m[r.sku]={on:r.stock_qty,bins:(r.bin_locations||[]).map(b=>`${b.location_id}×${b.qty}`).sort().join(',')};return m;};
  const total=async()=>Object.values(await inv()).reduce((n,r)=>n+(Number(r.on)||0),0);

  // Seed a messy prior position: 4 SKUs, 800 pcs.
  await put(xlsx([
    {SKU:'A',Description:'A',Location:'AA-001-001-A','AVailable LHU':300},
    {SKU:'B',Description:'B',Location:'AA-001-001-B','AVailable LHU':200},
    {SKU:'C',Description:'C',Location:'AA-001-002-A','AVailable LHU':200},
    {SKU:'D',Description:'D',Location:'AA-001-002-B','AVailable LHU':100},
  ]),'seed.xlsx',{apply:'positions',mode:'add',confirm_apply:'yes'});
  ok(await total()===800,'seeded 800');

  // THE SHEET: A moved+recounted, B has NO LOCATION (the reported shape),
  // NEW is brand new, C absent. Sum = 400 + 336 + 500 = 1236.
  const sheet=xlsx([
    {SKU:'A',  Description:'A',Location:'AA-002-002-A','AVailable LHU':400},
    {SKU:'B',  Description:'B',Location:'',            'AVailable LHU':336},
    {SKU:'NEW',Description:'New one',Location:'BB-009-009-A','AVailable LHU':500},
  ]);

  let {status,d}=await put(sheet,'MAYER 1-09-26.xlsx',{apply:'positions',mode:'set'});
  const p=d.preview||{};
  console.log('  PREVIEW:',JSON.stringify({units:p.units,currentTotal:p.currentTotal,afterTotal:p.afterTotal,unbinnedRows:p.unbinnedRows,unbinnedUnits:p.unbinnedUnits,errorCount:p.errorCount,zeroSkuCount:p.zeroSkuCount}));
  ok(status===409,'asks first');
  ok(p.units===1236,'preview counts ALL three rows (1236) — the location-less one included');
  ok(p.afterTotal===1236,'preview states AFTER = 1236 = the sheet\'s own sum');
  ok(p.errorCount===0,'the location-less row is NOT an error');
  ok(p.unbinnedRows===1 && p.unbinnedUnits===336,'it is reported as counted-but-unbinned');
  ok((p.untouchedSkus||[]).length===0,'NOTHING is left untouched');

  ({status,d}=await put(sheet,'MAYER 1-09-26.xlsx',{apply:'positions',mode:'set',confirm_apply:'yes'}));
  ok(status===200,'applied');
  const m=await inv();
  console.log('  AFTER:',JSON.stringify(m));
  console.log('  RESULT:',JSON.stringify({units:d.units,unbinned:d.unbinned,zeroed:d.zeroed}));
  ok(await total()===1236,'★ ON HAND == THE FILE\'S SUM (1236), exactly');
  ok(m.A?.on===400 && m.A?.bins==='AA-002-002-A×400','A recounted to 400 and moved');
  ok(m.B?.on===336,'B COUNTED at 336 even though the sheet gave no location');
  ok(!m.B?.bins,'B carries no bin — the gap is visible, not hidden');
  ok(m.NEW?.on===500 && m.NEW?.bins==='BB-009-009-A×500','NEW created, 500, binned');
  ok(m.C?.on===0 && m.D?.on===0,'C and D — absent from the file — zeroed');
  ok((d.unbinned||[]).some(x=>x.sku==='B'&&x.qty===336),'the result names B as counted-but-unbinned');

  // Reversible.
  const list=(await fetch(B+'/api/putaway/imports?client='+encodeURIComponent(C),{headers:H}).then(r=>r.json())).rows||[];
  const mine=list.find(x=>x.filename==='MAYER 1-09-26.xlsx'&&!x.reversed_at);
  if(mine){
    const rv=await fetch(B+`/api/putaway/imports/${mine.id}/reverse`,{method:'POST',headers:{...H,'Content-Type':'application/json'},body:'{}'});
    ok(rv.ok,'reversible');
    ok(await total()===800,'undo restores the full 800');
  }
  console.log('\n'+(fails.length?`${fails.length} FAILED`:'ALL PASS'));
  process.exit(fails.length?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
