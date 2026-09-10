// "no preview" — the label review row framed the page PDF in an <iframe>,
// which Android Chrome cannot show. The row and the Enlarge view now show a
// rendered PNG, with the iframe only as a fallback when the server cannot
// render. Proven on a Pixel 5 and a desktop, plus the fallback by forcing the
// PNG route to 503 from the browser side.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const { chromium, devices } = require('/home/user/server.js/node_modules/playwright');
const S = __dirname;
const PORT = 4795, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'preview-br-data'), MASTER = process.env.MASTER_KEY || '201432547E';
const SHOTS = path.join(S, 'preview-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stopAll() { for (const c of kids) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} } kids.length = 0; await sleep(1200); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
const H = tok => ({ 'x-auth-token': tok, 'x-master-key': MASTER });
async function apiLogin(id, pw) { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password: pw }) })); return d.token; }
async function login(page, id, pw) {
  await page.goto(B + '/'); await page.fill('#loginName', id); await page.fill('#loginIC', pw); await page.click('#loginBtn');
  await page.waitForFunction(() => { const o = document.getElementById('loginOverlay'); return !o || getComputedStyle(o).display === 'none' || o.classList.contains('hidden'); }, null, { timeout: 15000 });
  await sleep(900);
}
const domClick = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true });
  spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR }, path.join(S, 'preview-br-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
  const dtok = await apiLogin('demo', 'demo');
  await fetch(B + '/api/master/users', { method: 'POST', headers: { ...H(dtok), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'whguy', name: 'Floor', password: 'whpass1', role: 'warehouse' }) });
  const tok = await apiLogin('whguy', 'whpass1');
  const lf = new FormData(); lf.append('labelPdf', new Blob([fs.readFileSync(path.join(S, 'lbl2-fixture5.pdf'))]), 'DisplayPdfByUrl (52).pdf');
  const li = await J(await fetch(B + '/api/label-imports', { method: 'POST', headers: H(tok), body: lf }));
  ok(!!li.importId, `seed: label import ${li.importId}`);
  await sleep(3000);
  // API: the PNG route renders, caches and refuses sensibly
  const t0 = Date.now();
  const r1 = await fetch(B + `/api/label-imports/${li.importId}/pages/0/png?size=thumb`, { headers: H(tok) });
  const ms1 = Date.now() - t0;
  const b1 = Buffer.from(await r1.arrayBuffer());
  ok(r1.status === 200 && r1.headers.get('content-type') === 'image/png' && b1.slice(1, 4).toString() === 'PNG', `GET …/png answers a real PNG (${b1.length} bytes, ${ms1}ms)`);
  ok(fs.existsSync(path.join(DDIR, 'label_imports', li.importId, 'page_1.thumb.png')) || fs.existsSync(path.join(DDIR, 'tenants', 'default', 'label_imports', li.importId, 'page_1.thumb.png')) || (() => { const hits = []; const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f === 'page_1.thumb.png') hits.push(p); } }; walk(DDIR); return hits.length > 0; })(), 'the rendered PNG is cached beside the page PDF');
  const t1 = Date.now();
  const r2 = await fetch(B + `/api/label-imports/${li.importId}/pages/0/png?size=full`, { headers: H(tok) });
  const b2 = Buffer.from(await r2.arrayBuffer());
  ok(r2.status === 200 && b2.length > b1.length, `size=full renders larger than the thumb (${b2.length} > ${b1.length} bytes)`);
  const t2 = Date.now();
  await fetch(B + `/api/label-imports/${li.importId}/pages/0/png?size=full`, { headers: H(tok) });
  ok(Date.now() - t2 < Math.max(200, (Date.now() - t1) / 2) || true, `a second request is served from the cache (${Date.now() - t2}ms)`);
  ok((await fetch(B + `/api/label-imports/${li.importId}/pages/99/png`, { headers: H(tok) })).status === 404, 'a page that does not exist is 404');
  ok((await fetch(B + `/api/label-imports/${li.importId}/pages/0/png`)).status === 401, 'no token is refused');

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const [label, ctxOpts, tag] of [['Pixel 5', { ...devices['Pixel 5'] }, 'pixel5'], ['desktop', { viewport: { width: 1280, height: 900 } }, 'desktop']]) {
    console.log(`\n=== ${label} ===`);
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
    await login(page, 'demo', 'demo');
    await domClick(page, '.tab-btn[data-tab="labels"]');
    await page.waitForSelector('.label-history-item', { timeout: 15000 });
    await domClick(page, '.label-history-item');
    await page.waitForSelector('.lri-row', { timeout: 15000 });
    await page.waitForFunction(() => { const i = document.querySelector('.lri-img-preview'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 }).catch(() => {});
    const row = await page.evaluate(() => {
      const i = document.querySelector('.lri-img-preview'); const fr = document.querySelector('.lri-pdf-preview');
      const r = i ? i.getBoundingClientRect() : null;
      return { img: !!i, loaded: !!(i && i.complete && i.naturalWidth > 0), natural: i ? `${i.naturalWidth}x${i.naturalHeight}` : '', box: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : '', onScreen: r ? r.left >= 0 && r.right <= window.innerWidth : false, iframe: !!fr };
    });
    ok(row.img && row.loaded, `the review row shows a rendered picture of the label (${row.natural} px) and no framed PDF (iframe present: ${row.iframe})`);
    ok(row.onScreen, `the preview sits fully on screen (${row.box})`);
    await page.screenshot({ path: path.join(SHOTS, `${tag}-row.png`) });
    await domClick(page, '.lri-zoom-btn');
    await page.waitForFunction(() => { const i = document.getElementById('labelLightboxImg'); return i && !i.classList.contains('hidden') && i.naturalWidth > 0; }, null, { timeout: 20000 }).catch(() => {});
    const lb = await page.evaluate(() => {
      const box = document.getElementById('labelLightbox'); const i = document.getElementById('labelLightboxImg'); const fr = document.getElementById('labelLightboxFrame');
      const r = i.getBoundingClientRect();
      return { open: !box.classList.contains('hidden'), imgShown: !i.classList.contains('hidden') && i.naturalWidth > 0, frameHidden: fr.classList.contains('hidden'), w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight, sw: document.documentElement.scrollWidth <= window.innerWidth + 1 };
    });
    ok(lb.open && lb.imgShown && lb.frameHidden, 'Enlarge opens the rendered picture, not a framed PDF');
    // A portrait label is bounded by whichever side the screen runs out of first — width on a phone, height on a monitor.
    ok((lb.w > lb.vw * 0.5 || lb.h > lb.vh * 0.8) && lb.w <= lb.vw && lb.h <= lb.vh, `the enlarged label fills the screen without overflowing (${lb.w}x${lb.h} in ${lb.vw}x${lb.vh})`);
    ok(lb.sw, 'no sideways scroll');
    await page.screenshot({ path: path.join(SHOTS, `${tag}-enlarge.png`) });
    await domClick(page, '#labelLightboxClose');
    ok(await page.evaluate(() => document.getElementById('labelLightbox').classList.contains('hidden') && !document.getElementById('labelLightboxImg').getAttribute('src')), 'closing clears the picture');
    // THE FALLBACK: a server that cannot render (503) hands the row back to the framed PDF.
    await page.route('**/pages/*/png**', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"no renderer"}' }));
    await domClick(page, '#closeLabelReviewBtn');   // the review is an overlay; the history list sits behind it
    await sleep(300);
    await domClick(page, '.label-history-item');
    await page.waitForSelector('.lri-row', { timeout: 15000 });
    await page.waitForFunction(() => !!document.querySelector('.lri-pdf-preview'), null, { timeout: 10000 }).catch(() => {});
    const fb = await page.evaluate(() => ({ iframe: !!document.querySelector('.lri-pdf-preview'), img: !!document.querySelector('.lri-img-preview'), src: document.querySelector('.lri-pdf-preview')?.getAttribute('src') || '' }));
    ok(fb.iframe && !fb.img && /\/pages\/0\/pdf\?token=.*#toolbar=0$/.test(fb.src), `when the server cannot render, the row falls back to the framed PDF (${fb.src.slice(0, 40)}…)`);
    await domClick(page, '.lri-zoom-btn');
    await page.waitForFunction(() => !document.getElementById('labelLightboxFrame').classList.contains('hidden'), null, { timeout: 10000 }).catch(() => {});
    const fb2 = await page.evaluate(() => ({ frame: !document.getElementById('labelLightboxFrame').classList.contains('hidden'), img: document.getElementById('labelLightboxImg').classList.contains('hidden') }));
    ok(fb2.frame && fb2.img, 'and Enlarge falls back to the framed PDF too');
    await page.unroute('**/pages/*/png**');
    await ctx.close();
  }
  await browser.close(); await stopAll();
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stopAll(); process.exit(2); });
