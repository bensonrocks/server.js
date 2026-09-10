// ZORT shaped as it is LIVE on a busy morning: four RTS'd orders, each with a
// print-page link from GetShipmentLabels — but only ONE of the print pages
// actually loads a PDF (the others are labels ZORT has not generated yet, so
// the viewer shows a page with no document). The PDF is served only to a
// browser holding the web-login session cookie.
const http = require('http'); const fs = require('fs');
const PORT = Number(process.argv[2] || 4792);
const PDF = fs.readFileSync(__dirname + '/lbl2-fixture5.pdf').toString('base64');
const TODAY = new Date().toISOString().slice(0, 10);
const line = [{ sku: 'LG-SKU', name: 'LG', number: 1 }];
// Outbox order follows pull order: the FIRST browser attempt of the run is a
// label with no PDF (the long-wait case), the second has one.
const O = [
  { number: 'LG-NOPDF1', id: 'g3', status: 'Waiting', trackingno: 'LZLG003', page: '/_empty' },
  { number: 'LG-PDF',    id: 'g2', status: 'Waiting', trackingno: 'LZLG002', page: '/_printpage' },
  { number: 'LG-NOPDF2', id: 'g4', status: 'Waiting', trackingno: 'LZLG004', page: '/_empty' },
  { number: 'LG-NOPDF3', id: 'g5', status: 'Waiting', trackingno: 'LZLG005', page: '/_empty' },
];
let hits = { printpage: 0, empty: 0, login: 0, labels: 0 };
const j = (res, b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
const row = o => ({ number: o.number, id: o.id, status: o.status, trackingno: o.trackingno, updated: TODAY, customername: 'LG', list: line });
const hasSess = req => /(^|;\s*)sess=1/.test(String(req.headers.cookie || ''));
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (p === '/_hits') return j(res, hits);
  if (p.endsWith('/Merchant/ValidateApi')) return j(res, { resCode: '200', resDesc: 'Success' });
  if (p.endsWith('/Order/GetOrders')) {
    const nl = String(req.headers.numberlist || '').trim();
    if (nl) { const w = new Set(nl.split(',').map(s => s.trim())); return j(res, { resCode: '200', list: O.filter(o => w.has(o.number)).map(row) }); }
    return j(res, { resCode: '200', list: Number(u.searchParams.get('page') || 1) > 1 ? [] : O.map(row) });
  }
  if (p.endsWith('/Order/GetOrderDetail')) { const o = O.find(x => x.id === u.searchParams.get('id')); return j(res, o ? { resCode: '200', ...row(o) } : { resCode: '200' }); }
  if (p.endsWith('/Order/GetShipmentLabels')) {
    const ids = String(req.headers.orderidlist || '').trim();
    hits.labels++;
    const o = O.find(x => ids.includes(x.id));
    if (o) return j(res, { resCode: '200', list: [{ linkurl: 'http://localhost:' + PORT + o.page + '?o=' + o.id, type: 'lazada', format: 'url', data: '', list: [] }] });
    return j(res, { resCode: '200', list: [] });
  }
  if (p.endsWith('/Order/GetOrderFiles')) return j(res, { resCode: '200', list: [] });
  if (p.endsWith('/Shipment/GetShipmentTransactions')) return j(res, { resCode: '200', list: [] });
  // ── the web side ──
  if (p === '/login') {
    if ([...u.searchParams.keys()].length) { hits.login++; res.writeHead(302, { 'set-cookie': 'sess=1; Path=/', location: '/dashboard' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!DOCTYPE html><html><body><form><input type="email" name="e"><input type="password" name="p"><button type="submit">Sign in</button></form></body></html>');
  }
  if (p === '/dashboard') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body><h1>NimbusTrade</h1></body></html>'); }
  if (p === '/_printpage') { hits.printpage++; res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body><script>document.write(\'<iframe src="/_pdf"></iframe>\')</script></body></html>'); }
  if (p === '/_empty') { hits.empty++; res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body><p>No shipping label has been generated for this order yet.</p><img src="/logo.png"></body></html>'); }
  if (p === '/_pdf') {
    if (!hasSess(req)) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body>Please sign in</body></html>'); }
    res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from(PDF, 'base64'));
  }
  if (p === '/logo.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(10)); }
  return j(res, { resCode: '200' });
}).listen(PORT, () => console.log('lag-mock on ' + PORT));
