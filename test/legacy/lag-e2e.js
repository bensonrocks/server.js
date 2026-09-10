// "users are experiencing a lag" — the label browser must not run
// continuously beside the app. Against lag-mock (four RTS'd labels, one of
// which actually has a PDF):
//   Boot 1 (cap 1 browser fetch per pass, 10-min wait after a browser miss):
//     the first pass tries ONE label in the browser and HOLDS the rest
//     (attempts 0, "queued for the next pass"); a label the browser could not
//     get waits ~10 min instead of the 2s ladder; the label that exists still
//     attaches; after a minute no label has been browser-tried twice.
//   Boot 2 (cap 0): the background drain never opens the browser at all, and
//     a TAP on the order's pill still fetches it (exempt from the cap).
//   Boot 3 (browser disabled, pass budget 1ms): entries past the clock are
//     held for the next pass and the health check says how many.
// SERVER_JS=<path> points it at another build — the pre-fix build fails the
// cap and long-wait checks (attempts climb every pass).
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const S = __dirname;
const PORT = 4791, MPORT = 4792, B = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
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
const BASE_ENV = { PORT: String(PORT), ZORT_WEB_BASE: M, ZORT_LABEL_RETRY_MS: '2000', ZORT_BACKOFF_MS: '2000', ZORT_OUTBOX_MS: '3000',
  ZORT_WEB_PROBE_DELAY_MS: '1500', ZORT_WEB_PDF_WAIT_MS: '1500', ZORT_WEB_NAV_TIMEOUT: '8000', ZORT_BROWSER_PATH: '/opt/pw-browsers/chromium' };
const SERVER = process.env.SERVER_JS || '/home/user/server.js/server.js';
async function boot(ddir, extra) {
  fs.rmSync(ddir, { recursive: true, force: true }); fs.mkdirSync(ddir, { recursive: true });
  const c = spawnLogged([SERVER], { ...BASE_ENV, DATA_DIR: ddir, ...extra }, path.join(S, 'lag-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500); await login();
  const st = await J(await fetch(B + '/api/master/zort/stores', { method: 'POST', headers: H(), body: JSON.stringify({ clientName: 'LG', storename: 'lg', apikey: 'k', apisecret: 's', endpoint: M, enabled: true, labelSync: true, webEmail: 'lg@example.com', webPassword: 'pw' }) }));
  const storeId = st.id || (st.store && st.store.id);
  await J(await fetch(B + `/api/master/zort/stores/${storeId}/pull`, { method: 'POST', headers: H(), body: '{}' }));
  return { c, storeId };
}
const dbOf = ddir => JSON.parse(fs.readFileSync(path.join(ddir, 'tenants', 'default', 'db.json'), 'utf8'));
const labelsOf = ddir => (dbOf(ddir).zortOutbox || []).filter(e => e.kind === 'label');
const health = async () => J(await fetch(B + '/api/master/connections/health', { headers: H() }));
const tap = async n => J(await fetch(B + `/api/orders/${n}/waybill-now`, { method: 'POST', headers: H(), body: '{}' }));
const attached = async n => !!(((await J(await fetch(B + '/api/orders?range=all', { headers: H() }))) || []).find?.(o => o.order_number === n)?.has_order_label);

(async () => {
  const mock = spawnLogged([path.join(S, 'lag-mock.js'), String(MPORT)], {}, path.join(S, 'lag-mock.log'));
  await waitUp(M + '/_hits');

  // ── Boot 1: one browser fetch per pass, a browser miss waits 10 minutes ──
  const D1 = path.join(S, 'lag-data-1');
  let { c: srv } = await boot(D1, { ZORT_WEB_MAX_PER_PASS: '1', ZORT_WEB_RETRY_MS: '600000' });
  await sleep(2000);   // db.json is a deferred write
  ok(labelsOf(D1).length === 4, `four label jobs queued (${labelsOf(D1).length})`);
  // The first pass: one browser attempt, the other three held.
  let sawDeferred = false, sawTwoInOnePass = false, maxFetches = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const ls = labelsOf(D1);
    if (ls.some(e => (e.attempts || 0) === 0 && /queued for the next pass/.test(e.lastError || ''))) sawDeferred = true;
    const h = await health(); const lp = h.labelBrowser?.lastPass || {};
    maxFetches = Math.max(maxFetches, lp.browserFetches || 0);
    if ((lp.browserFetches || 0) > 1) sawTwoInOnePass = true;
    if (ls.some(e => e.orderNumber === 'LG-NOPDF1' && (e.attempts || 0) >= 1) && sawDeferred) break;
  }
  ok(sawDeferred, 'labels past the per-pass cap are HELD — attempts 0, "queued for the next pass"');
  ok(!sawTwoInOnePass && maxFetches === 1, `no pass made more than one browser fetch (max seen ${maxFetches})`);
  let e1 = labelsOf(D1).find(e => e.orderNumber === 'LG-NOPDF1');
  ok(e1 && e1.attempts === 1 && /produced no PDF/.test(e1.lastError || ''), `the first browser-tried label was tried once and says the page had no PDF (${(e1 || {}).lastError?.slice(0, 120)})`);
  const waitMs = e1 ? new Date(e1.nextAttemptAt).getTime() - Date.now() : 0;
  ok(waitMs > 8 * 60 * 1000, `…and waits the long interval, not the 2s ladder (${Math.round(waitMs / 1000)}s until the next try)`);
  let got = false;
  for (let i = 0; i < 45 && !got; i++) { await sleep(2000); got = await attached('LG-PDF'); }
  ok(got, 'the label that actually exists still comes in through the browser and attaches');
  // A minute on: nobody has been browser-tried twice.
  await sleep(20000);
  const ls1 = labelsOf(D1);
  ok(ls1.length === 3 && ls1.every(e => (e.attempts || 0) <= 1), `after a minute no label has been browser-tried twice (${ls1.map(e => `${e.orderNumber}:${e.attempts || 0}`).join(' ')})`);
  // Each browser attempt opens the page twice (open, sign in, open again) and
  // the API's one-hop HTML probe opens it once per hub read — so a handful
  // per attempt. The pre-fix build re-attempts every pass and opens dozens.
  const hits1 = await J(await fetch(M + '/_hits'));
  const tries1 = ls1.reduce((n, e) => n + (e.attempts || 0), 0) + 1;
  ok(hits1.empty <= 3 + 4 * tries1, `the empty print pages were opened a handful of times per attempt, not every 3s (${hits1.empty} opens over ${tries1 - 1} attempt(s))`);
  let h1 = await health();
  ok(h1.labelBrowser.budget && h1.labelBrowser.budget.browserFetchesPerPass === 1 && h1.labelBrowser.budget.retryAfterBrowserMins === 10, 'the health check states the limits');
  ok(typeof h1.labelBrowser.lastPass?.lastPassMs === 'number' && h1.labelBrowser.lastPass.lastPassAt, 'the health check carries the last pass in numbers');
  const au = (dbOf(D1).auditLog || []).filter(x => x.type === 'sync_label_unusable');
  ok(au.length >= 1 && au.length <= 4 && !au.some(x => /queued for the next pass/.test(x.browser || '')), `a held label writes no audit row (${au.length} unusable row(s), none for a hold)`);
  await stop(srv);

  // ── Boot 2: cap 0 — the background never opens the browser; a tap does ──
  const D2 = path.join(S, 'lag-data-2');
  const hits0 = await J(await fetch(M + '/_hits'));   // the mock's counters run across boots — measure deltas
  ({ c: srv } = await boot(D2, { ZORT_WEB_MAX_PER_PASS: '0', ZORT_WEB_RETRY_MS: '600000' }));
  await sleep(9000);
  const hits2a = await J(await fetch(M + '/_hits'));
  const ls2 = labelsOf(D2);
  ok(ls2.length === 4 && ls2.every(e => (e.attempts || 0) === 0 && /queued for the next pass/.test(e.lastError || '')), `with the cap at 0 the background drain holds every label and tries none (${ls2.map(e => e.attempts || 0).join(',')})`);
  let h2 = await health();
  ok((h2.labelBrowser.lastPass?.browserFetches || 0) === 0 && (h2.labelBrowser.lastPass?.heldForBudget || 0) >= 1, `the pass reports ${h2.labelBrowser.lastPass?.heldForBudget} held for budget and 0 browser fetches`);
  ok(h2.labelBrowser.labelsWaitingOnBrowser === 4, 'the health check counts the labels waiting on the browser');
  // A held label costs NO hub call: the API is asked once to learn it needs
  // the browser, then the hold is free — or fifteen waiting labels would
  // spend the 50,000/day quota on the same answer every 30 seconds.
  await sleep(7000);
  const hits2h = await J(await fetch(M + '/_hits'));
  ok(hits2h.labels === hits2a.labels && hits2a.labels - hits0.labels <= 6, `a held label makes no further hub calls (${hits2a.labels - hits0.labels} label reads this boot, then +${hits2h.labels - hits2a.labels} after two more passes)`);
  // OPENING an order (auto) only queues the fetch — no browser inside the
  // request, no exemption from the cap, and it answers at once.
  const t0 = Date.now();
  const dA = await J(await fetch(B + '/api/orders/LG-NOPDF2/waybill-now', { method: 'POST', headers: H(), body: JSON.stringify({ auto: true }) }));
  const openMs = Date.now() - t0;
  ok(dA.queued === true && openMs < 5000 && /queued/i.test((dA.steps || []).join(' ')), `opening an order queues the label fetch and answers in ${openMs}ms, running no browser in the request`);
  const hits2o = await J(await fetch(M + '/_hits'));
  ok(hits2o.empty === hits2a.empty && hits2o.printpage === hits2a.printpage, 'the open opened no print page');
  const ls = await J(await fetch(B + '/api/orders/LG-NOPDF2/label-status', { headers: H() }));
  ok(ls.ok === true && ls.hasLabel === false && ls.queued === true, `label-status is the cheap poll the screen uses (${JSON.stringify(ls).slice(0, 120)})`);
  await sleep(4000);
  const hits2p = await J(await fetch(M + '/_hits'));
  ok(hits2p.empty === hits2a.empty, 'and the background pass still honours the cap for an opened (not tapped) order');
  const d2 = await tap('LG-PDF');
  const steps = (d2.steps || []).join(' | ');
  ok(/fetched and attached|fetching the label right now/.test(steps), `a TAP is exempt from the cap: ${steps.slice(0, 160)}`);
  got = await attached('LG-PDF');
  for (let i = 0; i < 20 && !got; i++) { await sleep(2000); got = await attached('LG-PDF'); }
  ok(got, 'the tapped label attaches');
  const hits2b = await J(await fetch(M + '/_hits'));
  ok(hits2b.printpage > hits2a.printpage, 'the browser opened the print page for the tap and not before');
  ok(hits2b.empty === hits2a.empty, 'the other three print pages were never opened by the background drain');
  await stop(srv);

  // ── Boot 3: the pass clock — entries past it are held ──
  const D3 = path.join(S, 'lag-data-3');
  ({ c: srv } = await boot(D3, { ZORT_BROWSER_DISABLED: 'true', ZORT_DRAIN_MAX_MS: '1' }));
  await sleep(8000);
  let h3 = await health();
  ok((h3.labelBrowser.lastPass?.heldForTime || 0) >= 1, `entries past the pass clock are held for the next pass (${h3.labelBrowser.lastPass?.heldForTime} held)`);
  ok((h3.labelBrowser.lastPass?.entriesTried || 0) >= 1, 'and the pass still tried the first one');
  await stop(srv); await stop(mock);
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); for (const c of kids) await stop(c); process.exit(2); });
