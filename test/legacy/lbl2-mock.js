// A hub whose GetShipmentLabels reply is shaped like NOTHING the old reader
// knew: rows under `shipmentlabellist` (not `list`), format under
// `FormatType`, bytes under `FileData`. The old reader returned [] for this
// and the label waited as "not generated yet" for ever — the reported bug.
// Order zl2 answers with NO row container at all (an object under
// `labelinfo`), which must be flagged with its key names, not waited on.
const http = require('http');
const fs = require('fs');
const PORT = Number(process.argv[2] || 4930);
const PDF_B64 = fs.readFileSync(__dirname + '/lbl2-fixture.pdf').toString('base64');
const PDF3_B64 = fs.readFileSync(__dirname + '/lbl2-fixture3.pdf').toString('base64');
const PDF4_B64 = fs.readFileSync(__dirname + '/lbl2-fixture4.pdf').toString('base64');
const PDF5_B64 = fs.readFileSync(__dirname + '/lbl2-fixture5.pdf').toString('base64');
const TODAY = new Date().toISOString().slice(0, 10);

const ORDERS = [
  { number: 'PLBL-1', id: 'zl1', status: 'Pending', trackingno: 'LZSGLBL0001' },
  { number: 'PLBL-2', id: 'zl2', status: 'Pending', trackingno: 'LZSGLBL0002' },
  // GetShipmentLabels answers EMPTY for this one — the label lives on the
  // order's FILE LIST, the way the hub's marketplace-label task stores it.
  { number: 'PLBL-3', id: 'zl3', status: 'Pending', trackingno: 'LZSGLBL0003' },
  { number: 'PLBL-4', id: 'zl4', status: 'Pending', trackingno: 'LZSGLBL0004' },
  { number: 'PLBL-5', id: 'zl5', status: 'Pending', trackingno: 'LZSGLBL0005' },
  { number: 'PLBL-6', id: 'zl6', status: 'Pending', trackingno: 'LZSGLBL0006' },
];
let invoiceFetches = 0;   // the invoice file must never be fetched
const lines = [{ sku: 'LBL-SKU-1', name: 'Label Test Widget', number: 1 }];
const row = o => ({ number: o.number, id: o.id, status: o.status, trackingno: o.trackingno,
  updated: TODAY, customername: 'Label Customer', list: lines });
const json = (res, body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p.endsWith('/Merchant/ValidateApi')) return json(res, { resCode: '200', resDesc: 'Success' });
  if (p.endsWith('/Order/GetOrders')) {
    const nl = String(req.headers.numberlist || '').trim();
    const page = Number(u.searchParams.get('page') || 1);
    if (nl) {
      const want = new Set(nl.split(',').map(s => s.trim()));
      return json(res, { resCode: '200', list: ORDERS.filter(o => want.has(o.number)).map(row) });
    }
    return json(res, { resCode: '200', list: page > 1 ? [] : ORDERS.map(row) });
  }
  if (p.endsWith('/Order/GetOrderDetail')) {
    const o = ORDERS.find(x => x.id === u.searchParams.get('id'));
    return json(res, o ? { resCode: '200', ...row(o) } : { resCode: '200' });
  }
  if (p.endsWith('/Order/GetShipmentLabels')) {
    const ids = String(req.headers.orderidlist || '').trim();
    if (ids.includes('zl2')) {
      // NO row container anywhere — the unshaped case.
      return json(res, { res: { resCode: '200', resDesc: '' }, labelinfo: { note: 'labels ready', version: 2 } });
    }
    if (ids.includes('zl5')) {
      // THE LIVE SHAPE EXACTLY: linkurl answers 200 text/html — the hub's own
      // print-viewer page, with the PDF one hop inside it.
      return json(res, { res: { resCode: '200' }, list: [{
        linkurl: 'http://localhost:' + PORT + '/_printpage', type: 'lazada', format: 'url', data: '', list: [],
      }] });
    }
    if (ids.includes('zl6')) {
      // Same shape, but the page is a SIGN-IN screen — the honest dead end.
      return json(res, { res: { resCode: '200' }, list: [{
        linkurl: 'http://localhost:' + PORT + '/_loginpage', type: 'lazada', format: 'url', data: '', list: [],
      }] });
    }
    if (ids.includes('zl4')) {
      // THE REPORTED LIVE SHAPE: type lazada, format url, keys
      // linkurl/type/list/data/format — with the real URL NESTED in `list`
      // and the top-level linkurl EMPTY.
      return json(res, { res: { resCode: '200' }, list: [{
        linkurl: '', type: 'lazada', format: 'url', data: '',
        list: [{ packageid: 'P1', url: 'http://localhost:' + PORT + '/_lazadalabel' }],
      }] });
    }
    if (ids.includes('zl3')) {
      // A genuinely empty label list — the marketplace label lives in FILES.
      return json(res, { res: { resCode: '200', resDesc: '' }, list: [] });
    }
    // The weird-but-real shape: unknown container + unknown field spellings.
    return json(res, { res: { resCode: '200', resDesc: '' },
      shipmentlabellist: [{ Type: 'lazada', FormatType: 'Pdf', FileData: PDF_B64, Ref: 'LZSGLBL0001' }] });
  }
  if (p.endsWith('/Order/GetOrderFiles')) {
    if (u.searchParams.get('id') !== 'zl3') return json(res, { res: { resCode: '200' }, list: [] });
    return json(res, { res: { resCode: '200' }, list: [
      { fileid: 1, filename: 'invoice-PLBL-3.pdf' },
      { fileid: 2, filename: 'lazada-shipping-label-PLBL-3.pdf' },
    ] });
  }
  if (p.endsWith('/Order/GetOrderFileDetail')) {
    const fid = u.searchParams.get('fileid');
    if (fid === '1') { invoiceFetches++; return json(res, { res: { resCode: '200' }, file: { url: 'http://localhost:' + PORT + '/_invoice' } }); }
    // The detail is JSON with the file's URL nested one level down.
    return json(res, { res: { resCode: '200' }, file: { name: 'lazada-shipping-label-PLBL-3.pdf', url: 'http://localhost:' + PORT + '/_labelfile' } });
  }
  if (p === '/_labelfile') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from(PDF3_B64, 'base64')); }
  if (p === '/_invoice') { invoiceFetches++; res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from(PDF_B64, 'base64')); }
  if (p === '/_printpage') {
    res.writeHead(200, { 'set-cookie': 'zortsess=abc123; Path=/', 'content-type': 'text/html' });
    return res.end('<!DOCTYPE html><html><head><title>Print</title></head><body><iframe src="/_realpdf?sig=xyz"></iframe></body></html>');
  }
  if (p === '/_realpdf') {
    if (String(req.headers.cookie || '').indexOf('zortsess=abc123') < 0) { res.writeHead(403); return res.end('no session'); }
    res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from(PDF5_B64, 'base64'));
  }
  if (p === '/_loginpage') {
    // A SPA print shell: two label-ish script links, neither a PDF — the
    // exact "2 link(s) inside" live shape.
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!DOCTYPE html><html><head></head>'
      + '<body><div id="app"></div><a href="/app/label-viewer">view</a><a href="/app/print-download?id=1">dl</a></body></html>');
  }
  if (p === '/app/print-download') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('denied'); }
  if (p === '/app/label-viewer') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body>viewer</body></html>'); }
  if (p === '/_lazadalabel') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from(PDF4_B64, 'base64')); }
  if (p === '/_stats') return json(res, { invoiceFetches });
  if (p.endsWith('/Shipment/GetShipmentTransactions')) return json(res, { res: { resCode: '200' }, list: [] });
  // The undocumented file endpoint refuses, as it does on the live account.
  if (/GetShipmentLabelFile/.test(p)) return json(res, { resCode: '100', resDesc: 'Invalid ID.' });
  return json(res, { resCode: '200' });
}).listen(PORT, () => console.log('lbl2-mock on ' + PORT));
