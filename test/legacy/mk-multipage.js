// A genuine Chromium-printed multi-page label PDF (pdf-lib output is unreadable by pdf-parse).
const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await b.newPage();
  const pages = [];
  for (let i = 1; i <= 12; i++) pages.push(`<div style="page-break-after:always;font-family:Arial;padding:30px"><h1>SPEEDY EXPRESS</h1><div style="font-size:26px">Tracking: LZSGD10${String(15000000 + i).slice(0)}</div><div style="font-size:18px">Order No: PERF-ORD-${String(i).padStart(3,'0')}</div><div style="margin-top:20px;font-size:14px">Deliver to: Test Customer ${i}, 12 Perf Road #0${i}-01, Singapore 60${String(9000+i)}</div><div style="margin-top:300px;font-size:12px">Page ${i} of 12</div></div>`);
  await p.setContent(`<html><body>${pages.join('')}</body></html>`);
  await p.pdf({ path: 'perf-12.pdf', format: 'A5' });
  await b.close();
  console.log('perf-12.pdf written');
})();
