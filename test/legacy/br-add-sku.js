// + Add SKU in a real browser, desktop and a Pixel 5: pick the client, fill
// the form, see the refusals in words, land the SKU on the stock list.
//   TEST_CHROMIUM=<path> to point at a Chromium; SHOTS=<dir> for screenshots.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const { chromium, devices } = require('playwright');

const PORT = 4995;
const B = `http://localhost:${PORT}`;
const DDIR = path.join(__dirname, 'br-add-sku-data');
const LOG = path.join(__dirname, 'br-add-sku-server.log');
const SHOTS = process.env.SHOTS || path.join(__dirname, 'br-add-sku-shots');
const MASTER = process.env.MASTER_KEY || '201432547E';
const SERVER = process.env.SERVER_JS || path.join(__dirname, '../../server.js');
const CLIENT = 'DemoCo';

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kid;
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up'); }

async function run(browser, label, ctxOpts, sku) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  await page.goto(B + '/');
  await page.fill('#loginName', 'demo'); await page.fill('#loginIC', 'demo'); await page.click('#loginBtn');
  await page.waitForFunction(() => !!localStorage.getItem('wms_token'));
  await sleep(1200);
  await page.evaluate(() => document.querySelector('.tab-btn[data-tab="inventory"]').click());
  await sleep(400);
  // The way a person gets there: Inventory → 📦 Stock & SKUs, no client loaded yet.
  await page.evaluate(() => document.querySelector('#inventorySubMenu .inv-sub[data-inv-view="stock"]').click());
  await page.waitForFunction(() => { const b = document.getElementById('invAddSkuBtn'); return b && b.offsetParent !== null; }, null, { timeout: 10000 });
  const box = await page.$eval('#invAddSkuBtn', b => { const r = b.getBoundingClientRect(); return { l: r.left, r: r.right, w: window.innerWidth }; });
  ok(box.l >= 0 && box.r <= box.w, `${label}: + Add SKU visible on screen with NO client loaded yet`);
  await page.screenshot({ path: path.join(SHOTS, `${label}-0-stock-view.png`) });
  await page.click('#invAddSkuBtn');
  await page.waitForFunction(() => !document.getElementById('invAddSkuOverlay').classList.contains('hidden'));
  await page.waitForFunction(() => document.querySelectorAll('#addSkuClient option').length > 1);
  const locked = await page.evaluate(() => document.getElementById('addSkuFields').disabled && document.getElementById('addSkuSave').disabled);
  const preset = await page.$eval('#addSkuClient', s => s.value);
  ok(preset || locked, `${label}: fields locked until a client is picked (preset="${preset}")`);
  await page.screenshot({ path: path.join(SHOTS, `${label}-1-pick-client.png`) });

  await page.selectOption('#addSkuClient', CLIENT);
  ok(await page.$eval('#addSkuSave', b => !b.disabled), `${label}: picking ${CLIENT} unlocks the form`);

  // Duplicate refusal, in words.
  await page.fill('#addSkuCode', 'demo-exist'); await page.fill('#addSkuName', 'Try a duplicate');
  await page.click('#addSkuSave');
  await page.waitForFunction(() => !document.getElementById('addSkuError').classList.contains('hidden'));
  const err = await page.$eval('#addSkuError', e => e.innerText);
  ok(/already exists/.test(err), `${label}: duplicate refused in words ("${err.slice(0, 70)}")`);
  await page.screenshot({ path: path.join(SHOTS, `${label}-2-duplicate-refused.png`) });

  // The good one.
  await page.fill('#addSkuCode', sku);
  await page.fill('#addSkuName', 'Stainless tumbler 500ml');
  await page.fill('#addSkuBarcode', label === 'desktop' ? '9551234500011' : '9551234500028');
  await page.fill('#addSkuBrand', 'Demo');
  await page.screenshot({ path: path.join(SHOTS, `${label}-3-filled.png`) });
  await page.click('#addSkuSave');
  try { await page.waitForFunction(() => document.getElementById('invAddSkuOverlay').classList.contains('hidden'), null, { timeout: 10000 }); }
  catch (e) { await page.screenshot({ path: path.join(SHOTS, `${label}-FAIL.png`) }); throw new Error('overlay did not close: ' + await page.$eval('#addSkuError', x => x.innerText)); }
  try { await page.waitForFunction(s => document.body.innerText.includes(s), sku, { timeout: 10000 }); } catch (e) { await page.screenshot({ path: path.join(SHOTS, `${label}-FAIL2.png`) }); throw new Error('sku not on screen; invClient=' + await page.$eval('#invClient', i => i.value) + ' note=' + await page.$eval('#invAddSkuNote', e => e.className + ' ' + e.innerText)); }
  const note = await page.$eval('#invAddSkuNote', e => e.innerText);
  ok(note.includes(sku), `${label}: confirmation names the SKU ("${note.slice(0, 80)}")`);
  ok(await page.$eval('#invClient', i => i.value) === CLIENT, `${label}: stock list switched to ${CLIENT}`);
  const hs = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok(hs, `${label}: no sideways scroll`);
  await page.screenshot({ path: path.join(SHOTS, `${label}-4-added.png`), fullPage: false });
  await ctx.close();
}

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.mkdirSync(SHOTS, { recursive: true });
  kid = spawn('node', [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')], detached: true });
  let browser;
  try {
    await waitUp(B + '/api/version'); await sleep(2500);
    const tok = (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
    const ws = XLSX.utils.aoa_to_sheet([['SKU', 'Product Name', 'Barcode'], ['DEMO-EXIST', 'Existing mug', '9551234500004']]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const fd = new FormData(); fd.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'm.xlsx');
    await fetch(B + `/api/master/client-profiles/${CLIENT}/item-master`, { method: 'POST', headers: { 'x-auth-token': tok, 'x-master-key': MASTER }, body: fd });
    browser = await chromium.launch(process.env.TEST_CHROMIUM ? { executablePath: process.env.TEST_CHROMIUM } : {});
    await run(browser, 'pixel5', { ...devices['Pixel 5'] }, 'DEMO-TUMBLER-2');
    await run(browser, 'desktop', { viewport: { width: 1280, height: 860 } }, 'DEMO-TUMBLER-1');
  } catch (e) { ok(false, 'threw: ' + e.message); }
  finally { if (browser) await browser.close(); try { process.kill(-kid.pid, 'SIGTERM'); } catch {} await sleep(800); }
  console.log(`\n${fails.length ? 'FAILED' : 'ALL PASSED'} (${fails.length} failure(s))`);
  process.exit(fails.length ? 1 : 0);
})();
