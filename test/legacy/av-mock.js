// Two orders, one unit of stock — first come, first served.
const http = require('http');
const PORT = Number(process.argv[2] || 4931);
const TODAY = new Date().toISOString().slice(0, 10);
const lines = [{ sku: 'AV-SKU', name: 'Avail Test Widget', number: 1 }];
const ORDERS = [
  { number: 'AV-FIRST',  id: 'av1', status: 'Pending', trackingno: 'LZAV0001' },
  { number: 'AV-SECOND', id: 'av2', status: 'Pending', trackingno: 'LZAV0002' },
];
const json = (res, b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
const row = o => ({ number: o.number, id: o.id, status: o.status, trackingno: o.trackingno,
  updated: TODAY, customername: 'Avail Customer', list: lines });
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (p.endsWith('/Merchant/ValidateApi')) return json(res, { resCode: '200', resDesc: 'Success' });
  if (p.endsWith('/Order/GetOrders')) {
    const nl = String(req.headers.numberlist || '').trim();
    if (nl) { const w = new Set(nl.split(',').map(s => s.trim())); return json(res, { resCode: '200', list: ORDERS.filter(o => w.has(o.number)).map(row) }); }
    return json(res, { resCode: '200', list: Number(u.searchParams.get('page') || 1) > 1 ? [] : ORDERS.map(row) });
  }
  if (p.endsWith('/Order/GetOrderDetail')) { const o = ORDERS.find(x => x.id === u.searchParams.get('id')); return json(res, o ? { resCode: '200', ...row(o) } : { resCode: '200' }); }
  if (p.endsWith('/Order/GetShipmentLabels')) return json(res, { resCode: '200', list: [] });
  return json(res, { resCode: '200' });
}).listen(PORT, () => console.log('av-mock on ' + PORT));
