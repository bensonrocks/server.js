// The option on screen: renders, defaults to the SAFE choice, explains itself,
// confirms before moving stock, and cancelling changes nothing.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const B = 'http://localhost:4712';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const vp of [{ w: 1440, h: 900, n: 'desktop' }, { w: 393, h: 851, n: 'Pixel 5' }]) {
    const ctx = await br.newContext({ viewport: { width: vp.w, height: vp.h } });
    const p = await ctx.newPage();
    await p.goto(B, { waitUntil: 'domcontentloaded' });
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(2500);
    if (vp.w < 768) { await p.locator('#sidebarToggleBtn').click(); await p.waitForTimeout(600); }
    await p.locator('[data-tab="inventory"]').click({ force: true }); await p.waitForTimeout(1000);
    // The uploader only exists once a client is loaded — that is the real flow.
    await p.getByRole('button', { name: /Open stock/i }).click(); await p.waitForTimeout(800);
    await p.fill('#invClient', 'MoveCo');
    await p.locator('#invLoadBtn').click({ force: true }); await p.waitForTimeout(1800);

    const sel = p.locator('#invLocMode');
    ok(await sel.count() === 1, `${vp.n}: the location option is on the screen`);
    ok(await sel.isVisible(), `${vp.n}: it is visible`);
    ok(await sel.inputValue() === 'fill', `${vp.n}: DEFAULTS to the safe choice (fill blanks only)`);
    const box = await sel.boundingBox();
    ok(box && box.x >= 0 && box.x + box.width <= vp.w + 1, `${vp.n}: fully on screen (no clipping)`);

    const hint = p.locator('#invLocModeHint');
    const fillTxt = (await hint.textContent() || '');
    ok(/left where it is/i.test(fillTxt), `${vp.n}: the default explains it leaves existing bins alone`);
    await sel.selectOption('supersede'); await p.waitForTimeout(200);
    const supTxt = (await hint.textContent() || '');
    ok(/moved/i.test(supTxt), `${vp.n}: picking Supersede says the SKUs are MOVED`);
    ok(/not changed/i.test(supTxt), `${vp.n}: …and that quantities are NOT changed`);
    ok(supTxt !== fillTxt, `${vp.n}: the hint actually changes with the choice`);

    // The confirm fires and CANCELLING must upload nothing at all.
    let asked = '';
    p.on('dialog', async dlg => { asked = dlg.message(); await dlg.dismiss(); });
    let posted = 0;
    p.on('request', r => { if (r.url().includes('/api/inventory/import-file')) posted++; });
    // Go through the REAL button — pickFile() is what wires the change
    // handler, so setting the input directly would prove nothing.
    const [chooser] = await Promise.all([
      p.waitForEvent('filechooser'),
      p.locator('#invUploadBtn').click(),
    ]);
    await chooser.setFiles({
      name: 'move.csv', mimeType: 'text/csv',
      buffer: Buffer.from('sku,name,stock_qty,Location\nAAA,Widget A,0,AA-007-007-A\n'),
    });
    await p.waitForTimeout(1500);
    ok(/SUPERSEDE LOCATIONS/i.test(asked), `${vp.n}: it CONFIRMS before moving stock`);
    ok(/Quantities are NOT changed/i.test(asked), `${vp.n}: the confirm says what it does not do`);
    ok(/Mass SUPERSEDE/i.test(asked), `${vp.n}: …and points at Putaway for a whole-position replace`);
    ok(posted === 0, `${vp.n}: CANCEL sent no request at all (${posted})`);

    await ctx.close();
  }
  await br.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
