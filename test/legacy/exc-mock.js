// A hub whose parcels come back. Two orders, each settable to any status.
const http = require('http');
const orders = {
  'EX-DONE': { id: 7001, number: 'EX-DONE', status: 'Success' },   // we shipped it
  'EX-OPEN': { id: 7002, number: 'EX-OPEN', status: 'Pending'  },   // we never did
};
const send = (res, x) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(x)); };
// Every call, so the test can prove a webhook read costs ONE and a sweep costs
// more. Reset with /__calls?reset=1.
let calls = []; let hook = '';
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (p === '/__calls') { if (u.searchParams.get('reset')) calls = []; return send(res, { calls }); }
  if (!p.startsWith('/__')) calls.push({ p, numberlist: req.headers.numberlist || '', updatedafter: u.searchParams.get('updatedafter') || '' });
  if (p === '/Webhook/UpdateWebhook') { hook = 'registered'; return send(res, { resCode: '200', resDesc: 'Success' }); }
  if (p === '/Webhook/GetWebhook') return send(res, { data: { url: hook } });
  if (p === '/__set') {                       // ?n=EX-DONE&s=Returned
    const o = orders[u.searchParams.get('n')];
    const want = u.searchParams.get('s');
    // An EMPTY s is a READ, not a set — the test helper used it to peek and
    // was wiping the status it wanted to check.
    if (o && want) o.status = want;
    return send(res, { ok: !!o, orders });
  }
  if (p === '/Merchant/ValidateApi') return send(res, { resCode: '200' });
  if (p === '/Order/GetOrders') {
    if (Number(u.searchParams.get('page') || 1) > 1) return send(res, { list: [] });
    const want = String(req.headers.numberlist || '').split(',').map(x => x.trim()).filter(Boolean);
    const pick = want.length ? Object.values(orders).filter(o => want.includes(o.number)) : Object.values(orders);
    return send(res, { list: pick.map(o => ({
      id: o.id, number: o.number, status: o.status, saleschannel: 'lazada', integrationName: 'lazada',
      orderdate: '2026-08-18T09:00:00', trackingno: 'TRK' + o.id,
      list: [{ sku: 'EX-SKU', name: 'Thing', number: 1 }] })) });
  }
  if (p === '/Order/GetOrderDetail') {
    const id = u.searchParams.get('id');
    const o = Object.values(orders).find(x => String(x.id) === String(id)) || {};
    return send(res, { order: { status: o.status, saleschannel: 'lazada', shippingchannel: 'lex' } });
  }
  if (p === '/Order/VoidOrder') {
    const id = u.searchParams.get('id');
    const o = Object.values(orders).find(x => String(x.id) === String(id));
    if (!o) return send(res, { resCode: '400', resDesc: 'not found' });
    if (o.status === 'Success' || o.status === 'Shipping') return send(res, { resCode: '400', resDesc: 'already shipped' });
    o.status = 'Voided';
    return send(res, { resCode: '200', resDesc: 'Success' });
  }
  if (p === '/Order/GetShipmentLabels') return send(res, { list: [] });
  send(res, {});
}).listen(4927, () => console.log('exc-mock on 4927'));
