// "ZORT HAS LABELS. WHY I CANT PULL?" — the second report, and this time the
// channel was blameless three ways over.
//
// Reported live (17 Sep 2026) with three screenshots: ZORT's own Sell list
// showing four Lazada orders Completed, each tagged `Label`; IdealOne's Orders
// list showing the same four with waybills and "⏳ Getting label…"; and the
// 🏷 Get Labels dialog reading "0 of 4 Ready-to-Ship label(s) came in" with
// every row "still queued" and NO reason after it. A blank reason is the
// tell — `lastError` is only empty on an entry that was never ATTEMPTED.
//
// Three defects, all ours, all in the same path:
//   1. THE TAP WAS A DEAD BUTTON FOR 8 SECONDS. Opening the scan overlay fires
//      /waybill-now with auto:true, which since the lag fix does nothing but
//      make the label due — no `askedAt`, no drain — and it started the
//      cooldown clock. The packer's tap inside that window was refused with
//      "Asked a moment ago", from the ONE path that stamps `askedAt` (the
//      exemption from the per-pass browser budget) and the ONE path that
//      actually drains.
//   2. 🏷 GET LABELS REPORTED ITS OWN COLLISION AS THE CHANNEL'S ANSWER.
//      drainZortOutbox holds a reentry guard for the 30s scheduler, and a
//      browser label fetch can hold a pass for a minute. The old loop awaited
//      twelve instant no-ops, read the entries back untouched and called them
//      "still queued".
//   3. THE BUTTON WAS CAPPED AT 2 BROWSER LABELS A PASS. `askedAt` was stamped
//      only by a per-order tap, so the one control meaning "fetch them all"
//      was the one path the cap always applied to.
//
// The mock is a ZORT that has every label and hands over every one of them, so
// anything that does not come in here is this side's doing.
//
// SERVER_JS=<path> points it at another build — the pre-fix build fails the
// tap check and reports "still queued" for labels it never asked about.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const S = __dirname;
const PORT = 4793, MPORT = 4794, B = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
const MASTER = process.env.MASTER_KEY || '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kids = [];
function spawnLogged(args, env, log) {
  const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true });
  kids.push(c); return c;
}
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stop(c) { if (!c) return; try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} await sleep(1500); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };

let tok = '';
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': tok, 'x-master-key': MASTER });
async function login() {
  const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }));
  tok = d.token;
}
const SERVER = process.env.SERVER_JS || path.join(__dirname, '../../server.js');
// ZORT_OUTBOX_MS is left LONG on purpose: the background cadence must not be
// what rescues a label during a check, or the checks prove nothing. The one
// collision this suite needs is created deliberately, by starting a drain and
// not waiting for it.
const BASE_ENV = {
  PORT: String(PORT), ZORT_WEB_BASE: M,
  ZORT_LABEL_RETRY_MS: '2000', ZORT_BACKOFF_MS: '2000', ZORT_OUTBOX_MS: '30000',
  ZORT_WEB_PROBE_DELAY_MS: '1200', ZORT_WEB_PDF_WAIT_MS: '5000', ZORT_WEB_NAV_TIMEOUT: '10000',
  ZORT_BROWSER_PATH: (process.env.TEST_CHROMIUM || '/opt/pw-browsers/chromium'),
};
async function boot(ddir, extra) {
  fs.rmSync(ddir, { recursive: true, force: true }); fs.mkdirSync(ddir, { recursive: true });
  const c = spawnLogged([SERVER], { ...BASE_ENV, DATA_DIR: ddir, ...extra }, path.join(S, 'getlabels-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500); await login();
  const st = await J(await fetch(B + '/api/master/zort/stores', {
    method: 'POST', headers: H(),
    body: JSON.stringify({ clientName: 'GL', storename: 'gl', apikey: 'k', apisecret: 's', endpoint: M, enabled: true, labelSync: true, webEmail: 'gl@example.com', webPassword: 'pw' }),
  }));
  const storeId = st.id || (st.store && st.store.id);
  await J(await fetch(B + `/api/master/zort/stores/${storeId}/pull`, { method: 'POST', headers: H(), body: '{}' }));
  // THE STOCK GATE IS REAL AND MUST BE SATISFIED HONESTLY. 🏷 Get Labels skips
  // an order our own verdict reads as none/partial — no RTS, no label — and
  // the sync harvests each SKU into the catalogue at ZERO, which reads as
  // "no stock". The live account shows ✓ Stock OK on all four, so the fixture
  // has to as well, or the suite would be exercising the skip path instead of
  // the fetch path.
  const adj = await J(await fetch(B + '/api/inventory/GL-SKU/adjust', {
    method: 'POST', headers: H(),
    body: JSON.stringify({ clientId: 'GL', qty: 50, reason: 'opening stock for the fixture', password: MASTER }),
  }));
  if (process.env.DEBUG_REP) console.log('ADJ:', JSON.stringify(adj).slice(0, 300));
  await sleep(2000);   // db.json is a deferred write
  return { c, storeId };
}
const dbOf = ddir => JSON.parse(fs.readFileSync(path.join(ddir, 'tenants', 'default', 'db.json'), 'utf8'));
const labelJobs = ddir => (dbOf(ddir).zortOutbox || []).filter(e => e.kind === 'label');
const hits = async () => J(await fetch(M + '/_hits'));
const resetHits = async () => J(await fetch(M + '/_reset'));
const attached = async n => {
  const rows = await J(await fetch(B + '/api/orders?range=all', { headers: H() }));
  return !!(Array.isArray(rows) ? rows : []).find(o => o.order_number === n)?.has_order_label;
};
const waybillNow = async (n, body) => J(await fetch(B + `/api/orders/${n}/waybill-now`, { method: 'POST', headers: H(), body: JSON.stringify(body || {}) }));
const getLabels = async id => J(await fetch(B + `/api/master/zort/stores/${id}/labels/retry`, { method: 'POST', headers: H(), body: '{}' }));

(async () => {
  const mock = spawnLogged([path.join(S, 'getlabels-mock.js'), String(MPORT), '1200'], {}, path.join(S, 'getlabels-mock.log'));
  await waitUp(M + '/_hits');

  // ══ BOOT 1 — the reported shape, at the shipped defaults ═════════════════
  const D1 = path.join(S, 'getlabels-data-1');
  let { c: srv, storeId } = await boot(D1, {});
  const jobs = labelJobs(D1);
  ok(jobs.length === 4, `four RTS'd orders pulled, four label jobs queued (${jobs.length})`);
  ok(!(await attached('GL-1001')), 'and no label is attached yet — the state on the screenshot');

  // ── 1. THE TAP IS NOT A DEAD BUTTON ──────────────────────────────────────
  // Opening the order fires the AUTO ask. It must queue and nothing more.
  await resetHits();
  const auto = await waybillNow('GL-1001', { auto: true });
  ok(auto.queued === true, 'opening the order QUEUES the label and does not run the browser in the request');
  ok(!(await attached('GL-1001')), 'so nothing is attached by opening it');
  const afterAuto = await hits();
  ok(afterAuto.printpage === 0, 'the open opened no print page (the lag fix still holds)');

  // A repeat AUTO ask inside the window IS still refused — a rate limit on the
  // hub calls is what the cooldown is for, and that part was never wrong.
  // Checked HERE, while the window is genuinely still open: the tap below
  // holds the screen for seconds and would outlive it.
  const auto2 = await waybillNow('GL-1001', { auto: true });
  ok(auto2.cooled === true, 'a repeat AUTO ask inside the window is still refused — the hub is not asked twice');

  // NOW THE TAP, inside the 8s cooldown the open just started. This is the
  // exact sequence from the screenshot: "Asked a moment ago — waiting for that
  // to land." on the one button that can do the work.
  const tap = await waybillNow('GL-1001', {});
  ok(tap.cooled !== true, 'a hand TAP inside the cooldown is NOT refused as a dead button');
  let got1 = await attached('GL-1001');
  for (let i = 0; i < 20 && !got1; i++) { await sleep(1000); got1 = await attached('GL-1001'); }
  ok(got1, 'the tap fetched the label through the browser and attached it');
  const afterTap = await hits();
  ok(afterTap.pdf >= 1, 'the PDF really came off ZORT\'s signed-in print page');
  // AND IT COST NO EXTRA RELAY. The hub was asked a second ago; the cooled tap
  // skips the status read and the detail read and goes straight for the label.
  ok(afterTap.detail === afterAuto.detail,
     `the cooled tap made NO extra order-detail call to ZORT (${afterAuto.detail} → ${afterTap.detail})`);
  ok(afterTap.getorders === afterAuto.getorders,
     `and no extra GetOrders (${afterAuto.getorders} → ${afterTap.getorders})`);

  // ── 2 & 3. 🏷 GET LABELS AGAINST A HELD GUARD ────────────────────────────
  // Start a background drain and DO NOT wait for it, so the reentry guard is
  // genuinely held when the button runs — the collision that produced
  // "0 of 4 … still queued".
  await resetHits();
  const bg = fetch(B + '/api/master/zort/outbox/drain', { method: 'POST', headers: H(), body: '{}' }).catch(() => {});
  await sleep(300);   // let it take the guard
  const rep = await getLabels(storeId);
  if (process.env.DEBUG_REP) console.log("REP:", JSON.stringify(rep).slice(0,600));
  ok(rep.asked === 3, `Get Labels asked for the three remaining RTS'd orders (${rep.asked})`);
  ok(rep.attached === 3, `all ${rep.asked} came in — reported ${rep.attached}`);
  ok((rep.stillWaiting || []).length === 0, 'nothing is left reported as waiting');
  const stale = (rep.stillWaiting || []).concat(rep.failed || []).filter(r => /^still queued$/.test(String(r.why || '')));
  ok(stale.length === 0, 'and no row says the bare "still queued" that reported our own no-op as the channel\'s answer');
  for (const n of ['GL-1002', 'GL-1003', 'GL-1004']) ok(await attached(n), `${n} carries its label`);
  await bg;

  // The labels really came from the browser, not from thin air.
  const h2 = await hits();
  ok(h2.pdf >= 3, `three more PDFs were captured off the print viewer (${h2.pdf})`);
  await stop(srv); srv = null;

  // ══ BOOT 2 — the exemption is BOUNDED ════════════════════════════════════
  // "Fetch them now" must not mean "run fifty browser sessions back to back",
  // which is the lag this budget exists to prevent.
  const D2 = path.join(S, 'getlabels-data-2');
  const b2 = await boot(D2, { ZORT_WEB_ASKED_MAX: '2', ZORT_WEB_MAX_PER_PASS: '1' });
  srv = b2.c;
  const rep2 = await getLabels(b2.storeId);
  await sleep(1500);
  if (process.env.DEBUG_REP) console.log("REP2:", JSON.stringify(rep2).slice(0,600));
  // ONE browser fetch per pass, exemption capped at TWO: exactly the two
  // exempted orders can come in during the run. That measures the bound in
  // both directions — the button is no longer throttled to the background
  // budget, and it cannot run four browser sessions back to back either.
  ok(rep2.attached === 2, `exactly the two exempted orders came in (${rep2.attached}) — the exemption is bounded`);
  ok((rep2.stillWaiting || []).length === 2,
     'the other two are reported as queued for the next pass, not as failures');
  ok(/background queue/i.test(String(rep2.note || '')),
     'and the dialog SAYS the rest are on the background queue rather than leaving them looking stuck');
  await stop(srv); srv = null;

  for (const k of kids) await stop(k);
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASSED'));
  fails.forEach(f => console.log('  x ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); for (const k of kids) await stop(k); process.exit(2); });
