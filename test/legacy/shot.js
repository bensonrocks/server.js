const { chromium } = require('/home/user/server.js/node_modules/playwright');
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await br.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto('http://localhost:4713', { waitUntil: 'domcontentloaded' });
  await p.fill('#loginName','demo'); await p.fill('#loginIC','demo');
  await p.click('#loginBtn'); await p.waitForTimeout(2500);
  // seed a client so the panel has something to load
  const tok = await p.evaluate(() => localStorage.getItem('wms_token'));
  await p.evaluate(async (t) => {
    const fd = new FormData();
    fd.append('file', new Blob(['sku,name,stock_qty,Location\nDEMO-1,Demo Widget,5,AA-001-001-A\n'],{type:'text/csv'}), 'seed.csv');
    fd.append('clientId','DemoCo');
    await fetch('/api/inventory/import-file', { method:'POST', headers:{'x-auth-token':t,'x-master-key':'201432547E'}, body: fd });
  }, tok);
  await p.locator('[data-tab="inventory"]').click({force:true}); await p.waitForTimeout(1200);
  await p.screenshot({ path: 'step1-inventory-tab.png' });
  await p.getByRole('button',{name:/Open stock/i}).first().click(); await p.waitForTimeout(1500);
  const panel = p.locator('#invLocMode').locator('xpath=ancestor::div[contains(@class,"panel")][1]');
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: 'step2-upload-panel.png' });
  await p.locator('#invLocMode').selectOption('supersede'); await p.waitForTimeout(300);
  await panel.screenshot({ path: 'step3-supersede-picked.png' });
  await br.close();
  console.log('shots done');
})().catch(e=>{console.error(e);process.exit(1)});
