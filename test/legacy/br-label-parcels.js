// On screen: the Orders row and the scan overlay both say ×2 for a split order.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const UP = '/root/.claude/uploads/c6f7f812-7f43-5071-90d1-eb00f9dd51b6';
const PORT = 4763, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'lbl-parcel-br-data'), MASTER = process.env.MASTER_KEY || '201432547E';
const SHOTS = path.join(S, 'lbl-parcel-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const ORDER = '171067267872131', T1 = 'LZSGD1015417357', T2 = 'LZSGD1015417039';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids.length = 0; await sleep(1200); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
const H = tok => ({ 'x-auth-token': tok, 'x-master-key': MASTER });
async function apiLogin(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); return d.token; }
function xlsxOf(rows) { const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S'); return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); }
async function login(page, id, pw) {
  await page.goto(B + '/'); await page.fill('#loginName', id); await page.fill('#loginIC', pw); await page.click('#loginBtn');
  await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
  await sleep(900);
}
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'lbl-parcel-br-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
  const tok = await apiLogin('demo', 'demo');
  const fd = new FormData(); fd.append('orderFile', new Blob([xlsxOf([{ 'Order No': ORDER, 'Waybill Ref': T1, 'SKU Code': '8006', 'Quantity': 5 }])]), 'mayer.xlsx'); fd.append('client_name', 'MAYER2026'); fd.append('arrange_delivery', 'no');
  ok((await fetch(B + '/api/upload', { method: 'POST', headers: H(tok), body: fd })).status === 200, 'seed: order uploaded');
  const lf = new FormData(); lf.append('labelPdf', new Blob([fs.readFileSync(path.join(UP, '71fbf9ce-DisplayPdfByUrl_42.pdf'))]), 'DisplayPdfByUrl_42.pdf');
  const li = await J(await fetch(B + '/api/label-imports', { method: 'POST', headers: H(tok), body: lf }));
  for (let i = 0; i < 60; i++) { const d = await J(await fetch(B + `/api/label-imports/${li.importId}`, { headers: H(tok) })); if ((d.pages || []).filter(p => p.matchStatus === 'matched').length === 2) break; await sleep(2000); }
  const o = (await J(await fetch(B + '/api/orders?range=all', { headers: H(tok) }))).find(x => x.order_number === ORDER);
  ok(o && o.label_pages === 2 && (o.waybills || []).length === 2, `seed: both parcels attached (label_pages=${o && o.label_pages}, waybills=${o && (o.waybills || []).length})`);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, ctxOpts, tag] of [['Pixel 5', { ...devices['Pixel 5'] }, 'pixel5'], ['desktop', { viewport: { width: 1280, height: 900 } }, 'desktop']]) {
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
    const dialogs = []; page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
    await login(page, 'demo', 'demo');
    await domClick(page, '.tab-btn[data-tab="orders"]');
    await page.waitForFunction(no => document.querySelector(`tr[data-order="${no}"]`), ORDER, { timeout: 15000 }); await sleep(400);
    const cell = await page.evaluate(no => { const r = document.querySelector(`tr[data-order="${no}"]`); const c = r.querySelector('.ord-waybill-cell'); const k = c.querySelector('.wb-count'); return { text: c.innerText.replace(/\s+/g, ' ').trim(), count: k ? k.innerText : '', title: c.getAttribute('title') || '', bg: k ? getComputedStyle(k).backgroundColor : '', chip: r.querySelector('.chip-label')?.innerText || '' }; }, ORDER);
    ok(cell.text.includes(T1) && cell.count === '×2', `the row's waybill cell reads "${cell.text}"`);
    ok(cell.title.includes(T1) && cell.title.includes(T2), 'its tooltip lists both waybills');
    ok(cell.bg === 'rgb(29, 78, 216)', `the ×2 token is blue by computed style (${cell.bg})`);
    ok(/Label ×2/.test(cell.chip), `the row chip reads "${cell.chip}"`);
    await page.evaluate(no => document.querySelector(`tr[data-order="${no}"] .wb-count`).click(), ORDER); await sleep(300);
    ok(dialogs.length === 1 && /2 waybills/.test(dialogs[0]) && dialogs[0].includes(T1) && dialogs[0].includes(T2) && /Parcel 2/.test(dialogs[0]), `tapping ×2 lists both, one per parcel (${(dialogs[0] || '').split('\n')[0]})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-row.png`) });
    // The processing page
    await page.evaluate(no => document.querySelector(`tr[data-order="${no}"] .btn-scan-now`).click(), ORDER);
    await page.waitForFunction(() => { const s = document.getElementById('scanWaybillPill'); return s && /×2/.test(s.innerText); }, null, { timeout: 15000 }).catch(() => {});
    const hdr = await page.evaluate(() => ({ pill: document.getElementById('scanWaybillPill')?.innerText.replace(/\s+/g, ' ').trim() || '', btn: document.getElementById('scanWaybillPdfBtn')?.innerText.replace(/\s+/g, ' ').trim() || '', btnHidden: document.getElementById('scanWaybillPdfBtn')?.classList.contains('hidden') }));
    ok(hdr.pill.includes(T1) && /✓/.test(hdr.pill) && /×2/.test(hdr.pill), `the scan overlay's waybill pill reads "${hdr.pill}"`);
    ok(!hdr.btnHidden && /Label ×2/.test(hdr.btn), `the Label button reads "${hdr.btn}"`);
    await page.evaluate(() => document.querySelector('#scanWaybillPill .wb-count').click()); await sleep(300);
    ok(dialogs.length === 2 && dialogs[1].includes(T2), 'tapping the pill\'s ×2 lists both waybills too');
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(scroll <= 0, `no sideways scroll (${scroll})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-overlay.png`) });
    await ctx.close();
  }
  await browser.close(); await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
