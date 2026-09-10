// "CARTON n OF m" may only be printed once m is TRUE.
//
// How many boxes an order takes is not knowable when the first one is
// labelled. `cartonCount` is how many exist RIGHT NOW, so on a two-box order
// the first label used to read "CARTON 1 OF 1" — which tells a receiver the
// consignment is complete when another box is still behind it.
//
// This drives a real order through a genuine two-carton pick and asserts the
// endpoint now says whether the total is final, and that it only becomes final
// at completion.
const BASE = 'http://localhost:4636';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
let T = '';
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-auth-token': T, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ORD = '24944949';
const slip = async (n) => (await J(`/api/scan/carton-slip/${ORD}${n ? `?cartonNum=${n}` : ''}`)).body;

// The label's own rule, copied from cartonLabelBody() so the test asserts on
// what would actually be PRINTED and not merely on a flag.
const ctnLine = d => (d.cartonTotalFinal && Number(d.cartonCount) > 0)
  ? `CARTON ${d.cartonNum} OF ${d.cartonCount}`
  : `CARTON ${d.cartonNum}`;
// What the code being replaced printed, unconditionally. Kept so the run
// proves the defect rather than only agreeing with the fix.
const oldLine = d => `CARTON ${d.cartonNum} OF ${d.cartonCount}`;
let wrongBefore = '';

(async () => {
  T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;

  // ── WHILE THE ORDER IS OPEN, THE TOTAL IS NOT KNOWN.
  let d = await slip(1);
  ok(d.cartonTotalFinal === false, `an unfinished order does NOT claim a final carton total (${d.cartonTotalFinal})`);
  ok(ctnLine(d) === 'CARTON 1', `so the label reads "${ctnLine(d)}" — not "CARTON 1 OF 1"`);
  ok(Number(d.cartonCount) === 1, 'even though exactly one carton exists at this moment');
  wrongBefore = oldLine(d);
  ok(wrongBefore === 'CARTON 1 OF 1', `and this is the moment the OLD rule printed "${wrongBefore}"`);

  // ── THE SECOND BOX IS EXACTLY THE CASE THE OLD LABEL GOT WRONG.
  // Something has to go in box 1 first: /new-carton refuses an empty active
  // carton, which is what stops a stray double-tap making a phantom box.
  const listed0 = (await J('/api/orders?range=all')).body;
  const ord0 = (Array.isArray(listed0) ? listed0 : listed0.orders || []).find(o => o.order_number === ORD);
  const first = (ord0?.items || [])[0];
  await J('/api/scan/setqty', { method: 'POST',
    body: JSON.stringify({ orderNumber: ORD, sku: first.sku, qty: Number(first.qty) || 1 }) });
  const nc = await J('/api/scan/new-carton', { method: 'POST', body: JSON.stringify({ orderNumber: ORD }) });
  ok(nc.status === 200, `a second carton is opened (${nc.status})`);
  d = await slip(1);
  ok(Number(d.cartonCount) === 2, 'carton 1 is now one of two boxes');
  ok(ctnLine(d) === 'CARTON 1' && !/OF/.test(ctnLine(d)),
     'and its label STILL does not claim a total — the pre-fix code printed "OF 1" here, on a two-box order');

  // ── FINISH THE PICK. Landed with setqty, not by counting scans: an
  // over-scanned order is refused and /complete answers 200 with {ok:false},
  // both of which have wasted a run before.
  const listed = (await J('/api/orders?range=all')).body;
  const order = (Array.isArray(listed) ? listed : listed.orders || []).find(o => o.order_number === ORD);
  for (const l of (order?.items || [])) {
    await J('/api/scan/setqty', { method: 'POST',
      body: JSON.stringify({ orderNumber: ORD, sku: l.sku, qty: Number(l.qty) || 0 }) });
  }
  const done = await J('/api/scan/complete', { method: 'POST',
    body: JSON.stringify({ orderNumber: ORD, endTime: new Date().toISOString() }) });
  ok(done.status === 200 && done.body.ok !== false,
     `the order completes (${done.status} ${JSON.stringify(done.body).slice(0, 160)})`);

  // ── ONCE IT IS DONE THE TOTAL IS FINAL AND MAY BE PRINTED.
  d = await slip(1);
  ok(d.cartonTotalFinal === true, 'a completed order DOES carry a final carton total');
  ok(Number(d.cartonCount) === 2, `and it is the real number of boxes (${d.cartonCount})`);
  ok(ctnLine(d) === 'CARTON 1 OF 2', `so a reprint of box 1 now reads "${ctnLine(d)}"`);
  const d2 = await slip(2);
  ok(ctnLine(d2) === 'CARTON 2 OF 2', `and box 2 reads "${ctnLine(d2)}"`);

  // ── A PRE-PRINTED LABEL CREATES NO CARTON. The run is paper only; the
  // numbers it prints are ahead of what exists, which is the whole point.
  const before = (await slip()).cartonCount;
  ok(before === 2, `the order still holds exactly ${before} cartons after all that printing`);

  // ── THE DEFECT, PROVED. The label stuck on box 1 said "OF 1"; the order
  // shipped as two boxes. A receiver reading that label was told the
  // consignment was complete with another box still behind it.
  ok(wrongBefore === 'CARTON 1 OF 1' && Number(d.cartonCount) === 2,
     `the OLD rule printed "${wrongBefore}" on a box of an order that ended up ${d.cartonCount} boxes`);

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
