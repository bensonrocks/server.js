// fetchLabelPdf hands back EVERY distinct label row, not just the first — the
// split-order case at the API level. Mock hub: GetShipmentLabels lists three
// Pdf rows — box 1, box 2, and box 1 again.
const http = require('http'); const fs = require('fs');
const { PDFDocument } = require('/home/user/server.js/node_modules/pdf-lib');
const zort = require('/home/user/server.js/lib/zort.js');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const src = await PDFDocument.load(fs.readFileSync('/root/.claude/uploads/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/71fbf9ce-DisplayPdfByUrl_42.pdf'));
  const pageBuf = async i => { const d = await PDFDocument.create(); const [p] = await d.copyPages(src, [i]); d.addPage(p); return Buffer.from(await d.save()); };
  const box1 = await pageBuf(0), box2 = await pageBuf(1);
  const calls = [];
  const srv = http.createServer((req, res) => {
    calls.push(req.method + ' ' + req.url);
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (/GetShipmentLabels/i.test(req.url)) {
        return res.end(JSON.stringify({ resCode: 200, list: [
          { Format: 'Pdf', FileData: box1.toString('base64'), type: 'lazada' },
          { Format: 'Pdf', FileData: box2.toString('base64'), type: 'lazada' },
          { Format: 'Pdf', FileData: box1.toString('base64'), type: 'lazada' },   // the same label listed twice
        ] }));
      }
      res.end(JSON.stringify({ resCode: 200, list: [] }));
    });
  });
  await new Promise(r => srv.listen(4765, r));
  const store = { id: 's1', storename: 'x', apikey: 'k', apisecret: 's', endpoint: 'http://localhost:4765/v4' };
  const got = await zort.fetchLabelPdf(store, { id: 42, number: '171067267872131', skipFileEndpoint: true });
  ok(got && got.pdf && got.pdf.equals(box1), `first row is the answer (${got && got.via})`);
  ok(Array.isArray(got.more) && got.more.length === 1, `exactly ONE further parcel rides along (${got && got.more && got.more.length})`);
  ok(got.more && got.more[0] && got.more[0].pdf.equals(box2), 'and it is box 2, not box 1 again');
  // single-row hub: no `more` at all, exactly as before
  srv.removeAllListeners('request');
  srv.on('request', (req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ resCode: 200, list: /GetShipmentLabels/i.test(req.url) ? [{ Format: 'Pdf', FileData: box2.toString('base64') }] : [] })); }); });
  const one = await zort.fetchLabelPdf(store, { id: 43, skipFileEndpoint: true });
  ok(one && one.pdf && one.pdf.equals(box2) && !one.more, 'a one-label order answers exactly as before (no more[])');
  srv.close();
  console.log(fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'); process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
