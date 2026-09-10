// A hub whose one order gets courier-scanned mid-demo: PU-1 starts Pending
// (imported, picked and packed here), then /_ship flips it to Shipping with
// the hub's own shipped timestamp — exactly what a Lazada courier scan looks
// like from this side. Listens on 4928, where the ChaseCo store points.
const http = require('http');
const PORT = Number(process.argv[2] || 4928);

const TODAY = new Date().toISOString().slice(0, 10);
const order = {
  number: 'PU-1', id: 'zp1', status: 'Pending',
  trackingno: 'LZSGPU1000042', updated: TODAY,
  customername: 'Pickup Demo Customer',
  list: [{ sku: 'PU-SKU-1', name: 'Pickup Demo Widget', number: 1 }],
};

const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const row = () => ({ number: order.number, id: order.id, status: order.status,
  trackingno: order.trackingno, updated: order.updated, customername: order.customername,
  list: order.list, ...(order.shippingdate ? { shippingdate: order.shippingdate } : {}) });

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/_ship') {                              // ← the courier's scan
    order.status = 'Shipping';
    order.shippingdate = new Date().toISOString();
    order.updated = TODAY;
    return json(res, { ok: true, status: order.status });
  }
  if (p.endsWith('/Merchant/ValidateApi')) return json(res, { resCode: '200', resDesc: 'Success' });
  if (p.endsWith('/Order/GetOrders')) {
    const nl = String(req.headers.numberlist || '').trim();
    if (nl) {
      const want = new Set(nl.split(',').map(s => s.trim()));
      return json(res, { resCode: '200', list: want.has(order.number) ? [row()] : [] });
    }
    const page = Number(u.searchParams.get('page') || 1);
    return json(res, { resCode: '200', list: page > 1 ? [] : [row()] });
  }
  if (p.endsWith('/Order/GetOrderDetail')) return json(res, { resCode: '200', ...row() });
  if (p.endsWith('/Order/GetShipmentLabels')) return json(res, { resCode: '200', list: [] });
  return json(res, { resCode: '200' });
}).listen(PORT, () => console.log('pu-mock on ' + PORT));
