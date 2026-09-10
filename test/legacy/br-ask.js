const { chromium } = require('/home/user/server.js/node_modules/playwright');
const fails=[]; const ok=(c,m)=>{console.log((c?'PASS':'FAIL')+' - '+m); if(!c) fails.push(m);};
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const vp of [{w:1440,h:900,n:'desktop'},{w:393,h:851,n:'Pixel 5'}]) {
    const ctx = await br.newContext({ viewport:{width:vp.w,height:vp.h} });
    const p = await ctx.newPage();
    await p.goto('http://localhost:4714', { waitUntil:'domcontentloaded' });
    await p.fill('#loginName','demo'); await p.fill('#loginIC','demo');
    await p.click('#loginBtn'); await p.waitForTimeout(2500);
    if (vp.w < 768) { await p.locator('#sidebarToggleBtn').click(); await p.waitForTimeout(600); }
    await p.locator('[data-tab="inventory"]').click({force:true}); await p.waitForTimeout(900);
    await p.getByRole('button',{name:/Open stock/i}).first().click(); await p.waitForTimeout(700);
    await p.fill('#invClient','AskCo'); await p.locator('#invLoadBtn').click({force:true}); await p.waitForTimeout(1800);

    const sel = p.locator('#invQtyMode');
    ok(await sel.count()===1 && await sel.isVisible(), `${vp.n}: the quantity choice is on screen`);
    ok(await sel.inputValue()==='add', `${vp.n}: defaults to ADD (today's behaviour)`);
    const box = await sel.boundingBox();
    ok(box && box.x>=0 && box.x+box.width<=vp.w+1, `${vp.n}: fully on screen`);
    const h = p.locator('#invQtyModeHint');
    ok(/on top of/i.test(await h.textContent()||''), `${vp.n}: ADD says it goes on top`);
    await sel.selectOption('set'); await p.waitForTimeout(200);
    const t = await h.textContent()||'';
    ok(/set to the file/i.test(t), `${vp.n}: REPLACE says each SKU is set to the file`);
    ok(/Mass SUPERSEDE/i.test(t), `${vp.n}: …and names Putaway for a whole-position stock-take`);
    await sel.selectOption('add'); await p.waitForTimeout(200);

    let asked=''; p.on('dialog', async d => { asked = d.message(); await d.dismiss(); });
    let posted=0; p.on('request', r=>{ if(r.url().includes('/api/inventory/import-file')) posted++; });
    const [ch] = await Promise.all([p.waitForEvent('filechooser'), p.locator('#invUploadBtn').click()]);
    await ch.setFiles({ name:'MAYER 1-09-26.csv', mimeType:'text/csv',
      buffer: Buffer.from('sku,name,stock_qty\nA,Alpha,600\nB,Bravo,636\n') });
    await p.waitForTimeout(2500);
    console.log('  DIALOG:', asked.replace(/\n/g,' | ').slice(0,200));
    ok(/ON HAND NOW/i.test(asked), `${vp.n}: IT ASKS, stating on-hand now`);
    ok(/AFTER/i.test(asked), `${vp.n}: …and the after figure`);
    ok(posted===1, `${vp.n}: exactly one request — the preview (${posted})`);
    await ctx.close();
  }
  await br.close();
  console.log('\n'+(fails.length?`${fails.length} FAILED`:'ALL PASS'));
  process.exit(fails.length?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
