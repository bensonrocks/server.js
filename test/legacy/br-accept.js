// Accepting the confirm really moves the stock, on screen, with no reload.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails=[]; const ok=(c,m)=>{console.log((c?'PASS':'FAIL')+' - '+m); if(!c) fails.push(m);};
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await br.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('dialog', async d => { await d.accept(); });
  await p.goto('http://localhost:4712', { waitUntil: 'domcontentloaded' });
  await p.fill('#loginName','demo'); await p.fill('#loginIC','demo');
  await p.click('#loginBtn'); await p.waitForTimeout(2500);
  await p.locator('[data-tab="inventory"]').click({force:true}); await p.waitForTimeout(900);
  await p.getByRole('button',{name:/Open stock/i}).click(); await p.waitForTimeout(700);
  await p.fill('#invClient','MoveCo'); await p.locator('#invLoadBtn').click({force:true}); await p.waitForTimeout(1800);
  await p.locator('#invLocMode').selectOption('supersede'); await p.waitForTimeout(200);
  const [ch] = await Promise.all([p.waitForEvent('filechooser'), p.locator('#invUploadBtn').click()]);
  await ch.setFiles({ name:'br-move.csv', mimeType:'text/csv',
    buffer: Buffer.from('sku,name,stock_qty,Location\nAAA,Widget A,0,ZZ-009-009-A\n') });
  await p.waitForTimeout(3000);
  const status = (await p.locator('#invUploadStatus').textContent() || '');
  console.log('  STATUS:', status.trim().slice(0,180));
  ok(/relocated/i.test(status), 'the status line says RELOCATED, not "located"');
  const table = (await p.locator('#invBody').textContent() || '');
  ok(/ZZ-009-009-A/.test(table), 'the Location column shows the new bin with no reload');
  ok(!/AA-003-003-A/.test(table), 'the old bin is gone from the row');
  await br.close();
  console.log('\n' + (fails.length?`${fails.length} FAILED`:'ALL PASS'));
  process.exit(fails.length?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
