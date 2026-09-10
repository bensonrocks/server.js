// Three stores' worth of behaviour on one hub, switchable: no label yet (the
// reported case), a PDF label, and an HTML one we cannot import.
const http = require('http');
let mode = 'none';
const o = { id: 9401, number: 'PB-1', status: 'Pending', channel: 'lazada' };
const send = (res, x) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(x)); };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (p === '/__mode') { mode = u.searchParams.get('m') || 'none'; return send(res, { ok: true, mode }); }
  if (p === '/Merchant/ValidateApi') return send(res, { resCode: '200' });
  if (p === '/Merchant/GetMerchantProfile') return send(res, { data: { name: 'Test Merchant' } });
  if (p === '/Order/GetOrders') {
    if (Number(u.searchParams.get('page') || 1) > 1) return send(res, { list: [] });
    return send(res, { list: [{ id: o.id, number: o.number, status: o.status, saleschannel: o.channel,
      integrationName: o.channel, orderdate: '2026-08-20T09:00:00', list: [{ sku: 'PB-SKU', name: 'Fan', number: 1 }] }] });
  }
  if (p === '/Order/GetOrderDetail') return send(res, { order: { status: o.status, saleschannel: o.channel, integrationName: o.channel, shippingchannel: 'lex' } });
  if (p === '/Order/GetShipmentLabels') {
    if (mode === 'none') return send(res, { list: [] });
    if (mode === 'html') return send(res, { list: [{ linkurl: '', type: 'lazada', Format: 'Html', Data: '<html>L</html>', list: [o.id] }] });
    return send(res, { list: [{ linkurl: 'https://x/label.pdf', type: 'lazada', Format: 'Pdf', Data: '', list: [o.id] }] });
  }
  send(res, {});
}).listen(4926, () => console.log('lblprobe-mock on 4926'));
