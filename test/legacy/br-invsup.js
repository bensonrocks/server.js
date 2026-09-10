// The Inventory tab's ⚛ SUPERSEDE, driven in a real browser: the option says
// the file IS the position, the Location picker steps aside (it has nothing
// left to decide), and the confirm states the file's own sum before anything
// moves — on a desktop and on a phone.
const { chromium } = require('/home/user/server.js/node_modules/playwright');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4717', MK = '201432547E';

const xlsx = rows => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

(async () => {
  // Seed a client through the API so the screen has a real position to replace.
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'x-auth-token': l.token, 'x-master-key': MK };
  const C = 'BrSup' + String(Date.now()).slice(-6);
  const seed = new FormData();
  seed.append('file', new Blob([xlsx([
    { SKU: 'AAA', Description: 'Alpha', Location: 'AA-001-001-A', 'AVailable LHU': 1000 },
    { SKU: 'DDD', Description: 'Delta', Location: 'AA-003-001-A', 'AVailable LHU': 741 },
  ])]), 'seed.xlsx');
  seed.append('clientId', C); seed.append('mode', 'add'); seed.append('confirm_apply', 'yes');
  await fetch(B + '/api/inventory/import-file', { method: 'POST', headers: H, body: seed });

  // The sheet: AAA at THREE bins (240), BBB (500), CCC with no location (504).
  const sheet = xlsx([
    { 'S/No': 1, SKU: 'AAA', Location: 'AA-005-001-A', 'AVailable LHU': 100 },
    { 'S/No': 2, SKU: 'AAA', Location: 'AA-005-001-B', 'AVailable LHU': 80 },
    { 'S/No': 3, SKU: 'AAA', Location: 'AA-005-002-A', 'AVailable LHU': 60 },
    { 'S/No': 4, SKU: 'BBB', Location: 'AA-002-001-A', 'AVailable LHU': 500 },
    { 'S/No': 5, SKU: 'CCC', Location: '',             'AVailable LHU': 504 },
  ]);

  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const vp of [{ w: 1440, h: 900, n: 'desktop' }, { w: 393, h: 851, n: 'Pixel 5' }]) {
    const ctx = await br.newContext({ viewport: { width: vp.w, height: vp.h } });
    const p = await ctx.newPage();
    await p.goto(B, { waitUntil: 'domcontentloaded' });
    await p.fill('#loginName', 'demo'); await p.fill('#loginIC', 'demo');
    await p.click('#loginBtn'); await p.waitForTimeout(2500);
    if (vp.w < 768) { await p.locator('#sidebarToggleBtn').click(); await p.waitForTimeout(600); }
    await p.locator('[data-tab="inventory"]').click({ force: true }); await p.waitForTimeout(900);
    await p.getByRole('button', { name: /Open stock/i }).first().click(); await p.waitForTimeout(700);
    await p.fill('#invClient', C); await p.locator('#invLoadBtn').click({ force: true }); await p.waitForTimeout(2000);

    const sel = p.locator('#invQtyMode'), hint = p.locator('#invQtyModeHint'), loc = p.locator('#invLocMode');
    ok(await sel.inputValue() === 'add', `${vp.n}: still defaults to ADD`);
    ok(!(await loc.isDisabled()), `${vp.n}: the Location picker is live in ADD mode`);

    ok(/SUPERSEDE/i.test(await sel.locator('option[value="set"]').textContent() || ''),
       `${vp.n}: the option itself says SUPERSEDE`);
    await sel.selectOption('set'); await p.waitForTimeout(250);
    const t = (await hint.textContent()) || '';
    console.log(`  HINT(${vp.n}):`, t.replace(/\s+/g, ' ').slice(0, 190));
    ok(/on hand IS the sum of this file/i.test(t), `${vp.n}: the hint says on hand becomes the file's sum`);
    ok(/summed/i.test(t), `${vp.n}: …that a SKU at several locations is summed`);
    ok(/zero/i.test(t), `${vp.n}: …and that a SKU the file omits goes to zero`);
    ok(!/Mass SUPERSEDE/i.test(t), `${vp.n}: no longer sends anyone to another screen for this`);
    ok(await loc.isDisabled(), `${vp.n}: the Location picker steps aside — the file carries the bins`);

    const box = await sel.boundingBox();
    ok(box && box.x >= 0 && box.x + box.width <= vp.w + 1, `${vp.n}: the picker is fully on screen`);

    let asked = ''; p.on('dialog', async d => { asked = d.message(); await d.dismiss(); });
    let posted = 0; p.on('request', r => { if (r.url().includes('/api/inventory/import-file')) posted++; });
    const [ch] = await Promise.all([p.waitForEvent('filechooser'), p.locator('#invUploadBtn').click()]);
    await ch.setFiles({ name: 'INVENTORY MAYER 01-09-26 PM.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: sheet });
    await p.waitForTimeout(3000);
    console.log(`  DIALOG(${vp.n}):`, asked.replace(/\n/g, ' | ').slice(0, 320));
    ok(/ON HAND NOW: 1741/.test(asked), `${vp.n}: the confirm states on hand now = 1741`);
    ok(/AFTER: 1244/.test(asked), `${vp.n}: ★ the confirm states AFTER = 1244, the file's own sum`);
    ok(/DDD: 741 → 0/.test(asked), `${vp.n}: it NAMES DDD as going to zero`);
    ok(/504 pc\(s\) are counted but NOT binned/.test(asked), `${vp.n}: it names the 504 counted with no location`);
    ok(!/LEFT AS THEY ARE/i.test(asked), `${vp.n}: nothing claims stock is left standing`);
    ok(posted === 1, `${vp.n}: cancelling wrote nothing — one request, the preview (${posted})`);

    // ONE ACTIVE DEVICE PER USER: the browser signing in as demo invalidated
    // the harness's token, so this read has to re-authenticate first.
    const l2 = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
    const after = await fetch(B + `/api/inventory?clientId=${C}`, { headers: { 'x-auth-token': l2.token, 'x-master-key': MK } }).then(r => r.json());
    ok(Array.isArray(after) && after.reduce((n, r) => n + (Number(r.stock_qty) || 0), 0) === 1741,
       `${vp.n}: the position is untouched at 1741 after cancelling`);
    await ctx.close();
  }
  await br.close();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
