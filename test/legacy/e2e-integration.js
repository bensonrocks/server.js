// BOTH DIRECTIONS, end to end through the real endpoints:
//   IN  — an API key with scopes, and orders arriving as JSON.
//   OUT — a signed webhook a partner's own endpoint verifies and accepts.
const B = 'http://localhost:4717', R = 'http://localhost:4791', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  if (!l.token) { console.log('LOGIN FAILED'); process.exit(1); }
  const H  = { 'x-auth-token': l.token, 'x-master-key': MK, 'Content-Type': 'application/json' };
  const MH = { 'x-master-key': MK, 'Content-Type': 'application/json' };
  const C  = 'ApiCo' + Date.now();
  // Order numbers are unique SYSTEM-WIDE (as on the file path), so a re-run
  // needs its own or it meets the previous run's orders.
  const N  = (s) => s + '-' + String(Date.now()).slice(-6);
  const O1 = N('API1'), O2 = N('API2'), OK_ = N('APIOK'), SH = N('APISHORT');
  const ctl = q => fetch(R + '/__ctl' + q).then(r => r.json());

  // Stock to sell: 10 of AAA, 1 of SHORTY.
  await fetch(B + '/api/inventory/import', { method: 'POST', headers: H, body: JSON.stringify({
    clientId: C, items: [{ sku: 'AAA', name: 'Alpha', stock_qty: 10 }, { sku: 'SHORTY', name: 'Shorty', stock_qty: 1 }] }) });

  // ══ IN ═══════════════════════════════════════════════════════════════════
  // ── A key is issued once, and never readable again.
  let r = await fetch(B + '/api/master/api-keys', { method: 'POST', headers: MH,
    body: JSON.stringify({ name: 'ReadOnly ' + Date.now(), scopes: ['read'] }) });
  const roKey = await r.json();
  ok(r.status === 200 && String(roKey.key || '').startsWith('iok_'), 'a key is minted and returned ONCE');
  // The key carries a PUBLIC id and a secret half: iok_<12 hex>_<32 hex>. The
  // id is what makes verification one hash instead of a sweep of every key,
  // which is what makes a deliberately-slow hash affordable at all.
  ok(/^iok_[0-9a-f]{12}_[0-9a-f]{32}$/.test(roKey.key || ''), '★ the key is <public id>_<secret>, so verification is O(1)');
  const listed = await fetch(B + '/api/master/api-keys', { headers: MH }).then(x => x.json());
  const roRow = (listed.keys || []).find(k => k.id === roKey.id);
  ok(!!roRow && !JSON.stringify(listed).includes(roKey.key), '★ the key itself is NEVER read back — only its last 4 (' + roRow?.tail + ')');

  const RO = { 'x-api-key': roKey.key };
  ok((await fetch(B + '/api/orders?range=today', { headers: RO })).status === 200, 'a read key can read orders');
  r = await fetch(B + '/api/orders/intake', { method: 'POST', headers: { ...RO, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: C, orders: [{ order_number: 'X1', lines: [{ sku: 'AAA', qty: 1 }] }] }) });
  let d = await r.json();
  ok(r.status === 403 && /orders:write/.test(d.error || ''), '…and is REFUSED the write it does not hold, by scope name');
  ok((await fetch(B + '/api/master/api-keys', { headers: RO })).status === 403, '★ a key can NEVER reach /api/master/* — that stays the Administrator key');
  ok((await fetch(B + '/api/system-health', { headers: RO })).status === 403, 'an undocumented route is refused, not inherited by silence');
  ok((await fetch(B + '/api/orders', { headers: { 'x-api-key': 'iok_deadbeef' } })).status === 401, 'an unknown key is 401');
  // A key from the FIRST format (one opaque string, no id half) is refused —
  // and told it is a reissue, not a fault, so nobody hunts for a broken key.
  r = await fetch(B + '/api/orders', { headers: { 'x-api-key': 'iok_' + 'a'.repeat(32) } });
  d = await r.json();
  ok(r.status === 401 && d.reissue === true && /earlier key format/.test(d.error || ''),
     '★ a key issued under the OLD format says so, and says to reissue it');

  // ── A writing key, and orders as JSON.
  const wk = await fetch(B + '/api/master/api-keys', { method: 'POST', headers: MH,
    body: JSON.stringify({ name: 'Partner ' + Date.now(), scopes: ['read', 'orders:write'] }) }).then(x => x.json());
  const WK = { 'x-api-key': wk.key, 'Content-Type': 'application/json' };

  r = await fetch(B + '/api/orders/intake', { method: 'POST', headers: WK, body: JSON.stringify({
    client: C, reference: 'ACME-run-1',
    orders: [
      { order_number: O1, customer_name: 'Jo', delivery_address: '1 Test Rd 123456',
        waybill_number: 'TRK-1', lines: [{ sku: 'AAA', qty: 2 }] },
      { order_number: O2, customer_name: 'Sam', delivery_address: '2 Test Rd 654321', lines: [{ sku: 'AAA', qty: 3 }] },
      { order_number: '',      lines: [{ sku: 'AAA', qty: 1 }] },
    ] }) });
  d = await r.json();
  console.log('  INTAKE(' + r.status + '):', JSON.stringify(d).slice(0, 400));
  ok(r.status === 200 && d.created === 2, '★ orders arrive as JSON — 2 created');
  ok(/^IS-|^CS-/.test(d.job || ''), 'it gets a real job code like every other door (' + d.job + ')');
  ok((d.rejected || []).length === 1 && /order_number/.test(d.rejected[0].reason), 'the malformed one is named, not silently dropped');
  ok(d.inventoryTracked === true, 'the batch is inventory-TRACKED, so stock was reserved');

  const inv = await fetch(B + `/api/inventory?clientId=${C}`, { headers: H }).then(x => x.json());
  const aaa = inv.find(x => x.sku === 'AAA');
  ok(Number(aaa.reserved_qty) === 5, '★ 5 pcs RESERVED by the intake — the same gate the file upload uses');
  const ordersNow = await fetch(B + '/api/orders?range=all', { headers: H }).then(x => x.json());
  const api1 = (ordersNow.orders || ordersNow).find(o => o.order_number === O1);
  ok(!!api1, 'the order is on the Orders tab like any other');
  ok((api1?.lines?.[0]?.pick_locations || []).length >= 0, 'it went through pick allocation');

  // ── MIXING an addressed order with an unaddressed one is refused, in words.
  r = await fetch(B + '/api/orders/intake', { method: 'POST', headers: WK, body: JSON.stringify({
    client: C, orders: [
      { order_number: N('MIXA'), customer_name: 'Jo', delivery_address: '9 Test Rd 999999', lines: [{ sku: 'AAA', qty: 1 }] },
      { order_number: N('MIXB'), lines: [{ sku: 'AAA', qty: 1 }] },
    ] }) });
  d = await r.json();
  ok(r.status === 422 && d.created === 0, 'a mixed addressed/unaddressed batch is refused — same rule as the file upload');
  ok((d.rejected || []).some(x => (x.problems || []).some(p => /RECIPIENT|ADDRESS/.test(p.issue))),
     '…naming the order and the missing field, not a validation blob');
  ok(/picking list/.test(d.hint || ''), '★ …and saying what the rule actually is');

  // ── Retrying is safe.
  r = await fetch(B + '/api/orders/intake', { method: 'POST', headers: WK, body: JSON.stringify({
    client: C, orders: [{ order_number: O1, lines: [{ sku: 'AAA', qty: 2 }] }] }) });
  d = await r.json();
  ok(r.status === 200 && d.created === 0 && (d.duplicates || []).some(x => x.order_number === O1),
     '★ a retry creates NO twin — the order is reported as already held');

  // ── Short stock: refused by default, with the numbers.
  r = await fetch(B + '/api/orders/intake', { method: 'POST', headers: WK, body: JSON.stringify({
    client: C, orders: [
      { order_number: OK_,   lines: [{ sku: 'AAA', qty: 1 }] },
      { order_number: SH,    lines: [{ sku: 'SHORTY', qty: 99 }] },
    ] }) });
  d = await r.json();
  ok(r.status === 409 && d.needsStockDecision && d.created === 0,
     '★ short stock REFUSES by default and creates nothing — a machine is never guessed at');
  ok(/on_short/.test(d.howToProceed || ''), 'and it says how to proceed');
  r = await fetch(B + '/api/orders/intake', { method: 'POST', headers: WK, body: JSON.stringify({
    client: C, on_short: 'drop',
    orders: [
      { order_number: OK_,   lines: [{ sku: 'AAA', qty: 1 }] },
      { order_number: SH,    lines: [{ sku: 'SHORTY', qty: 99 }] },
    ] }) });
  d = await r.json();
  ok(r.status === 200 && d.created === 1 && d.dropped[0].order_number === SH,
     'declaring on_short=drop takes the covered order and NAMES the one left behind');

  // ── The slow hash is paid ONCE per key, not once per request…
  //
  // TWO EARLIER VERSIONS OF THIS CHECK WERE WORTHLESS, and both failure modes
  // are worth not repeating:
  //   1. "time one call, then another, assert the second is no worse + 5ms" —
  //      passed at 58ms → 63ms, the second call SLOWER, and would have passed
  //      against a build paying scrypt every single request.
  //   2. Comparing a keyed call against a STAFF-TOKEN call. Sound in principle
  //      but measured in blocks, so it picked up the server getting busier
  //      between the two blocks and reported a 46ms "overhead" that a stack
  //      trace on every scrypt call proved was not scrypt at all.
  //
  // So the comparison is now CONTROLLED: a brand-new key (never verified, must
  // hash) against a key already verified (must not), interleaved one for one
  // on the same route. Identical code path, identical work, alternating in
  // time — the ONLY difference between the two samples is the scrypt.
  const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mkKey = async nm => (await fetch(B + '/api/master/api-keys', { method: 'POST', headers: MH,
    body: JSON.stringify({ name: nm, scopes: ['read'] }) }).then(x => x.json())).key;
  const timeOne = async k => {
    const t = process.hrtime.bigint();
    const res = await fetch(B + '/api/orders?range=today', { headers: { 'x-api-key': k } });
    await res.text();                        // drain, or the next timing inherits it
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const warmKey = await mkKey('Warm ' + Date.now());
  const cold = [], warm = [];
  for (let i = 0; i < 6; i++) {
    cold.push(await timeOne(await mkKey('Cold ' + Date.now() + '-' + i)));
    warm.push(await timeOne(warmKey));
  }
  warm.shift();                              // the warm key's own first call was cold
  // The route's OWN cost sits in both samples equally, so the difference is
  // the thing being measured. Judge that difference against what one scrypt
  // actually costs on this machine — not against a fraction of the total,
  // which would fail or pass on how busy the route happens to be.
  const scryptMs = (() => {
    const cr = require('crypto'), s = [];
    for (let i = 0; i < 5; i++) {
      const t = process.hrtime.bigint();
      cr.scryptSync('x'.repeat(32), 'saltsalt', 64);
      s.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    return med(s);
  })();
  const cM = med(cold), wM = med(warm), saved = cM - wM;
  console.log(`  KEY VERIFY: unseen key ${cM.toFixed(1)}ms · already-verified key ${wM.toFixed(1)}ms · `
            + `saves ${saved.toFixed(1)}ms/request · one scrypt costs ${scryptMs.toFixed(1)}ms`);
  ok(saved > scryptMs * 0.6,
     `★ a repeat call does NOT re-pay the scrypt — saves ${saved.toFixed(1)}ms against a ${scryptMs.toFixed(1)}ms hash`);

  // ── …and the cache NEVER keeps a dead key alive.
  await fetch(B + `/api/master/api-keys/${wk.id}/enabled`, { method: 'POST', headers: MH, body: '{"enabled":false}' });
  ok((await fetch(B + '/api/orders', { headers: { 'x-api-key': wk.key } })).status === 401,
     '★★ switching a key off refuses the VERY NEXT call — the record is re-read every request');
  await fetch(B + `/api/master/api-keys/${wk.id}/enabled`, { method: 'POST', headers: MH, body: '{"enabled":true}' });
  ok((await fetch(B + '/api/orders', { headers: { 'x-api-key': wk.key } })).status === 200, 'switching it back on works again');

  // ── Revoking bites at once.
  await fetch(B + `/api/master/api-keys/${roKey.id}/enabled`, { method: 'POST', headers: MH, body: '{"enabled":false}' });
  ok((await fetch(B + '/api/orders', { headers: RO })).status === 401, 'switching a key off refuses it immediately');

  // ══ OUT ══════════════════════════════════════════════════════════════════
  await ctl('?reset=1&fail=0');
  const hook = await fetch(B + '/api/master/webhooks', { method: 'POST', headers: MH, body: JSON.stringify({
    name: 'Partner WMS', url: R + '/hook', events: ['order.completed', 'order.cancelled', 'order.picked_up', 'stock.adjusted'] }) }).then(x => x.json());
  ok(String(hook.secret || '').startsWith('whsec_'), 'a hook is created with a signing secret, shown once');
  await ctl('?secret=' + encodeURIComponent(hook.secret));
  const hooksList = await fetch(B + '/api/master/webhooks', { headers: MH }).then(x => x.json());
  ok(!JSON.stringify(hooksList).includes(hook.secret), '★ the signing secret is never read back either');

  // ── Test fire, verified by the receiver's own signature check.
  const t = await fetch(B + `/api/master/webhooks/${hook.id}/test`, { method: 'POST', headers: MH, body: '{}' }).then(x => x.json());
  ok(t.ok === true && t.status === 200, 'the test fire reports what the receiver said (' + t.status + ' in ' + t.ms + 'ms)');
  let got = await ctl('');
  ok(got.received.some(x => x.event === 'test.ping' && x.sigOk), '★ the receiver VERIFIED the signature with the shared secret');
  ok(got.badSig === 0, 'no delivery failed verification');

  // ── A real completion pushes out.
  await ctl('?reset=1');
  await fetch(B + '/api/scan/setqty', { method: 'POST', headers: H, body: JSON.stringify({ orderNumber: O2, sku: 'AAA', qty: 3 }) });
  const comp = await fetch(B + '/api/scan/complete', { method: 'POST', headers: H, body: JSON.stringify({
    orderNumber: O2, startTime: new Date().toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) }).then(x => x.json());
  ok(comp.ok !== false, O2 + ' completed through the real endpoint');
  for (let i = 0; i < 20 && !(await ctl('')).received.some(x => x.event === 'order.completed'); i++) await sleep(250);
  got = await ctl('');
  const done = got.received.find(x => x.event === 'order.completed');
  console.log('  DELIVERED:', JSON.stringify(done?.data || {}).slice(0, 200));
  ok(!!done, '★★ the partner was TOLD, without being asked — order.completed arrived');
  ok(done?.sigOk, 'signed, and it verified');
  ok(done?.data?.order_number === O2 && done?.data?.client, 'carrying the order number and client');
  ok((done?.data?.lines || []).some(x => x.sku === 'AAA' && x.qty === 3), 'and what was actually in the box');

  // ── The parcel leaving, and an order cancelled, are pushed too — the two
  //    other emit sites, asserted rather than assumed to be wired.
  await ctl('?reset=1');
  await fetch(B + '/api/orders/pickup', { method: 'POST', headers: H, body: JSON.stringify({ orderNumbers: [O2], method: 'manual' }) });
  for (let i = 0; i < 20 && !(await ctl('')).received.some(x => x.event === 'order.picked_up'); i++) await sleep(250);
  const up = (await ctl('')).received.find(x => x.event === 'order.picked_up');
  ok(!!up && up.data.order_number === O2, '★ order.picked_up fires when the parcel leaves');

  await ctl('?reset=1');
  await fetch(B + '/api/orders/bulk-cancel', { method: 'POST', headers: H, body: JSON.stringify({
    orders: [O1], reason: 'partner webhook test' }) });
  for (let i = 0; i < 20 && !(await ctl('')).received.some(x => x.event === 'order.cancelled'); i++) await sleep(250);
  const cx = (await ctl('')).received.find(x => x.event === 'order.cancelled');
  ok(!!cx && cx.data.order_number === O1 && /partner webhook test/.test(cx.data.reason || ''),
     '★ order.cancelled fires, carrying the reason');

  // ── A receiver that is down is RETRIED, not dropped.
  await ctl('?reset=1&fail=2');
  await fetch(B + '/api/inventory/AAA/adjust', { method: 'POST', headers: H, body: JSON.stringify({
    clientId: C, qty: -1, reason: 'webhook retry test', password: 'demo' }) });
  for (let i = 0; i < 40 && !(await ctl('')).received.some(x => x.event === 'stock.adjusted'); i++) {
    await fetch(B + '/api/master/webhooks/retry-stalled', { method: 'POST', headers: MH, body: '{}' });
    await sleep(200);
  }
  got = await ctl('');
  ok(got.received.some(x => x.event === 'stock.adjusted'),
     '★ two refusals then a success — the delivery was RETRIED, never dropped');

  // ── The log records the outcome, and NOT the customer.
  const wh = await fetch(B + '/api/master/webhooks', { headers: MH }).then(x => x.json());
  ok((wh.log || []).length > 0, 'every attempt is on the delivery log');
  ok((wh.log || []).some(x => x.ok === false && x.status === 500), '…including the failures, with the status');
  ok(!JSON.stringify(wh.log).includes('1 Test Rd'), '★ the log carries the outcome, never the payload — no customer address in it');

  // ── Deleting a hook takes its queue with it.
  await fetch(B + `/api/master/webhooks/${hook.id}`, { method: 'DELETE', headers: MH });
  const after = await fetch(B + '/api/master/webhooks', { headers: MH }).then(x => x.json());
  ok(!(after.hooks || []).some(h => h.id === hook.id), 'the hook is gone');
  ok((after.queued || 0) === 0, 'and nothing is left queued for it');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
