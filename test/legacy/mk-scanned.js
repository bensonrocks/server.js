// An IMAGE-ONLY 3-page label PDF (no text layer): each page is a PNG of a
// rendered label, printed through Chromium — the shape of a scanned AWB.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const pool = require('/home/user/server.js/lib/pdf-pool');
const fs = require('fs');
(async () => {
  const src = fs.readFileSync('perf-12.pdf');
  const imgs = [];
  for (const i of [0, 1, 2]) imgs.push('data:image/png;base64,' + (await pool.render(src, i, 2)).toString('base64'));
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await b.newPage();
  await p.setContent(`<html><body style="margin:0">${imgs.map(u => `<div style="page-break-after:always"><img src="${u}" style="width:100%"></div>`).join('')}</body></html>`);
  await p.pdf({ path: 'perf-scan3.pdf', format: 'A5' });
  await b.close();
  const texts = await pool.pageTexts(fs.readFileSync('perf-scan3.pdf'));
  console.log('pages', texts.length, 'text layer chars:', texts.map(t => t.trim().length).join(','));
  process.exit(0);
})();
