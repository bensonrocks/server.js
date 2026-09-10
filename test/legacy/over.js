// An over-receipt is told at the SCAN, not discovered at End Receipt — and is
// never blocked, because receiving more than the paperwork says is routine.
const BASE = 'http://localhost:4636', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
let T = '';
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;

  // A PO for 3 of ABC and 2 of DEF, created straight on the record so the test
  // does not depend on a spreadsheet parser.
  const fs = require('fs');
  const DB = __dirname + '/sup/tenants/default/db.json';
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  db.inbound = (db.inbound || []).filter(r => r.id !== 'over-test');
  db.inbound.unshift({
    id: 'over-test', serial: 'IB-OVER-01', type: 'po', reference: 'PO-OVER',
    source_name: 'Supplier', client_name: 'CxCo', uploaded_at: new Date().toISOString(),
    uploaded_by: 'test', filename: 'po.xlsx',
    lines: [{ sku: 'ABC', description: 'Widget', expected_qty: 3 },
            { sku: 'DEF', description: 'Gadget', expected_qty: 2 }],
    state: { status: 'pending', scanned: {}, scanLog: [] },
  });
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
  await fetch(BASE + '/api/version');
  console.log('(restart the server before this point if the record is not picked up)\n');

  const scan = (sku, extra = {}) => J('/api/inbound/over-test/scan', { method: 'POST',
    body: JSON.stringify({ code: sku, ...extra }) });
  // A RE-RUN MUST START FROM ZERO. Writing db.json under a running server does
  // nothing (it holds the db in memory) — reset through the API.
  for (const sku of ['ABC', 'DEF', 'NOTONPO']) {
    await J('/api/inbound/over-test/setqty', { method: 'POST',
      body: JSON.stringify({ sku, qty: 0, reason: 'test reset' }) });
  }

  // ── Under and exactly at the expected quantity: nothing to say.
  let r = await scan('ABC');
  ok(r.status === 200 && !r.body.over, `1 of 3 — no warning (${JSON.stringify(r.body.over)})`);
  ok(r.body.expected_qty === 3, 'and the receiver is told what was expected');
  r = await scan('ABC');
  ok(!r.body.over, '2 of 3 — still nothing');
  r = await scan('ABC');
  ok(!r.body.over, '3 of 3 — a line that lands exactly is NOT an over-receipt');

  // ── The scan that crosses is the one worth interrupting for.
  r = await scan('ABC');
  ok(!!r.body.over, '4 of 3 — warned');
  ok(r.body.over.justCrossed === true, 'and flagged as the crossing scan, the one to shout about');
  ok(r.body.over.expected === 3 && r.body.over.scanned === 4 && r.body.over.by === 1,
     `with the numbers a receiver can act on (${JSON.stringify(r.body.over)})`);
  ok(r.body.scanned_qty === 4, 'AND THE PIECE IS COUNTED — the warning never blocks it');

  // ── After that it is a quieter note, not a repeated shout.
  r = await scan('ABC');
  ok(!!r.body.over && r.body.over.justCrossed === false, '5 of 3 — still flagged, no longer the crossing scan');
  ok(r.body.over.by === 2, 'and the overage grows with it');

  // ── A keyed quantity that jumps straight past still crosses exactly once.
  r = await scan('DEF', { qty: 5 });
  ok(!!r.body.over && r.body.over.justCrossed === true && r.body.over.by === 3,
     `a keyed 5 against an expected 2 crosses in one go (${JSON.stringify(r.body.over)})`);

  // ── A SKU NOT ON THE PAPERWORK is a different thing and must not be called
  // an over-receipt against an expectation of nobody's.
  r = await scan('NOTONPO');
  ok(r.status === 200, 'an unlisted SKU is still accepted');
  ok(!r.body.over, 'and is NOT reported as an over-receipt');
  ok(r.body.expected_qty === null, 'it simply has nothing expected against it');

  // ── A RETURN has no expected list at all, so nothing can be over.
  const ret = await J('/api/inbound/return', { method: 'POST',
    body: JSON.stringify({ reference: 'RET-OVER', source_name: 'Customer', client_name: 'CxCo' }) });
  const rid = ret.body?.record?.id || ret.body?.id;
  if (rid) {
    const rr = await J(`/api/inbound/${rid}/scan`, { method: 'POST', body: JSON.stringify({ code: 'ABC', qty: 9 }) });
    ok(rr.status === 200 && !rr.body.over, 'a return can never be over-received — there is nothing to be over');
  } else ok(false, 'could not create a return to test against');

  // ── NOT REGRESSED: End Receipt still reports the discrepancy it always did.
  const end = await J('/api/inbound/over-test/end-receipt', { method: 'POST', body: JSON.stringify({}) });
  ok(end.status === 409 && end.body.needsConfirm, `End Receipt still asks about the discrepancy (${end.status})`);
  ok((end.body.mismatches || []).some(m => m.sku === 'ABC'),
     'naming the line, exactly as before — this warning is in ADDITION to that, not instead of it');

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
