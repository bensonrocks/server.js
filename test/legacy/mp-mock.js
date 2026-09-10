// A hub reproducing the 170217257037005 shape: ZORT's own status NEVER moves
// for a marketplace-side cancellation — only integrationStatus says it.
// /_cancel?n=MP-OPEN flips that order's marketplace status to cancelled while
// ZORT's own word stays exactly where it was.
const http = require('http');
const PORT = Number(process.argv[2] || 4928);
const TODAY = new Date().toISOString().slice(0, 10);

const ORDERS = [
  // Arrives ALREADY cancelled on the marketplace — must never import.
  { number: 'MP-NEW',   id: 'm1', status: 'Pending', integrationStatus: 'Cancelled' },
  // Imports clean; cancelled later while still untouched here (lowercase key
  // on purpose — the reader must cover both spellings).
  { number: 'MP-OPEN',  id: 'm2', status: 'Pending', lowerKey: true },
  // Imports clean; packed and completed here BEFORE the marketplace cancels —
  // the 170217257037005 case. ZORT's own status even reads "success".
  { number: 'MP-DONE',  id: 'm3', status: 'Pending' },
  // Never cancelled anywhere — the control.
  { number: 'MP-PLAIN', id: 'm4', status: 'Pending' },
];
const lines = [{ sku: 'MP-SKU-1', name: 'Marketplace Cancel Widget', number: 2 }];

const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
function row(o) {
  const base = { number: o.number, id: o.id, status: o.status, trackingno: 'LZSG' + o.id.toUpperCase() + '0001',
    updated: TODAY, customername: 'MP Customer', list: lines };
  if (o.cancelledNow || o.integrationStatus) {
    const word = o.integrationStatus || 'canceled';
    if (o.lowerKey) base.integrationstatus = word; else base.integrationStatus = word;
  }
  return base;
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/_cancel') {                      // the marketplace-side cancel
    const o = ORDERS.find(x => x.number === u.searchParams.get('n'));
    if (o) { o.cancelledNow = true; if (u.searchParams.get('success')) o.status = 'Success'; }
    return json(res, { ok: !!o });
  }
  if (p.endsWith('/Merchant/ValidateApi')) return json(res, { resCode: '200', resDesc: 'Success' });
  if (p.endsWith('/Order/GetOrders')) {
    const nl = String(req.headers.numberlist || '').trim();
    if (nl) {
      const want = new Set(nl.split(',').map(s => s.trim()));
      return json(res, { resCode: '200', list: ORDERS.filter(o => want.has(o.number)).map(row) });
    }
    const page = Number(u.searchParams.get('page') || 1);
    return json(res, { resCode: '200', list: page > 1 ? [] : ORDERS.map(row) });
  }
  if (p.endsWith('/Order/GetOrderDetail')) {
    const o = ORDERS.find(x => x.id === u.searchParams.get('id'));
    return json(res, o ? { resCode: '200', ...row(o) } : { resCode: '200' });
  }
  if (p.endsWith('/Order/GetShipmentLabels')) return json(res, { resCode: '200', list: [] });
  return json(res, { resCode: '200' });
}).listen(PORT, () => console.log('mp-mock on ' + PORT));
