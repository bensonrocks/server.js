// Builds the two PDFs the TracX-consignee suite runs on — PRINTED THROUGH
// HEADLESS CHROMIUM, like tracx-fixture.js, because this repo's pdf-parse
// cannot read a pdf-lib document. Both are invented: the picking list carries
// no person's address, the label no real consignee.
//
//   1. A Keyfields-style PICKING LIST, laid out the way the photo is: the
//      TracX waybill in the "Consignee" box, the buyer's name in "Consignee
//      Address", the marketplace id in "Reference". Its item lines are
//      printed as single runs so pdf-parse hands the parser the concatenated
//      shape it is tuned for ({batch}{location}{sno}{sku}).
//   2. A 3-page TRACX LABEL: page 1 prints the waybill above, page 2 prints
//      ONLY the marketplace id (a page whose tracking OCR'd badly), page 3
//      a waybill nothing here holds — the control that must stay unmatched.
const fs = require('fs');
const path = require('path');

const PICK = {
  gi: 'GI-900001', ticket: '556999', ref: '173100000000123',
  waybill: 'TXSGD09000123', buyer: 'TEST BUYER', account: 'BETIME ECOM',
  lines: [
    { sno: 1, loc: 'AC-004-001-C', sku: 'NX4664', desc: 'Nuxe Hair Prodigieux High Shine Conditioner 200ml', batch: 'RT' },
    { sno: 2, loc: 'AC-006-004-A', sku: '5602',   desc: 'Nuxe RDM F and B Ultra-rich Clnsg Gel 400ml - 5602', batch: 'N125J056' },
  ],
};
const LABEL_STRAY = 'TXSGD09999999';

async function buildPicklistPdf(outFile) {
  const { chromium } = require('playwright');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 12mm }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt }
    .t { font-size: 16pt; font-weight: 800; text-align: center; margin: 4mm 0 }
    .hdr div { margin: 0 0 1.2mm }
    .item { margin-top: 3mm }
    .item div { margin: 0 }
  </style></head><body>
    <div class="t">Picking List</div>
    <!-- One token per line, in the READING ORDER the page parser documents for
         the real Keyfields file: labels and values on separate lines; the
         right-hand column's value lands BEFORE its label for Reference and PO
         Number, and the Consignee box follows the same column — so the
         waybill sits on the line before "Consignee" and the buyer's name on
         the line before "Consignee Address". -->
    <div class="hdr">
      <div>Issue No</div><div>${PICK.gi}</div>
      <div>Pick Ticket</div><div>${PICK.ticket}</div>
      <div>Account</div><div>${PICK.account}</div>
      <div>${PICK.ref}</div><div>Reference</div>
      <div>Delivery Date</div><div>21/Sep/2026</div>
      <div>PO Number</div>
      <div>Status</div><div>35-Pick in Progress</div>
      <div>${PICK.waybill}</div><div>Consignee</div>
      <div>${PICK.buyer}</div><div>Consignee Address</div>
    </div>
    <div style="margin-top:6mm;font-weight:700">SNo Location Sku Sku Description WholeUom LooseUom Total LHU BatchNo/LotNo</div>
    ${PICK.lines.map(l => `
    <div class="item">
      <div>${l.batch}${l.loc}${l.sno}${l.sku}</div>
      <div>${l.desc}</div>
      <div>CARTON 1 1EACH</div>
    </div>`).join('')}
    <div style="margin-top:8mm">Total Whole Qty : ${PICK.lines.length}</div>
    <div>Remarks: TracX Logis</div>
  </body></html>`;
  await printHtml(html, outFile, { format: 'A4' });
  return outFile;
}

function labelPage(caption, sub) {
  return `<section class="lbl">
    <div class="hdr">TracXLogis</div>
    <div class="bars">${'<i></i>'.repeat(46)}</div>
    <div class="cap">${caption}</div>
    <div class="blk">${sub}</div>
    <div class="blk"><b>Deliver To:</b><br>TEST CONSIGNEE<br>Blk 000 Test Industrial Park<br>Singapore 520123</div>
    <div class="blk"><b>From:</b> IDEALONE FULFILMENT</div>
  </section>`;
}

async function buildLabelPdf(outFile) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 100mm 150mm; margin: 0 }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; }
    .lbl { width: 100mm; height: 150mm; box-sizing: border-box; padding: 6mm; page-break-after: always; }
    .hdr { font-size: 15pt; font-weight: 800; letter-spacing: 1px; }
    .bars { margin: 5mm 0 2mm; height: 18mm; display: flex; gap: 1.1px; }
    .bars i { display: block; width: 1.4px; height: 100%; background: #000; }
    .bars i:nth-child(3n) { width: 3.2px }
    .cap { font-size: 17pt; font-weight: 700; letter-spacing: 2px; margin-bottom: 4mm }
    .blk { font-size: 9.5pt; line-height: 1.45; margin-bottom: 4mm }
  </style></head><body>
    ${labelPage(PICK.waybill, 'Service: Standard')}
    ${labelPage('&nbsp;', `Order No. ${PICK.ref}`)}
    ${labelPage(LABEL_STRAY, 'Order No. 173100000000999')}
  </body></html>`;
  await printHtml(html, outFile, { width: '100mm', height: '150mm' });
  return outFile;
}

async function printHtml(html, outFile, size) {
  const { chromium } = require('playwright');
  const exe = process.env.TEST_CHROMIUM || '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(exe) ? { executablePath: exe } : {});
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: outFile, printBackground: true, ...size });
  await browser.close();
}

if (require.main === module) {
  const dir = __dirname;
  Promise.all([
    buildPicklistPdf(path.join(dir, 'tracx-picklist-fixture.pdf')),
    buildLabelPdf(path.join(dir, 'tracx-label2-fixture.pdf')),
  ]).then(fs2 => { for (const f of fs2) console.log('wrote ' + f + ' (' + fs.statSync(f).size + ' bytes)'); })
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { buildPicklistPdf, buildLabelPdf, PICK, LABEL_STRAY };
