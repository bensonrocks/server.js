// ZORT v4 mock for the bundle-cancel fix: orders can be added mid-test via
// POST /__ctl/add, so the suite can pull some orders BEFORE a bundle recipe
// exists and some AFTER — the exact timeline that produced the live cancels.
const http = require('http');
const PORT = Number(process.argv[2] || 4790);
const TODAY = new Date().toISOString().slice(0, 10);
const orders = [];
let nextId = 1;
const j = (res, b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  let body = ''; for await (const c of req) body += c;
  if (p === '/__ctl/add') {
    const o = JSON.parse(body || '{}');
    orders.push({ id: 'zo' + (nextId++), status: 'Pending', updated: TODAY, customername: 'Test Buyer', ...o });
    return j(res, { ok: true });
  }
  if (p.endsWith('/Merchant/ValidateApi')) return j(res, { resCode: '200', resDesc: 'Success' });
  if (p.endsWith('/Merchant/GetSalesChannels')) return j(res, { resCode: '200', list: [] });
  if (p.endsWith('/Order/GetOrders')) {
    const nl = String(req.headers.numberlist || '').trim();
    if (nl) { const want = new Set(nl.split(',').map(s => s.trim())); return j(res, { resCode: '200', list: orders.filter(o => want.has(o.number)) }); }
    const page = Number(u.searchParams.get('page') || 1);
    return j(res, { resCode: '200', list: page > 1 ? [] : orders });
  }
  if (p.endsWith('/Order/GetOrderDetail')) {
    const o = orders.find(x => x.id === u.searchParams.get('id'));
    return j(res, o ? { resCode: '200', ...o } : { resCode: '200' });
  }
  return j(res, { resCode: '200' });
}).listen(PORT, () => console.log('bfix-mock on ' + PORT));
