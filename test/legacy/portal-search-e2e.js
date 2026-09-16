// THE CLIENT PORTAL COULD NOT FIND AN ORDER OLDER THAN THE PAGE.
//
// Reported live (16 Sep 2026) with a screenshot whose own tiles read
// 6 + 202 + 92 = EXACTLY 300 — the row cap on /api/portal/orders. The client
// searched 172636325960072 (completed 9 Sep, job IS-260909-18) and got
// "Nothing matches": the screen filters the array it already holds, so an
// order past the cap was unreachable by any term. The day table's oldest row
// was 10 Sep; the order finished on the 9th, one day over the edge.
//
// Proved here on a client holding MORE than the cap:
//   - the everyday call is unchanged — a bare array, exactly PORTAL_ORDERS_MAX
//   - the oldest order is genuinely absent from it (the reported symptom)
//   - ?q= finds it, by order number, waybill, GI, PO and pick ticket
//   - leading zeros and partial terms resolve
//   - a CANCELLED order is found too (the second trap: "All" hides those)
//   - X-Portal-Search-Total reports the count before the cap
//   - ANOTHER CLIENT'S order is never returned, however exact the term
//   - a login with the Orders section switched off is refused, search or not
//
// The pre-fix build fails the search checks: ?q= was ignored, so the route
// answered with the same newest-300 page and the old order was still absent.
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const S      = __dirname;
const PORT   = 4767;
const B      = `http://localhost:${PORT}`;
const DDIR   = path.join(S, 'psearch-data');
const DBP    = path.join(DDIR, 'tenants', 'default', 'db.json');
const LOG    = path.join(S, 'psearch.log');
const MASTER = process.env.MASTER_KEY || '201432547E';

const CLIENT = 'SEARCHCO';
const OTHER  = 'OTHERCO';
const CAP    = 300;          // PORTAL_ORDERS_MAX
const TOTAL  = 340;          // comfortably past it

const fails = [];
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child = null;
async function boot() {
  child = spawn('node', [path.join(__dirname, '../../server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR },
    stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')],
    detached: true,
  });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/api/version')).ok) return; } catch {} await sleep(500); }
  throw new Error('server did not boot');
}
async function stop() {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  child = null; await sleep(1500);
}
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };

// The oldest order — the one that falls off the page, and the one reported.
const OLDEST   = '172636325960072';
const OLD_WB   = 'LZSGD1015417137';
const OLD_GI   = 'GI-990001';
const OLD_PO   = 'PO-88812';
const CANCELLED_OLD = '172600000000001';   // also past the cap, and cancelled

function day(n) {                            // n days ago, YYYY-MM-DD
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
function seed() {
  const db = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  const orders = [];
  const states = {};
  // Newest first is how they are added; the oldest end is what the cap drops.
  for (let i = 0; i < TOTAL; i++) {
    const isOldest    = i === TOTAL - 1;
    const isCancelled = i === TOTAL - 2;
    const n = isOldest ? OLDEST : isCancelled ? CANCELLED_OLD : `ORD-${String(1000 + i)}`;
    orders.push({
      order_number: n,
      waybill_number: isOldest ? OLD_WB : `WB${String(900000 + i)}`,
      issue_no: isOldest ? OLD_GI : '',
      po_number: isOldest ? OLD_PO : '',
      pick_ticket: isOldest ? '0044521' : '',
      customer_name: 'Tan Wei Qing', carrier: 'Lazada', platform: 'Lazada',
      date: day(i), total_qty: 1,
      lines: [{ sku: 'AYMMGAF539DXXXXXXDGMY', description: 'Mayer 5.5L Air Fryer', qty: 1 }],
    });
    states[n] = isCancelled
      ? { status: 'unprocessed', unprocessed_at: new Date(Date.now() - i * 86400000).toISOString(),
          unprocessed_reason: 'Out of stock', scanned: {} }
      : { status: 'done', endTime: new Date(Date.now() - i * 86400000).toISOString(),
          scanned: { AYMMGAF539DXXXXXXDGMY: 1 } };
  }
  db.batches = [{
    id: 'batch-psearch', idealscan_code: 'IS-260909-18', client_name: CLIENT,
    filename: 'orders.xlsx', uploaded_at: new Date().toISOString(), uploaded_by: 'demo',
    orders, orderStates: states,
  }, {
    // ANOTHER CLIENT holding the SAME order number — isolation must hold even
    // on an exact-match search.
    id: 'batch-other', idealscan_code: 'IS-260909-19', client_name: OTHER,
    filename: 'other.xlsx', uploaded_at: new Date().toISOString(), uploaded_by: 'demo',
    orders: [{ order_number: OLDEST, waybill_number: OLD_WB, date: day(1), total_qty: 1,
               lines: [{ sku: 'X', description: 'Not theirs', qty: 1 }] }],
    orderStates: { [OLDEST]: { status: 'done', endTime: new Date().toISOString(), scanned: { X: 1 } } },
  }];
  fs.writeFileSync(DBP, JSON.stringify(db, null, 2));
}

const MH = { 'Content-Type': 'application/json', 'x-master-key': MASTER };
async function makePortalLogin(client, id, password, visibility) {
  const body = { id, name: id, password, access: 'full' };
  if (visibility) body.visibility = visibility;
  const r = await fetch(`${B}/api/master/client-profiles/${encodeURIComponent(client)}/portal-users`,
    { method: 'POST', headers: MH, body: JSON.stringify(body) });
  return { status: r.status, data: await J(r) };
}
async function portalLogin(client, user, password) {
  const r = await fetch(B + '/api/portal/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, user, password }),
  });
  const d = await J(r);
  return d.token || '';
}
const PH = tok => ({ 'x-auth-token': tok });
async function getOrders(tok, q) {
  const url = B + '/api/portal/orders' + (q === undefined ? '' : '?q=' + encodeURIComponent(q));
  const r = await fetch(url, { headers: PH(tok) });
  return { status: r.status, rows: await J(r), total: r.headers.get('X-Portal-Search-Total') };
}
const has = (rows, n) => Array.isArray(rows) && rows.some(o => o.order_number === n);

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.rmSync(LOG, { force: true });
  // db.json is written on a deferred timer — let the first boot make one.
  await boot(); await sleep(2500); await stop();
  seed();
  await boot();

  const mk = await makePortalLogin(CLIENT, 'searchuser', 'pw123456');
  ok(mk.status === 200, `portal login created for ${CLIENT} (${mk.status})`);
  const tok = await portalLogin(CLIENT, 'searchuser', 'pw123456');
  ok(!!tok, 'the client can sign in');

  // ── 1. THE EVERYDAY CALL IS EXACTLY WHAT IT WAS ─────────────────────────
  const page = await getOrders(tok);
  ok(Array.isArray(page.rows), 'the ordinary call still answers with a BARE ARRAY');
  ok(page.rows.length === CAP, `and still exactly ${CAP} rows (got ${page.rows.length})`);
  ok(page.total === null, 'no search header on the ordinary call');

  // ── 2. THE REPORTED SYMPTOM ─────────────────────────────────────────────
  ok(!has(page.rows, OLDEST),
     `the reported order ${OLDEST} is genuinely NOT on the page — the fault as reported`);
  ok(!has(page.rows, CANCELLED_OLD), 'nor is the older cancelled one');

  // ── 3. SEARCH REACHES PAST THE PAGE ─────────────────────────────────────
  for (const [label, term] of [
    ['order number',      OLDEST],
    ['waybill',           OLD_WB],
    ['GI number',         OLD_GI],
    ['PO number',         OLD_PO],
    ['a partial number',  OLDEST.slice(4, 12)],
    ['lower-case waybill', OLD_WB.toLowerCase()],
  ]) {
    const s = await getOrders(tok, term);
    ok(s.status === 200 && has(s.rows, OLDEST), `found by ${label} ("${term}")`);
  }
  const zero = await getOrders(tok, '44521');           // stored as 0044521
  ok(has(zero.rows, OLDEST), 'a leading-zero pick ticket resolves without the zeros');

  const one = await getOrders(tok, OLDEST);
  ok(one.rows.length === 1, `an exact order number returns just that order (${one.rows.length})`);
  ok(one.total === '1', `X-Portal-Search-Total reports the pre-cap count (${one.total})`);
  const row = one.rows[0];
  ok(row && row.waybill === OLD_WB && row.status === 'done',
     'the result carries the SAME shape as a list row (waybill, status)');

  // ── 4. A CANCELLED ORDER IS FOUND TOO ───────────────────────────────────
  // The second trap: the "All" chip hides cancelled orders, so even an order
  // ON the page could not be found there. A search must surface it.
  const canc = await getOrders(tok, CANCELLED_OLD);
  ok(has(canc.rows, CANCELLED_OLD), 'a cancelled order is found by search');
  ok(canc.rows[0]?.cancelled?.reason === 'Out of stock',
     'and still carries its cancellation reason');

  // ── 5. A TERM THAT MATCHES NOTHING ──────────────────────────────────────
  const none = await getOrders(tok, 'ZZZ-NOT-A-REAL-ORDER');
  ok(Array.isArray(none.rows) && none.rows.length === 0, 'an unknown term returns an empty array, not an error');
  ok(none.total === '0', 'and a total of 0');

  // ── 6. ISOLATION — the loudest check here ───────────────────────────────
  const mk2 = await makePortalLogin(OTHER, 'otheruser', 'pw123456');
  ok(mk2.status === 200, `portal login created for ${OTHER}`);
  const tok2 = await portalLogin(OTHER, 'otheruser', 'pw123456');
  const theirs = await getOrders(tok2, OLDEST);
  ok(theirs.rows.length === 1, `${OTHER} finds THEIR OWN order of the same number`);
  ok(theirs.rows[0]?.lines === 1 && theirs.rows[0]?.total_qty === 1, 'and it is their own record');
  const mineByThem = await getOrders(tok2, OLD_GI);   // only SEARCHCO's order carries this GI
  ok(mineByThem.rows.length === 0,
     `${OTHER} cannot reach ${CLIENT}'s order by its GI — search never crosses clients`);

  // ── 7. THE SECTION GATE STILL APPLIES ───────────────────────────────────
  // `?q=` rides on the existing path, so visibility is inherited rather than
  // re-implemented — assert that, because a new path would have needed adding
  // to portalSectionForPath and would have been ungated if forgotten.
  const mk3 = await makePortalLogin(CLIENT, 'noorders', 'pw123456',
    { overview: true, stock: true, orders: false, inbound: true, send: true, reports: true });
  ok(mk3.status === 200, 'a login with the Orders section switched off is created');
  const tok3 = await portalLogin(CLIENT, 'noorders', 'pw123456');
  const gated = await getOrders(tok3, OLDEST);
  ok(gated.status === 403, `that login is refused the SEARCH too (${gated.status}), not just the list`);

  await stop();
  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASSED'));
  fails.forEach(f => console.log('  x ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); await stop(); process.exit(2); });
