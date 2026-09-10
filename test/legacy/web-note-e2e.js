// "ZORT HAS LABELS. WHY I CANT PULL?" — the tap has to name the gate.
// Against the webtest mock (API + a print-viewer page whose PDF needs a
// session): the API only ever hands out a print-page link, so the browser
// worker is the only way in. Three boots prove each answer the tap can give:
//   A. browser cannot launch here (bogus ZORT_BROWSER_PATH) — said on the tap,
//      the store form and the health check;
//   B. no web login on the store — said on the tap; then the breaker tripped;
//      then the login saved → the browser fetches the label and attaches it.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const S = '/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad';
const PORT = 4781, MPORT = 4782, B = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
const DDIR = path.join(S, 'web-note-data'), DBP = path.join(DDIR, 'tenants', 'default', 'db.json');
const MASTER = process.env.MASTER_KEY || '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); let kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stop(c) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} await sleep(1500); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
let tok = '';
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': tok, 'x-master-key': MASTER });
async function login() { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) })); tok = d.token; }
const readDb = async () => { await sleep(1500); return JSON.parse(fs.readFileSync(DBP, 'utf8')); };
const BASE_ENV = { PORT: String(PORT), DATA_DIR: DDIR, ZORT_WEB_BASE: M, ZORT_LABEL_RETRY_MS: '2000', ZORT_BACKOFF_MS: '2000', ZORT_OUTBOX_MS: '2000', ZORT_WEB_PROBE_DELAY_MS: '1500', ZORT_WEB_PDF_WAIT_MS: '6000' };
async function bootServer(extra) { const c = spawnLogged([process.env.SERVER_JS || '/home/user/server.js/server.js'], { ...BASE_ENV, ...extra }, path.join(S, 'web-note-server.log')); await waitUp(B + '/api/version'); await sleep(2500); await login(); return c; }
const tap = async n => J(await fetch(B + `/api/orders/${n}/waybill-now`, { method: 'POST', headers: H(), body: '{}' }));
const stepsOf = d => (Array.isArray(d.steps) ? d.steps : []).join(' | ');
const health = async () => J(await fetch(B + '/api/master/connections/health', { headers: H() }));
const stores = async () => J(await fetch(B + '/api/master/zort/stores', { headers: H() }));

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.mkdirSync(DDIR, { recursive: true });
  const mock = spawnLogged([path.join(S, 'web-note-mock.js'), String(MPORT)], {}, path.join(S, 'web-note-mock.log'));
  await waitUp(M + '/x');

  // ── Boot 0: create the store and pull, so the later boots' probes see it ──
  let srv = await bootServer({ ZORT_BROWSER_DISABLED: 'true' });
  let st = await J(await fetch(B + '/api/master/zort/stores', { method: 'POST', headers: H(), body: JSON.stringify({ clientName: 'WT', storename: 'wt', apikey: 'k', apisecret: 's', endpoint: M, enabled: true, labelSync: true, webEmail: 'wt@example.com', webPassword: 'pw' }) }));
  const storeId = st.id || (st.store && st.store.id) || (await stores()).find(s => s.clientName === 'WT')?.id;
  ok(!!storeId, `store created (${storeId})`);
  await J(await fetch(B + `/api/master/zort/stores/${storeId}/pull`, { method: 'POST', headers: H(), body: '{}' }));
  await sleep(2500);
  let d = await tap('WT-RTS'); let steps = stepsOf(d);
  ok(/disabled by ZORT_BROWSER_DISABLED/.test(steps), `tap 0 names the gate: worker disabled (${steps.slice(0, 200)})`);
  await stop(srv);
  // ── Boot A: a browser that cannot launch ─────────────────────────────────
  srv = await bootServer({ ZORT_BROWSER_PATH: '/nonexistent/chromium' });
  await sleep(3000);   // the boot probe fires at 1.5s
  let h = await health();
  ok(h.labelBrowser && h.labelBrowser.available === false && /could not be launched/i.test(h.labelBrowser.why), `health: the browser cannot run here, said in words (${(h.labelBrowser || {}).why || ''})`.slice(0, 200));
  let sl = await stores(); let s0 = (Array.isArray(sl) ? sl : []).find(s => s.id === storeId) || {};
  ok(s0.webWorkerAvailable === false && /could not be launched/i.test(s0.webWorkerWhy || ''), `store form: webWorkerAvailable=false with the launch reason`);
  d = await tap('WT-RTS');
  steps = stepsOf(d);
  ok(/only hands out a link to ZORT/.test(steps) && /cannot run on this server/.test(steps) && /could not be launched/.test(steps), `tap A names the gate: browser cannot run (${steps.slice(0, 260)})`);
  ok(/Labels tab/.test(steps) && !/Print it from th\b/.test(steps), 'the sentence is not truncated and says what to do meanwhile');
  let db = await readDb();
  let e = (db.zortOutbox || []).find(x => x.kind === 'label' && x.orderNumber === 'WT-RTS');
  ok(e && /could not be launched/.test(e.webNote || '') && e.lastError.length > 200, `the outbox entry carries webNote and an untruncated lastError (${(e || {}).lastError?.length} chars)`);
  const au = (db.auditLog || []).filter(x => x.type === 'sync_label_unusable').pop();
  ok(au && /could not be launched/.test(au.browser || ''), 'the audit row says what the browser said');
  ok(!JSON.stringify(au || {}).includes('_printpage'), 'no label URL on the trail');
  await stop(srv);

  // ── Boot B: the browser launches; the store has no web login yet ─────────
  {
    const raw = JSON.parse(fs.readFileSync(DBP, 'utf8'));
    const s = raw.zortStores.find(x => x.id === storeId); s.webEmail = ''; delete s.webPassword; s.webLoginFailed = false;
    raw.zortOutbox = (raw.zortOutbox || []).filter(x => x.kind !== 'label');
    fs.writeFileSync(DBP, JSON.stringify(raw));
  }
  srv = await bootServer({ ZORT_BROWSER_PATH: '/opt/pw-browsers/chromium' });
  h = await health();
  ok(h.labelBrowser && (h.labelBrowser.stores || []).some(s => s.client === 'WT' && s.webLoginSet === false && s.ready === false), 'health: the store is named as having no web login');
  d = await tap('WT-RTS'); steps = stepsOf(d);
  ok(/NO ZORT WEB LOGIN is saved/.test(steps) && /ZORT web login/.test(steps), `tap B1 names the gate: no web login, and where to set it (${steps.slice(0, 200)})`);
  ok(!(((await readDb()).orderLabels || {})['WT-RTS']), 'nothing attached');
  // The breaker
  {
    await stop(srv);
    const raw = JSON.parse(fs.readFileSync(DBP, 'utf8'));
    const s = raw.zortStores.find(x => x.id === storeId); s.webEmail = 'wt@example.com'; s.webPassword = 'pw'; s.webLoginFailed = true;
    fs.writeFileSync(DBP, JSON.stringify(raw));
    srv = await bootServer({ ZORT_BROWSER_PATH: '/opt/pw-browsers/chromium' });
    await sleep(4000);   // the boot probe launches Chromium at 1.5s
  }
  h = await health();
  ok((h.labelBrowser.stores || []).some(s => s.client === 'WT' && s.loginBreakerTripped === true), 'health: the breaker is shown tripped');
  ok(h.labelBrowser.available === true && !!h.labelBrowser.launchTestedAt, `health: the browser launched at boot (tested ${h.labelBrowser.launchTestedAt})`);
  d = await tap('WT-RTS'); steps = stepsOf(d);
  ok(/last sign-in to ZORT FAILED/.test(steps) && /re-saved/.test(steps), `tap B2 names the gate: breaker tripped (${steps.slice(0, 200)})`);
  // Re-save the password → breaker clears → the browser fetches the label
  await J(await fetch(B + '/api/master/zort/stores', { method: 'POST', headers: H(), body: JSON.stringify({ id: storeId, webPassword: 'pw' }) }));
  await sleep(9000);   // the tap's own 8s per-order cooldown
  d = await tap('WT-RTS'); steps = stepsOf(d);
  ok(/fetched and attached|fetching the label right now/.test(steps), `tap B3: attached, or honestly "still fetching" (${steps.slice(0, 200)})`);
  let attached = false;
  for (let i = 0; i < 30 && !attached; i++) { await sleep(2000); attached = !!(((await J(await fetch(B + '/api/orders?range=all', { headers: H() }))) || []).find?.(o => o.order_number === 'WT-RTS')?.has_order_label); }
  ok(attached, 'the browser worker fetched the PDF from the print page and the label is on the order');
  db = await readDb();
  ok((db.auditLog || []).some(x => x.type === 'sync_label_via_fallback' && x.via === 'web-browser' && x.order === 'WT-RTS'), 'audited as fetched via the browser');
  ok(!(db.zortOutbox || []).some(x => x.kind === 'label' && x.orderNumber === 'WT-RTS'), 'the outbox entry is gone');
  await stop(srv); await stop(mock);
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); for (const c of kids) await stop(c); process.exit(2); });
