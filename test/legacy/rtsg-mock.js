const http=require('http'); const fs=require('fs');
const PORT=Number(process.argv[2]||4933);
const PDF=fs.readFileSync(__dirname+'/rg-rts.pdf').toString('base64');
const TODAY=new Date().toISOString().slice(0,10);
const line=[{sku:'RG-SKU',name:'RTS Gate Widget',number:1}];
// status: Waiting = RTS'd. Pending = not. 
const O=[
  {number:'RG-RTS',   id:'r1', status:'Waiting', trackingno:'LZRG0001'}, // RTS'd + in stock -> fetch, has label
  {number:'RG-PEND',  id:'r2', status:'Pending', trackingno:'LZRG0002'}, // not RTS'd -> skip
  {number:'RG-SHORT', id:'r3', status:'Waiting', trackingno:'LZRG0003'}, // RTS'd but WE see no stock -> skip on stock
  {number:'RG-NOLBL', id:'r4', status:'Waiting', trackingno:'LZRG0004'}, // RTS'd + in stock but label empty -> waiting
];
const j=(res,b)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(b));};
const row=o=>({number:o.number,id:o.id,status:o.status,trackingno:o.trackingno,updated:TODAY,customername:'RG',list:o.number==='RG-SHORT'?[{sku:'RG-MISSING',name:'Unstocked',number:1}]:line});
http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x');const p=u.pathname;
  if(p.endsWith('/Merchant/ValidateApi'))return j(res,{resCode:'200',resDesc:'Success'});
  if(p.endsWith('/Order/GetOrders')){
    const nl=String(req.headers.numberlist||'').trim();
    if(nl){const w=new Set(nl.split(',').map(s=>s.trim()));return j(res,{resCode:'200',list:O.filter(o=>w.has(o.number)).map(row)});}
    return j(res,{resCode:'200',list:Number(u.searchParams.get('page')||1)>1?[]:O.map(row)});
  }
  if(p.endsWith('/Order/GetOrderDetail')){const o=O.find(x=>x.id===u.searchParams.get('id'));return j(res,o?{resCode:'200',...row(o)}:{resCode:'200'});}
  if(p.endsWith('/Order/GetShipmentLabels')){
    const ids=String(req.headers.orderidlist||'').trim();
    if(ids.includes('r1'))return j(res,{resCode:'200',shipmentlabellist:[{Type:'lazada',FormatType:'Pdf',FileData:PDF}]});
    return j(res,{resCode:'200',list:[]}); // r4 (and anything) -> empty
  }
  if(p.endsWith('/Order/GetOrderFiles'))return j(res,{resCode:'200',list:[]});
  if(p.endsWith('/Shipment/GetShipmentTransactions'))return j(res,{resCode:'200',list:[]});
  return j(res,{resCode:'200'});
}).listen(PORT,()=>console.log('rtsg-mock on '+PORT));
