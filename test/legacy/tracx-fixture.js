// Builds the 3-page TracXLogis-shaped label PDF the Auto Match suite runs on.
//
// PRINTED THROUGH HEADLESS CHROMIUM, never pdf-lib: this repo's pdf-parse
// cannot read a pdf-lib document ("bad XRef entry"), and a fixture the reader
// chokes on proves nothing about the reader. And NOT a real carrier label —
// those carry a customer's name and address and must never be committed.
//
// The three pages are the three shapes the report covers:
//   1. SPLIT CAPTION — the tracking number typeset in groups, `QSP22214 1513`,
//      so it comes off the text layer as two positioned runs. This is the
//      reported page: it HAS text, and every contiguous pattern misses it.
//   2. IMAGE-ONLY CAPTION — the same number drawn into a bitmap, with ordinary
//      text everywhere else on the page. The text layer is real and carries no
//      identifier, which is why the old "OCR only when there is no text at
//      all" gate could never reach it.
//   3. CONTROL — a plain contiguous tracking number that has always worked, so
//      a regression in the ordinary path shows up here.
const fs = require('fs');
const path = require('path');

// The caption as a bitmap, so page 2's identifier is genuinely not on the text
// layer. Big and black-on-white — this is what Tesseract has to read.
function captionPng(text) {
  let canvasLib = null;
  try { canvasLib = require('@napi-rs/canvas'); } catch { return null; }
  const W = 900, H = 150;
  const cv = canvasLib.createCanvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 86px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 30, H / 2);
  return 'data:image/png;base64,' + cv.toBuffer('image/png').toString('base64');
}

function pageHtml({ heading, captionHtml, consignee, postal, ref }) {
  return `
  <section class="lbl">
    <div class="hdr">${heading}</div>
    <div class="bars">${'<i></i>'.repeat(46)}</div>
    <div class="cap">${captionHtml}</div>
    <div class="blk"><b>Deliver To:</b><br>${consignee}<br>Blk 000 Test Industrial Park<br>Singapore ${postal}</div>
    <div class="blk"><b>From:</b> IDEALONE FULFILMENT</div>
    <div class="foot">Service: NEXT DAY &nbsp;·&nbsp; Pieces: 1 &nbsp;·&nbsp; Ref ${ref}</div>
  </section>`;
}

async function buildTracxPdf(outFile) {
  const { chromium } = require('playwright');
  const png = captionPng('QSP22214 7788');
  if (!png) throw new Error('@napi-rs/canvas unavailable — cannot build the image-only page');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 100mm 150mm; margin: 0 }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; }
    .lbl { width: 100mm; height: 150mm; box-sizing: border-box; padding: 6mm; page-break-after: always; }
    .hdr { font-size: 15pt; font-weight: 800; letter-spacing: 1px; }
    .bars { margin: 5mm 0 2mm; height: 18mm; display: flex; gap: 1.1px; }
    .bars i { display: block; width: 1.4px; height: 100%; background: #000; }
    .bars i:nth-child(3n) { width: 3.2px }
    .cap { font-size: 17pt; font-weight: 700; letter-spacing: 2px; margin-bottom: 5mm }
    /* THE SPLIT: two positioned runs with a space between them, which is how
       the real label typesets the number and why the text layer yields
       "QSP22214 1513" rather than one token. */
    .cap span { display: inline-block; }
    .cap img { height: 11mm; }
    .blk { font-size: 9.5pt; line-height: 1.45; margin-bottom: 4mm }
    .foot { font-size: 8pt; color: #333; margin-top: 3mm }
  </style></head><body>
  ${pageHtml({
    heading: 'TracXLogis',
    captionHtml: '<span>QSP22214</span> <span>1513</span>',
    consignee: 'TEST CONSIGNEE ONE', postal: '520123', ref: 'A1',
  })}
  ${pageHtml({
    heading: 'TracXLogis',
    captionHtml: `<img src="${png}" alt="">`,
    consignee: 'TEST CONSIGNEE TWO', postal: '520124', ref: 'A2',
  })}
  ${pageHtml({
    heading: 'TracXLogis',
    captionHtml: '<span>QSP222149999</span>',
    consignee: 'TEST CONSIGNEE THREE', postal: '520125', ref: 'A3',
  })}
  </body></html>`;

  // Playwright resolves headless to chrome-headless-shell, which this sandbox
  // does not ship — the same escape hatch the ZORT worker and the browser
  // suites use.
  const exe = process.env.TEST_CHROMIUM || '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(exe) ? { executablePath: exe } : {});
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: outFile, width: '100mm', height: '150mm', printBackground: true });
  await browser.close();
  return outFile;
}

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, 'tracx-fixture.pdf');
  buildTracxPdf(out).then(() => {
    console.log('wrote ' + out + ' (' + fs.statSync(out).size + ' bytes)');
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { buildTracxPdf };
