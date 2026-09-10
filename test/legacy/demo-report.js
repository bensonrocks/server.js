// Drive the CLIENT PORTAL in a real browser: sign in, open Orders, press
// ⬇ Report, take the workbook the browser actually downloads, and render its
// tabs so the new Order lines sheet can be seen.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const fs = require('fs');
const BASE = 'http://localhost:4636';
const OUT = __dirname;

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 160)));

  await p.goto(BASE + '/portal');
  await p.waitForTimeout(1200);
  await p.fill('#liClient', 'VisCo');
  await p.fill('#liUser', 'vera');
  await p.fill('#liPass', 'visco123');
  await p.click('#liBtn');
  await p.waitForTimeout(3000);

  // Orders tab, then the Report button.
  await p.evaluate(() => document.querySelector('[data-tab="orders"]')?.click());
  await p.waitForTimeout(1800);
  await p.screenshot({ path: `${OUT}/rep-orders-tab.png`, fullPage: false });

  await p.click('#orExport');
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/rep-dialog.png` });

  // Widest window the portal allows, so the demo covers everything seeded.
  await p.fill('#dlFrom', '2025-09-01');
  await p.fill('#dlTo', '2026-08-25');
  const dl = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.click('#dlGo')]).then(r => r[0]);
  const file = `${OUT}/VisCo_Report.xlsx`;
  await dl.saveAs(file);
  console.log('downloaded as:', dl.suggestedFilename());

  // ── Render the workbook so the sheets can actually be looked at.
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  console.log('tabs:', wb.SheetNames.join(' | '));
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const SHOW = ['Orders', 'Cancelled'];
  let html = `<style>
    body{font:13px -apple-system,Arial,sans-serif;margin:0;padding:18px;background:#f5f6f8;color:#111}
    h1{font-size:17px;margin:0 0 2px} .sub{color:#666;font-size:12px;margin-bottom:14px}
    .tab{background:#fff;border:1px solid #dfe3e8;border-radius:8px;margin-bottom:16px;overflow:hidden}
    .tt{font-weight:800;font-size:13px;padding:8px 12px;background:#eef2f7;border-bottom:1px solid #dfe3e8}
    .tt .new{background:#16a34a;color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;margin-left:8px}
    table{border-collapse:collapse;width:100%;font-size:11.5px}
    td,th{border-bottom:1px solid #eceef1;padding:3px 8px;text-align:left;white-space:nowrap}
    tr.hdr td{font-weight:800;background:#fafbfc;border-bottom:2px solid #cbd2d9}
    tr.pre td{color:#6b7280;font-style:italic}
    td.n{text-align:right}
  </style><h1>VisCo — Orders &amp; movements</h1>
  <div class="sub">Downloaded from the client portal, 1 Sep 2025 – 25 Aug 2026. Tabs: ${esc(wb.SheetNames.join(' · '))}</div>`;
  for (const nm of SHOW) {
    if (!wb.Sheets[nm]) continue;
    const a = XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1 });
    const hdr = a.findIndex(r => String(r[0] || '').trim() === 'Order no');
    html += `<div class="tab"><div class="tt">${esc(nm)}${'<span class="new">1 SHEET</span>'}</div><table>`;
    a.slice(0, 40).forEach((r, i) => {
      const cls = i === hdr ? 'hdr' : (i < hdr ? 'pre' : '');
      html += `<tr class="${cls}">` + (r.length ? r.map(c =>
        `<td class="${typeof c === 'number' ? 'n' : ''}">${esc(c)}</td>`).join('') : '<td>&nbsp;</td>') + '</tr>';
    });
    html += '</table></div>';
  }
  const view = `${OUT}/rep-view.html`;
  fs.writeFileSync(view, html);
  const p2 = await ctx.newPage();
  await p2.setViewportSize({ width: 1180, height: 1000 });
  await p2.goto('file://' + view);
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: `${OUT}/rep-sheets.png`, fullPage: true });

  await b.close();
  console.log('screenshots: rep-orders-tab.png, rep-dialog.png, rep-sheets.png');
})();
