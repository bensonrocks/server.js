// A hub that behaves like the reported one: orders arrive with NO tracking
// number, and the channel assigns it LATER — after we have already picked,
// packed and completed the order, and after the order has fallen out of the
// `updatedafter` window the scheduled pull looks back through.
const http = require('http');
const PORT = Number(process.argv[2] || 4928);

const ORDERS = [
  // number, status, tracking, updated (day string)
  { number: 'WB-1', id: 'z1', status: 'Pending', trackingno: '', updated: '2026-08-25' },
  { number: 'WB-2', id: 'z2', status: 'Pending', trackingno: '', updated: '2026-08-25' },
  // IMPORTS NORMALLY, then falls OUT of the window before its tracking is
  // assigned (see /_assign) — the real sequence behind "it is in ZORT but not
  // in IdealOne". Only a targeted read by order number can reach it after that.
  { number: 'WB-OLD', id: 'z9', status: 'Pending', trackingno: '', updated: '2026-08-25' },
  { number: 'WB-OLD2', id: 'z8', status: 'Pending', trackingno: '', updated: '2026-08-25' },
  // THE LIST NEVER CARRIES ITS TRACKING — only the order DETAIL does, and under
  // a nested Shipping container, which is how the hub's own screen shows it
  // (Shipping -> Tracking No.). detailOnly is honoured by row() below.
  { number: 'WB-DETAIL', id: 'z7', status: 'Pending', trackingno: '', updated: '2026-08-25', detailOnly: true },
  // AND ONE THE HUB DOES NOT ANSWER FOR AT ALL — the number we hold is not one
  // it recognises. No amount of retrying fixes that; it has to be reported.
  { number: 'WB-GHOST', id: 'z6', status: 'Pending', trackingno: '', updated: '2026-08-25', ghostAfter: true },
];
const lines = [{ sku: 'WB-SKU-1', name: 'Chase Test Widget', number: 1 }];

let state = 'no-tracking';   // flipped via /_assign
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const u = new URL(req.url, `http://x`);
  const p = u.pathname;

  // Test control: give every order its tracking number, as the channel would.
  if (p === '/_assign') {
    state = 'tracking';
    for (const o of ORDERS) o.trackingno = 'LZSGCHASE' + o.id.toUpperCase();
    // WB-OLD now sits outside the sweep's `updatedafter` window: the hub has
    // its tracking number and the scheduled list will never hand it back.
    // TWO of them, so the catch-up has to prove it asks for both in ONE call.
    for (const n of ['WB-OLD', 'WB-OLD2']) {
      const old = ORDERS.find(o => o.number === n);
      if (old) old.updated = '2026-07-01';
    }
    return json(res, { ok: true });
  }
  if (p === '/_calls') return json(res, { calls });

  calls.push(p + (u.search || '') + '|' + (req.headers.numberlist || ''));

  if (p.endsWith('/Merchant/ValidateApi')) return json(res, { resCode: '200', resDesc: 'Success' });
  if (p.endsWith('/Order/GetOrders')) {
    const nl = String(req.headers.numberlist || '').trim();
    if (nl) {
      // TARGETED READ — exact match on the numbers asked for, no date filter.
      const want = new Set(nl.split(',').map(s => s.trim()));
      return json(res, { resCode: '200', list: ORDERS
        .filter(o => want.has(o.number))
        .filter(o => !(o.ghostAfter && state === 'tracking'))     // stops answering to this number
        .map(o => (o.detailOnly ? { ...row(o), trackingno: '' } : row(o))) });
    }
    // THE SCHEDULED SWEEP — only orders updated on/after the given day.
    const after = u.searchParams.get('updatedafter') || '';
    const page = Number(u.searchParams.get('page') || 1);
    if (page > 1) return json(res, { resCode: '200', list: [] });
    return json(res, { resCode: '200', list: ORDERS
      .filter(o => !after || o.updated >= after)
      .filter(o => !(o.ghostAfter && state === 'tracking'))
      .map(o => (o.detailOnly ? { ...row(o), trackingno: '' } : row(o))) });
  }
  if (p.endsWith('/Order/GetOrderDetail')) {
    const id = u.searchParams.get('id');
    const o = ORDERS.find(x => x.id === id);
    if (!o) return json(res, { resCode: '200' });
    if (o.detailOnly) {
      // Tracking ONLY here, and nested — the shape the hub's screen implies.
      const { trackingno, ...rest } = row(o);
      return json(res, { resCode: '200', ...rest, shipping: { trackingno: o.trackingno } });
    }
    return json(res, { resCode: '200', ...row(o) });
  }
  if (p.endsWith('/Order/GetShipmentLabels')) return json(res, { resCode: '200', list: [] });
  return json(res, { resCode: '200' });
}).listen(PORT, () => console.log('wb-mock on ' + PORT));

const calls = [];
function row(o) {
  return { number: o.number, id: o.id, status: o.status, trackingno: o.trackingno,
           updated: o.updated, customername: 'Chase Customer', list: lines };
}
