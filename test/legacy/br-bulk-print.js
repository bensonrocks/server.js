// On screen: tick several orders on the Orders tab, press 🖨 Print Waybills,
// read the confirm (carrier vs system counts, the orders named), and see ONE
// PDF go to the print frame. Admin on desktop, WAREHOUSE on a Pixel 5 (the
// floor prints labels). Runs on the data bulk-print-e2e.js left behind.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT = 4773, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'bulk-print-data');
const SHOTS = path.join(S, 'bulk-print-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const A = 'GI-200001', C = 'GI-200004', D = 'GI-200005';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids.length = 0; await sleep(1200); }
async function login(page, id, pw) {
  await page.goto(B + '/'); await page.fill('#loginName', id); await page.fill('#loginIC', pw); await page.click('#loginBtn');
  await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
  await sleep(900);
}
const domClick = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); if (!el) throw new Error('no ' + s); el.click(); }, sel);

(async () => {
  spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'bulk-print-br-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  for (const [label, ctxOpts, tag, user, pw, role] of [
    ['Pixel 5 / warehouse', { ...devices['Pixel 5'] }, 'pixel5', 'whguy', 'whpass1', 'warehouse'],
    ['desktop / admin', { viewport: { width: 1280, height: 900 } }, 'desktop', 'demo', 'demo', 'admin'],
  ]) {
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
    const calls = []; const dialogs = [];
    page.on('request', r => { if (r.url().includes('/api/orders/print-labels')) calls.push({ method: r.method(), body: (() => { try { return JSON.parse(r.postData() || '{}'); } catch { return {}; } })() }); });
    let acceptNext = true;
    page.on('dialog', async d => { dialogs.push({ type: d.type(), msg: d.message() }); if (d.type() === 'confirm') await (acceptNext ? d.accept() : d.dismiss()); else await d.accept(); });
    await login(page, user, pw);
    await domClick(page, '.tab-btn[data-tab="orders"]');
    await page.waitForFunction(() => document.querySelectorAll('.orders-tr .ord-select').length >= 5, null, { timeout: 15000 }); await sleep(400);
    for (const n of [A, C, D]) await page.evaluate(n => { const cb = document.querySelector(`.ord-select[data-order="${n}"]`); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }, n);
    await sleep(300);
    const bar = await page.evaluate(() => {
      const b = document.getElementById('ordersBulkBar'); const btn = document.getElementById('ordersBulkPrint');
      const r = btn.getBoundingClientRect();
      return { hidden: b.classList.contains('hidden'), text: btn.textContent.trim(), disabled: btn.disabled, buttons: [...b.querySelectorAll('button')].map(x => x.id), onScreen: r.left >= 0 && r.right <= innerWidth && r.width > 0, count: document.getElementById('ordersBulkCount').textContent.trim() };
    });
    ok(!bar.hidden && bar.count === '3 selected', `the bulk bar shows with 3 selected (${bar.count})`);
    ok(bar.text === '🖨 Print Waybills (3)' && !bar.disabled, `the button reads "${bar.text}" and is enabled`);
    ok(bar.onScreen, 'the button is fully on screen');
    if (role === 'warehouse') ok(bar.buttons.join() === 'ordersBulkPrint,ordersBulkCartonLabels,ordersBulkClear', `WAREHOUSE's bar carries Print Waybills + Carton Labels + Clear and nothing else (${bar.buttons.join(', ')})`);
    else ok(bar.buttons.includes('ordersBulkPrint') && bar.buttons.includes('ordersBulkDelete'), `admin's full bar carries it too (${bar.buttons.length} buttons)`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-bar.png`) });

    // Decline first: one request (the plan), nothing printed.
    acceptNext = false;
    await domClick(page, '#ordersBulkPrint'); await sleep(1500);
    ok(dialogs.length === 1 && dialogs[0].type === 'confirm', `pressing it asks first (${dialogs.length} dialog, ${dialogs[0]?.type})`);
    const msg = dialogs[0]?.msg || '';
    ok(/Print waybill labels for 3 orders — 3 pages in one run\?/.test(msg), `the confirm states the run: "${msg.split('\n')[0]}"`);
    ok(/• 1 with the carrier's label attached/.test(msg) && /• 2 with NO carrier label — a SYSTEM label prints in its place:\n  GI-200004, GI-200005/.test(msg), 'it names the 1 carrier label and the 2 orders getting a system label');
    ok(/1 of those has no waybill number yet either — the barcode is the ORDER number/.test(msg), 'and says one of them has no waybill number at all');
    ok(calls.length === 1 && calls[0].body.dry === true && calls[0].body.orders.join() === [A, C, D].join(), `declining sent only the plan request (${calls.length}, dry=${calls[0]?.body.dry})`);
    ok(!(await page.$('#pdfPrintFrame')), 'and nothing went to the print frame');
    const stillEnabled = await page.evaluate(() => !document.getElementById('ordersBulkPrint').disabled);
    ok(stillEnabled, 'the button is re-enabled after declining');

    // Accept: the real request, one PDF in the print frame.
    acceptNext = true; dialogs.length = 0; calls.length = 0;
    await domClick(page, '#ordersBulkPrint');
    await page.waitForFunction(() => { const f = document.getElementById('pdfPrintFrame'); return f && /^blob:/.test(f.src); }, null, { timeout: 20000 }).catch(() => {});
    await sleep(800);
    const frame = await page.evaluate(() => { const f = document.getElementById('pdfPrintFrame'); return f ? { src: f.src.slice(0, 5) } : null; });
    ok(frame && frame.src === 'blob:', `accepting puts ONE PDF in the print frame (${JSON.stringify(frame)})`);
    ok(calls.length === 2 && calls[0].body.dry === true && !calls[1].body.dry && calls[1].body.orders.join() === [A, C, D].join() && typeof calls[1].body.size === 'string', `two requests: the plan, then the real run carrying the 3 orders and the label size (${JSON.stringify(calls.map(c => c.body))})`);
    ok(dialogs.length === 1 && dialogs[0].type === 'confirm', 'exactly one confirm, no error dialog');
    const overlays = await page.evaluate(() => ['printOrderLabelOverlay', 'printWaybillOverlay'].filter(id => !document.getElementById(id).classList.contains('hidden')));
    ok(overlays.length === 0, `no per-order print modal stacks up any more (${overlays.join(', ') || 'none open'})`);
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(noScroll <= 0, `no sideways scroll (${noScroll})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-after.png`) });
    await ctx.close();
  }
  await browser.close(); await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
