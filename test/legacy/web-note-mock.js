// ZORT shaped as it is LIVE for a Lazada label: the API's GetShipmentLabels
// hands out a link to a print-viewer PAGE; the PDF that page loads is served
// ONLY to a browser holding the web-login session cookie. The API path can
// follow the page's link but gets 403 — so only the browser worker can pull.
const http = require('http'); const fs = require('fs');
const PORT = Number(process.argv[2] || 4782);
const PDF = fs.readFileSync(__dirname + '/lbl2-fixture5.pdf').toString('base64');
const TODAY = new Date().toISOString().slice(0, 10);
const line = [{ sku: 'WT-SKU', name: 'WT', number: 1 }];
const O = [
  { number: 'WT-PEND', id: 'w1', status: 'Pending', trackingno: '' },
  { number: 'WT-RTS',  id: 'w2', status: 'Waiting', trackingno: 'LZWT002' },
];
const j = (res, b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
const row = o => ({ number: o.number, id: o.id, status: o.status, trackingno: o.trackingno, updated: TODAY, customername: 'WT', list: line });
const hasSess = req => /(^|;\s*)sess=1/.test(String(req.headers.cookie || ''));
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (p.endsWith('/Merchant/ValidateApi')) return j(res, { resCode: '200', resDesc: 'Success' });
  if (p.endsWith('/Order/GetOrders')) {
    const nl = String(req.headers.numberlist || '').trim();
    if (nl) { const w = new Set(nl.split(',').map(s => s.trim())); return j(res, { resCode: '200', list: O.filter(o => w.has(o.number)).map(row) }); }
    return j(res, { resCode: '200', list: Number(u.searchParams.get('page') || 1) > 1 ? [] : O.map(row) });
  }
  if (p.endsWith('/Order/GetOrderDetail')) { const o = O.find(x => x.id === u.searchParams.get('id')); return j(res, o ? { resCode: '200', ...row(o) } : { resCode: '200' }); }
  if (p.endsWith('/Order/GetShipmentLabels')) {
    const ids = String(req.headers.orderidlist || '').trim();
    if (ids.includes('w2')) return j(res, { resCode: '200', list: [{ linkurl: 'http://localhost:' + PORT + '/_printpage', type: 'lazada', format: 'url', data: '', list: [] }] });
    return j(res, { resCode: '200', list: [] });
  }
  if (p.endsWith('/Order/GetOrderFiles')) return j(res, { resCode: '200', list: [] });
  if (p.endsWith('/Shipment/GetShipmentTransactions')) return j(res, { resCode: '200', list: [] });
  // ── the web side ──
  if (p === '/login') {
    // A submitted form (the generic fill presses submit → GET with the fields)
    // signs the browser in; a bare GET is the sign-in page.
    if ([...u.searchParams.keys()].length) { res.writeHead(302, { 'set-cookie': 'sess=1; Path=/', location: '/dashboard' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!DOCTYPE html><html><body><form><input type="email" name="e"><input type="password" name="p"><button type="submit">Sign in</button></form></body></html>');
  }
  if (p === '/dashboard') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body><h1>NimbusTrade</h1></body></html>'); }
  if (p === '/_printpage') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body><script>document.write(\'<iframe src="/_pdf"></iframe>\')</script></body></html>'); }
  if (p === '/_pdf') {
    if (!hasSess(req)) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body>Please sign in</body></html>'); }
    res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from(PDF, 'base64'));
  }
  return j(res, { resCode: '200' });
}).listen(PORT, () => console.log('web-note-mock on ' + PORT));
