// ZORT AS IT WAS ON THE REPORTED MORNING: four orders, all Ready-to-Ship
// ("Waiting" — RTS'd, which is where a marketplace AWB is minted and the state
// these orders were imported in), and ZORT GENUINELY HAS ALL FOUR LABELS —
// GetShipmentLabels hands back a `lazada` / `format: url` row whose linkurl is
// a print-VIEWER page, and every one of those pages really does load a PDF
// once the browser holds the web-login session cookie.
//
// That is the whole point of this fixture: nothing here is missing, refused or
// slow at the channel's end. Anything that does not come in is ours.
//
// The print page is DELIBERATELY SLOW (SLOW_MS) so a background drain pass is
// genuinely still in flight when 🏷 Get Labels runs — which is the collision
// that made the button report "still queued" about labels it had never asked
// about.
const http = require('http'); const fs = require('fs');
const PORT = Number(process.argv[2] || 4794);
const SLOW_MS = Number(process.argv[3] || 1200);
const PDF = fs.readFileSync(__dirname + '/lbl2-fixture5.pdf');
const TODAY = new Date().toISOString().slice(0, 10);
const line = [{ sku: 'GL-SKU', name: 'Mayer 1.0L Rice Cooker', number: 1 }];
const O = [
  { number: 'GL-1001', id: 'q1', status: 'Waiting', trackingno: 'LZSGD1015518443' },
  { number: 'GL-1002', id: 'q2', status: 'Waiting', trackingno: 'LZSGD1015518590' },
  { number: 'GL-1003', id: 'q3', status: 'Waiting', trackingno: 'LZSGD1015518347' },
  { number: 'GL-1004', id: 'q4', status: 'Waiting', trackingno: 'LZSGD1015518534' },
];
// Every hub call is counted, so "did the cooled tap cost another relay?" is
// measured rather than reasoned about.
const hits = { getorders: 0, detail: 0, labels: 0, printpage: 0, pdf: 0, login: 0, updatestatus: 0 };
const j = (res, b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
const row = o => ({ number: o.number, id: o.id, status: o.status, trackingno: o.trackingno, updated: TODAY, customername: 'Yan Yan', list: line });
const hasSess = req => /(^|;\s*)sess=1/.test(String(req.headers.cookie || ''));

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (p === '/_hits') return j(res, hits);
  if (p === '/_reset') { for (const k of Object.keys(hits)) hits[k] = 0; return j(res, { ok: true }); }
  if (p.endsWith('/Merchant/ValidateApi')) return j(res, { resCode: '200', resDesc: 'Success' });
  if (p.endsWith('/Order/GetOrders')) {
    hits.getorders++;
    const nl = String(req.headers.numberlist || '').trim();
    if (nl) { const w = new Set(nl.split(',').map(s => s.trim())); return j(res, { resCode: '200', list: O.filter(o => w.has(o.number)).map(row) }); }
    return j(res, { resCode: '200', list: Number(u.searchParams.get('page') || 1) > 1 ? [] : O.map(row) });
  }
  if (p.endsWith('/Order/GetOrderDetail')) {
    hits.detail++;
    const o = O.find(x => x.id === u.searchParams.get('id'));
    return j(res, o ? { resCode: '200', ...row(o) } : { resCode: '200' });
  }
  if (p.endsWith('/Order/UpdateOrderStatus')) { hits.updatestatus++; return j(res, { resCode: '200', resDesc: 'Success' }); }
  if (p.endsWith('/Order/GetShipmentLabels')) {
    hits.labels++;
    const ids = String(req.headers.orderidlist || '').trim();
    const o = O.find(x => ids.includes(x.id));
    if (o) return j(res, { resCode: '200', list: [{ linkurl: `http://localhost:${PORT}/_print?o=${o.id}`, type: 'lazada', format: 'url', data: '', list: [] }] });
    return j(res, { resCode: '200', list: [] });
  }
  if (p.endsWith('/Order/GetOrderFiles')) return j(res, { resCode: '200', list: [] });
  if (p.endsWith('/Shipment/GetShipmentTransactions')) return j(res, { resCode: '200', list: [] });

  // ── the web side: a signed-in print viewer that really has the PDF ──
  if (p === '/login') {
    if ([...u.searchParams.keys()].length) { hits.login++; res.writeHead(302, { 'set-cookie': 'sess=1; Path=/', location: '/dashboard' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!DOCTYPE html><html><body><form><input type="email" name="e"><input type="password" name="p"><button type="submit">Sign in</button></form></body></html>');
  }
  if (p === '/dashboard') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body><h1>ZortMock</h1></body></html>'); }
  if (p === '/_print') {
    hits.printpage++;
    const o = u.searchParams.get('o') || '';
    res.writeHead(200, { 'content-type': 'text/html' });
    // Script shell, exactly like the live viewer — the PDF arrives after a beat.
    return res.end(`<!DOCTYPE html><html><body><script>setTimeout(function(){document.write('<iframe src="/_pdf?o=${o}"></iframe>')}, ${SLOW_MS})</script></body></html>`);
  }
  if (p === '/_pdf') {
    if (!hasSess(req)) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body>Please sign in</body></html>'); }
    hits.pdf++;
    res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(PDF);
  }
  return j(res, { resCode: '200' });
}).listen(PORT, () => console.log('getlabels-mock on ' + PORT));
