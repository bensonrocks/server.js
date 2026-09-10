// Reference mode on screen — desktop and a Pixel 5. The ledger is its own
// sub-tab, out of every count; the work order carries the twin pill; a scan of
// a reference-only number is refused in words; the upload prompt says "carry
// on?"; the Connections form defaults to Reference ledger.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT = 4753, MPORT = 4754, B = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
const DDIR = path.join(S, 'oc-ref-br-data'), MASTER = process.env.MASTER_KEY || '201432547E', KEY = 'oc_test_key_123';
const SHOTS = path.join(S, 'oc-ref-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids.length = 0; await sleep(1200); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
const MH = tok => ({ 'Content-Type': 'application/json', 'x-master-key': MASTER, 'x-auth-token': tok });
async function apiLogin(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); return d.token; }
function xlsxOf(rows) { const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S'); return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); }
async function login(page, id, pw) {
  await page.goto(B + '/'); await page.fill('#loginName', id); await page.fill('#loginIC', pw); await page.click('#loginBtn');
  await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
  await sleep(900);
}
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
const txt = (page, sel) => page.evaluate(s => document.querySelector(s)?.innerText || '', sel);
async function openConnections(page) {
  await domClick(page, '.tab-btn[data-tab="connections"]');
  await page.waitForFunction(() => { const o = document.getElementById('logPasswordOverlay'); const t = document.getElementById('tab-connections'); return (o && !o.classList.contains('hidden')) || (t && getComputedStyle(t).display !== 'none'); }, null, { timeout: 10000 });
  if (await page.evaluate(() => !document.getElementById('logPasswordOverlay').classList.contains('hidden'))) {
    await page.fill('#logPasswordInput', MASTER); await domClick(page, '#logPasswordSubmitBtn');
    await page.waitForFunction(() => document.getElementById('logPasswordOverlay').classList.contains('hidden'), null, { timeout: 8000 });
  }
  await page.waitForFunction(() => { const t = document.getElementById('tab-connections'); return t && getComputedStyle(t).display !== 'none'; }, null, { timeout: 10000 });
  await sleep(800); await page.evaluate(() => { document.getElementById('secOnecart').open = true; }); await sleep(400);
}
const NO1 = '585836014589150279', NO3 = '172397910455623';

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  spawnLogged([path.join(S, 'onecart-mock.js')], { PORT: String(MPORT), OC_KEY: KEY, OC_PDF_DIR: path.join(S, 'oc-pdfs') }, path.join(S, 'oc-ref-br-mock.log'));
  await waitUp(M + '/__ctl/calls');
  spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'oc-ref-br-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
  const tok = await apiLogin('demo', 'demo');
  const st = await J(await fetch(B + '/api/master/onecart/stores', { method: 'POST', headers: MH(tok), body: JSON.stringify({ clientName: 'Betime Online', apiKey: KEY, endpoint: M + '/api/v2', autoPullMinutes: 0, enabled: true }) }));
  await J(await fetch(B + `/api/master/onecart/stores/${st.id}/pull`, { method: 'POST', headers: MH(tok) }));
  // A work order for NO1 already carried on, so the twin pill is on screen.
  const fd = new FormData(); fd.append('orderFile', new Blob([xlsxOf([{ 'Order No': NO1, 'SKU Code': 'K5008', 'Quantity': 2 }])]), 'seed.xlsx'); fd.append('client_name', 'BETIME'); fd.append('arrange_delivery', 'no'); fd.append('confirm_reference', 'yes');
  const up = await fetch(B + '/api/upload', { method: 'POST', headers: { 'x-auth-token': tok }, body: fd });
  ok(up.status === 200, `seed: BETIME work order for ${NO1} uploaded beside its reference (${up.status})`);
  const FILE2 = path.join(S, 'oc-ref-upload.xlsx'); fs.writeFileSync(FILE2, xlsxOf([{ 'Order No': NO3, 'SKU Code': '8006', 'Quantity': 1 }]));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  // Pixel 5 FIRST: the desktop pass ends by really uploading a work order for
  // one of the references, which changes every count the phone pass reads.
  for (const [label, ctxOpts, tag] of [['Pixel 5', { ...devices['Pixel 5'] }, 'pixel5'], ['desktop', { viewport: { width: 1280, height: 900 } }, 'desktop']]) {
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
    await login(page, 'demo', 'demo');
    await domClick(page, '.tab-btn[data-tab="orders"]');
    await page.waitForFunction(() => document.querySelector('[data-oview="reference"]'), null, { timeout: 15000 }); await sleep(500);
    const counts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-oview]')].map(b => [b.dataset.oview, Number(b.querySelector('.subtab-count')?.textContent)])));
    ok(counts.active === 1, `Active counts ONLY the work order (${counts.active})`);
    const tiles = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#statsBar .stat-box')].map(b => [b.querySelector('.lbl').innerText.trim().toLowerCase(), Number(b.querySelector('.val').innerText)])));
    ok(tiles.total === 1 && tiles.pending === 1, `the TOTAL / PENDING tiles count only the work order (${JSON.stringify(tiles)})`);
    const kpi = await page.evaluate(() => { const b = document.getElementById('kpiBar'); if (!b || b.classList.contains('hidden')) return { hidden: true }; return Object.fromEntries([...b.querySelectorAll('.kpi-tile')].map(t => [t.dataset.kpi, Number(t.querySelector('b').innerText)])); });
    ok(kpi.hidden || Object.values(kpi).every(n => n === 0), `the fulfilment KPI tiles count no reference record (${JSON.stringify(kpi)})`);
    ok(counts.reference === 2, `📒 Reference sub-tab holds the 2 references that have no work order yet (${counts.reference})`);
    const sb = await txt(page, '#sidebarClientList');
    ok(/All clients\s*1\b/.test(sb), `sidebar "All clients" is 1, not 3 (${sb.replace(/\s+/g, ' ').slice(0, 80)})`);
    ok(/Betime Online\s*📒\s*2/.test(sb) && /BETIME\s*1\b/.test(sb), 'Betime Online shows a dimmed 📒 2, BETIME shows 1');
    const wrow = await page.evaluate(no => { const r = document.querySelector(`tr[data-order="${no}"]`); return r ? { client: r.querySelector('.ord-client-name')?.innerText, twin: r.querySelector('.chip-ref-twin')?.innerText || '', scan: !!r.querySelector('.btn-scan-now'), ref: !!r.querySelector('.chip-reference') } : null; }, NO1);
    ok(wrow && wrow.client === 'BETIME' && /also in Betime Online/.test(wrow.twin) && wrow.scan && !wrow.ref, `the work order row: BETIME, "also in Betime Online" pill, Scan button (${JSON.stringify(wrow)})`);
    await domClick(page, '[data-oview="reference"]'); await sleep(400);
    const rrow = await page.evaluate(no => { const r = document.querySelector(`tr[data-order="${no}"]`); return r ? { client: r.querySelector('.ord-client-name')?.innerText, ref: r.querySelector('.chip-reference')?.innerText || '', scan: !!r.querySelector('.btn-scan-now'), bg: getComputedStyle(r.querySelector('.chip-reference')).backgroundColor } : null; }, NO3);
    // innerText is the RENDERED text and the client cell is text-transform: uppercase.
    ok(rrow && /^betime online$/i.test(rrow.client) && /Reference — not an order/.test(rrow.ref) && !rrow.scan, `a reference row: Betime Online, "Reference — not an order" pill, NO Scan button (${JSON.stringify(rrow)})`);
    ok(rrow && rrow.bg === 'rgb(241, 245, 249)', `the pill is slate by computed style (${rrow && rrow.bg})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-reference-tab.png`), fullPage: false });
    // Scan bar on a reference-only number
    await domClick(page, '[data-oview="active"]'); await sleep(300);
    await page.fill('#waybillScanInput', NO3); await page.press('#waybillScanInput', 'Enter'); await sleep(900);
    const msg = await page.evaluate(() => document.querySelector('.waybill-scan-msg, #waybillScanMsg, [id*="waybill"][id*="Msg"]')?.innerText || document.body.innerText.match(/exists only as a channel reference record[^\n]*/)?.[0] || '');
    const overlayOpen = await page.evaluate(() => { const o = document.getElementById('scanOverlay'); return !!o && !o.classList.contains('hidden') && getComputedStyle(o).display !== 'none'; });
    ok(/exists only as a channel reference record/.test(msg) && !overlayOpen, `scanning a reference-only number is refused in words and opens no scan screen ("${msg.slice(0, 70)}", overlay=${overlayOpen})`);
    if (tag === 'desktop') {
      // The real upload flow: pick file → Confirm modal → Approve → the "carry on?" prompt.
      const dialogs = [];
      page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
      await domClick(page, '.tab-btn[data-tab="upload"]'); await sleep(400);
      await page.setInputFiles('#fileInput', FILE2);
      await page.waitForFunction(() => { const o = document.getElementById('uploadConfirmOverlay'); return o && !o.classList.contains('hidden'); }, null, { timeout: 20000 }); await sleep(600);
      const errs = await txt(page, '#confirmErrors');
      ok(/reference record/.test(errs) && /carry on/.test(errs), `the Confirm-Upload screen says it exists as a reference record ("${errs.replace(/\s+/g, ' ').slice(0, 100)}")`);
      // page.fill, not a scripted .value — the field listens for input events.
      await page.fill('#confirmClientNameField', 'BETIME');
      await page.evaluate(() => document.getElementById('arrangeDeliveryNo')?.click());
      await page.screenshot({ path: path.join(SHOTS, 'desktop-confirm-upload.png') });
      await domClick(page, '#confirmApproveBtn');
      for (let i = 0; i < 40 && !dialogs.length; i++) await sleep(500);
      await sleep(3000);
      await page.screenshot({ path: path.join(SHOTS, 'desktop-after-approve.png') });
      const prompt = dialogs.find(d => /ALREADY IN THE CHANNEL LEDGER/.test(d));
      ok(!!prompt && /Betime Online/.test(prompt) && /carry on/i.test(prompt) && new RegExp(NO3).test(prompt), `the "carry on?" prompt names the ledger and the order (${dialogs.length} dialog(s))`);
      // From DISK, not the API: the browser's login as demo took the one seat,
      // so the harness token is dead by now (one active device per user).
      const dbAfter = JSON.parse(fs.readFileSync(path.join(DDIR, 'tenants', 'default', 'db.json'), 'utf8'));
      const holders = (dbAfter.batches || []).filter(b => (b.orders || []).some(o => o.order_number === NO3));
      ok(holders.length === 2 && holders.some(b => b.client_name === 'BETIME' && !b.reference_only) && holders.some(b => b.reference_only),
        `accepting it → the upload went through as BETIME's work order, the reference left standing (${holders.map(b => b.client_name + (b.reference_only ? '(ref)' : '')).join(', ')})`);
      // The Orders tab's DOM is still the render from BEFORE the upload (tabs
      // hide, they do not unmount) — switch to it and let it refetch first.
      // A full reload (the session lives in localStorage) so the list is
      // refetched rather than waiting out the tab's own poll.
      await page.reload(); await sleep(1500);
      await domClick(page, '.tab-btn[data-tab="orders"]');
      await page.waitForFunction(no => { const r = document.querySelector(`tr[data-order="${no}"]`); return r && /^betime$/i.test(r.querySelector('.ord-client-name')?.innerText || ''); }, NO3, { timeout: 15000 }).catch(() => {});
      const uiRow2 = await page.evaluate(no => { const r = document.querySelector(`tr[data-order="${no}"]`); return r ? { client: r.querySelector('.ord-client-name')?.innerText, twin: r.querySelector('.chip-ref-twin')?.innerText || '' } : null; }, NO3);
      ok(uiRow2 && /^betime$/i.test(uiRow2.client) && /also in Betime Online/.test(uiRow2.twin), `…and the Orders tab now shows it as BETIME's with the twin pill (${JSON.stringify(uiRow2)})`);
    }
    // Connections form defaults to Reference ledger
    await openConnections(page);
    const rowMode = await txt(page, '#onecartStoresTbody');
    ok(/Reference ledger/.test(rowMode), 'the store row reads "Reference ledger"');
    await domClick(page, '#onecartAddStoreBtn'); await sleep(300);
    const mode = await page.evaluate(() => document.getElementById('ocMode')?.value);
    ok(mode === 'reference', `the form's mode defaults to reference (${mode})`);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(scroll <= 0, `no sideways scroll (${scroll})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-connections.png`) });
    await ctx.close();
  }
  await browser.close(); await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
