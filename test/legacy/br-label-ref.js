// On screen: the Labels review says a page went onto the picking-list order
// (not the reference copy), says why a reference-only page attached to
// nothing, and the Match-to-Order picker never offers a reference record.
// Runs on the data label-ref-e2e.js left behind.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT = 4769, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'lbl-ref-data'), MASTER = process.env.MASTER_KEY || '201432547E';
const SHOTS = path.join(S, 'lbl-ref-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const MP2 = '260907ABCDEF01', GI3 = 'GI-141936', MP3 = '172397910455623';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids.length = 0; await sleep(1200); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
async function apiLogin(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); return d.token; }
async function pdfOf(browser, pages) {
  const page = await browser.newPage();
  await page.setContent(pages.map((h, i) => `<div style="page-break-after:${i < pages.length - 1 ? 'always' : 'auto'};font:16px sans-serif">${h}</div>`).join(''));
  const pdf = await page.pdf({ format: 'A4' }); await page.close(); return pdf;
}
async function login(page, id, pw) {
  await page.goto(B + '/'); await page.fill('#loginName', id); await page.fill('#loginIC', pw); await page.click('#loginBtn');
  await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
  await sleep(900);
}
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);

(async () => {
  spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'lbl-ref-br-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  // Seed one more label: a Shopee label naming a reference copy that has NO picking list.
  const tok = await apiLogin('demo', 'demo');
  const pdf = await pdfOf(browser, [`<h1>SPXSG0412345678</h1><p>Shopee Xpress</p><p>Order ID: ${MP2}</p><p>RECIPIENT Tan Ah Kow</p>`]);
  const fd = new FormData(); fd.append('labelPdf', new Blob([pdf], { type: 'application/pdf' }), 'shopee-ref-only.pdf');
  const li = await J(await fetch(B + '/api/label-imports', { method: 'POST', headers: { 'x-auth-token': tok }, body: fd }));
  await sleep(1500);
  const imp = await J(await fetch(B + `/api/label-imports/${li.importId}`, { headers: { 'x-auth-token': tok } }));
  ok(imp.pages[0].matchStatus === 'unmatched' && imp.pages[0].referenceHint?.client === 'Betime Online', `seed: the Shopee page is unmatched with the reference reason (${imp.pages[0].matchStatus}, ${JSON.stringify(imp.pages[0].referenceHint)})`);
  const traxImport = (await J(await fetch(B + '/api/label-imports', { headers: { 'x-auth-token': tok } })));
  const traxId = (Array.isArray(traxImport) ? traxImport : traxImport.imports || []).find(i => /traxlogics/.test(i.filename))?.id;
  ok(!!traxId, `seed: found the TraxLogics import (${traxId})`);

  for (const [label, ctxOpts, tag] of [['Pixel 5', { ...devices['Pixel 5'] }, 'pixel5'], ['desktop', { viewport: { width: 1280, height: 900 } }, 'desktop']]) {
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
    await login(page, 'demo', 'demo');
    await domClick(page, '.tab-btn[data-tab="labels"]');
    await page.waitForFunction(() => document.querySelectorAll('.label-history-item').length >= 2, null, { timeout: 15000 });
    // The TraxLogics import: page 1 went onto the GI order via the reference copy's number
    await page.evaluate(id => document.querySelector(`.label-history-item[data-import-id="${id}"]`).click(), traxId);
    await page.waitForFunction(() => document.querySelectorAll('#labelReviewBody .lri-row').length >= 2, null, { timeout: 15000 }); await sleep(400);
    const row1 = await page.evaluate(() => { const r = document.querySelector('#labelReviewBody .lri-row[data-page="0"]'); const n = r.querySelector('.lri-ref-note'); return { matched: r.querySelector('.lri-order-matched')?.innerText.trim() || '', method: r.querySelector('.lri-method')?.innerText.trim() || '', note: n ? n.innerText.replace(/\s+/g, ' ').trim() : '', bg: n ? getComputedStyle(n).backgroundColor : '', border: n ? getComputedStyle(n).borderLeftColor : '', ident: r.querySelector('.lri-identity, .lri-id-note')?.innerText || '' }; });
    ok(row1.matched.includes(GI3), `page 1 shows matched to the GI order (${row1.matched})`);
    ok(/reference copy/.test(row1.method), `the method reads "${row1.method}"`);
    ok(/reference copy/.test(row1.note) && row1.note.includes(MP3) && /same waybill/.test(row1.note), `the note explains: the label prints ${MP3}, the reference copy, and it is on the picking-list order with the same waybill`);
    ok(row1.bg === 'rgb(241, 245, 249)' && row1.border === 'rgb(100, 116, 139)', `the note is slate by computed style, not red (${row1.bg} / ${row1.border})`);
    const rowText = await page.evaluate(() => document.querySelector('#labelReviewBody .lri-row[data-page="0"]').innerText.replace(/\s+/g, ' '));
    ok(!/matches no identifier/.test(rowText), 'no "matches no identifier on this order" warning on page 1 any more');
    const refNote = await page.evaluate(() => { const n = document.querySelector('#labelReviewBody .lri-row[data-page="0"] .lri-field-note-ref'); return n ? { text: n.innerText.replace(/\s+/g, ' ').trim(), bg: getComputedStyle(n).backgroundColor } : null; });
    ok(refNote && /marketplace number of this shipment/.test(refNote.text) && /Betime Online/.test(refNote.text) && refNote.bg === 'rgb(241, 245, 249)', `the ORDER NO. field says it is the channel's own number, slate not amber (${refNote && refNote.text.slice(0, 80)})`);
    ok(/Betime Online's reference copy/.test(rowText) && rowText.includes(MP3), 'the note names Betime Online and the marketplace number');
    await page.screenshot({ path: path.join(SHOTS, `${tag}-trax.png`), fullPage: false });
    await page.evaluate(() => document.getElementById('closeLabelReviewBtn').click());
    await sleep(300);
    // The Shopee import: reference-only, so nothing attached, and the reason is on the row
    await page.evaluate(id => document.querySelector(`.label-history-item[data-import-id="${id}"]`).click(), li.importId);
    await page.waitForFunction(() => document.querySelectorAll('#labelReviewBody .lri-row').length >= 1, null, { timeout: 15000 }); await sleep(400);
    const row2 = await page.evaluate(() => { const r = document.querySelector('#labelReviewBody .lri-row[data-page="0"]'); const n = r.querySelector('.lri-ref-note'); return { status: r.querySelector('.lri-badge')?.innerText.trim() || '', note: n ? n.innerText.replace(/\s+/g, ' ').trim() : '', hasMatchBtn: !!r.querySelector('.lri-match-btn') }; });
    ok(row2.status === 'unmatched', `the Shopee page reads ${row2.status}`);
    ok(row2.note.includes(MP2) && /Betime Online/.test(row2.note) && /never scanned/.test(row2.note) && /Upload the picking list/.test(row2.note), `and says why: "${row2.note.slice(0, 120)}…"`);
    ok(row2.hasMatchBtn, 'Match to Order is still offered (for the picking-list order, once it exists)');
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(noScroll <= 0, `no sideways scroll (${noScroll})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-shopee.png`), fullPage: false });
    // The picker never offers a reference record
    await page.evaluate(() => document.querySelector('#labelReviewBody .lri-row[data-page="0"] .lri-match-btn').click());
    await page.waitForFunction(() => document.querySelectorAll('#labelMatchOrderList .lmm-order-row').length >= 1, null, { timeout: 15000 }); await sleep(300);
    await page.fill('#labelMatchSearchInput', MP2); await sleep(400);
    const pick = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#labelMatchOrderList .lmm-order-row')].map(r => r.dataset.order), text: document.getElementById('labelMatchOrderList').innerText.trim() }));
    ok(pick.rows.length === 0 && /No orders match/.test(pick.text), `searching the reference number ${MP2} offers nothing (${JSON.stringify(pick.rows)})`);
    await page.fill('#labelMatchSearchInput', ''); await sleep(400);
    const all = await page.evaluate(() => [...document.querySelectorAll('#labelMatchOrderList .lmm-order-row')].map(r => r.dataset.order));
    ok(all.length >= 2 && all.includes(GI3) && !all.includes(MP3) && !all.includes(MP2) && !all.includes('585836014589150279'), `the full picker lists the work orders and none of the three reference copies (${all.join(', ')})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-picker.png`), fullPage: false });
    await ctx.close();
  }
  await browser.close(); await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
