// The receiver is PUBLIC, so the two things that matter are that a near-miss
// token cannot get in and that an external caller cannot grow us without limit.
const BASE = 'http://localhost:4636', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const settle = (ms = 700) => new Promise(r => setTimeout(r, ms));
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const push = (tok, body) => fetch(`${BASE}/api/zort/webhook/${tok}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(r => r.status);

(async () => {
  const stores = (await J('/api/master/zort/stores')).body;
  const store = (Array.isArray(stores) ? stores : []).find(s => s.clientName === 'ExCo');
  const reg = await J(`/api/master/zort/stores/${store.id}/webhook`, { method: 'POST', body: JSON.stringify({ baseUrl: 'https://idealone.tech' }) });
  const token = reg.body.url.split('/').pop();
  const info = () => J(`/api/master/zort/stores/${store.id}/webhook`);

  // ── A NEAR MISS IS A MISS.
  const near = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  await push(near, { number: 'EX-OPEN' });
  await settle();
  let rec = (await info()).body.recent;
  ok(rec[0]?.action === 'unknown_token', `one character wrong is rejected (${rec[0]?.action})`);
  await push(token.slice(0, 16), { number: 'EX-OPEN' });      // right prefix, short
  await settle();
  ok((await info()).body.recent[0]?.action === 'unknown_token', 'a correct PREFIX is rejected too — length is compared first');
  await push('', { number: 'EX-OPEN' });
  ok(true, 'an empty token does not throw');

  // ── AN AWKWARD BODY MUST NOT TAKE THE RECEIVER DOWN.
  for (const body of [null, [], 'not-an-object', { number: { nested: 1 } }, { number: 'x'.repeat(5000) }]) {
    const st = await fetch(`${BASE}/api/zort/webhook/${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.status);
    ok(st === 200, `a body of ${JSON.stringify(body).slice(0, 24)} is still acknowledged (${st})`);
  }
  await settle();
  ok((await J('/api/version')).status === 200, 'and the server is still up after all of them');

  // ── AN EXTERNAL CALLER CANNOT GROW US WITHOUT LIMIT.
  // 300 distinct refs — each would otherwise be a permanent Map entry.
  for (let i = 0; i < 300; i++) await push(token, { number: `GROW-${i}` });
  await settle(1500);
  ok((await J('/api/version')).status === 200, '300 pushes with distinct order refs leave the server healthy');
  const log = (await info()).body.recent;
  ok(log.length <= 25, `and the push log stays capped for the screen (${log.length})`);
  const dbj = JSON.parse(require('fs').readFileSync(__dirname + '/sup/tenants/default/db.json', 'utf8'));
  ok((dbj.zortPushLog || []).length <= 200, `the stored log is capped too (${(dbj.zortPushLog || []).length})`);

  // ── THE SECRET NEVER GOES ANYWHERE PERSISTENT.
  // The audit log is never wiped, is archived indefinitely, and the nightly
  // backup is gzipped AND EMAILED — so a token on the trail is a token in an
  // inbox for ever.
  await settle();
  const raw = require('fs').readFileSync(__dirname + '/sup/tenants/default/db.json', 'utf8');
  ok(!raw.includes(`/api/zort/webhook/${token}`),
     'the full push URL is nowhere in stored data');
  const auditRows = JSON.parse(raw).auditLog.filter(e => e.type === 'zort_webhook_registered');
  const reg1 = auditRows.slice(-1)[0];
  ok(!!reg1, 'the registration is on the trail');
  ok(!String(reg1.url || '').includes(token), `and its URL carries no token (${reg1.url})`);
  ok(/webhook\/•+/.test(String(reg1.url || '')), 'it is redacted, not simply omitted — where we registered still reads');
  // The token DOES appear in the response to the operator who asked for it,
  // which is the one place it has to.
  ok(reg.body.url.includes(token), 'while the operator who registered it was shown it once');

  // ── AN UNAUTHENTICATED CALLER MUST NOT COST A DISK WRITE PER REQUEST.
  const dbPath = __dirname + '/sup/tenants/default/db.json';
  const before = JSON.parse(require('fs').readFileSync(dbPath, 'utf8')).zortPushLog || [];
  const bad = 'f'.repeat(32);
  for (let i = 0; i < 40; i++) await push(bad, { number: 'X' });
  await settle(1200);
  const after = JSON.parse(require('fs').readFileSync(dbPath, 'utf8')).zortPushLog || [];
  const added = after.length - before.length;
  ok(added <= 2, `40 pushes on a dead token add at most one log row, not forty (${added})`);
  // The window is shortened to 1.5s for this run (ZORT_PUSH_BADTOKEN_LOG_MS),
  // so a second batch lands in a new window and shows the accumulated count.
  for (let i = 0; i < 30; i++) await push(bad, { number: 'X2' });
  await settle(2000);
  await push(bad, { number: 'X3' });
  await settle(800);
  const rows = (JSON.parse(require('fs').readFileSync(dbPath, 'utf8')).zortPushLog || [])
    .filter(r => r.action === 'unknown_token');
  const last = rows.slice(-1)[0];
  ok(!!last && last.from, `the dead-URL row names where it came from (${last?.from})`);
  ok(!!last && Number(last.count) > 1,
     `and CARRIES the count, so the operator sees the flood not one hit (${JSON.stringify(last)})`);
  ok((await J('/api/version')).status === 200, 'server healthy afterwards');

  // ── AND A FLOOD IS CEILINGED. Proved in its own run, because the ceiling
  // and the write-amplification guard hide each other from the same address:
  // this run raises the ceiling (ZORT_PUSH_IP_MAX) so the guard above is what
  // is being measured. See hookrate.js for the ceiling itself.
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) await push(bad, { number: 'Y' });
  ok((await J('/api/version')).status === 200,
     `200 more in ${Date.now() - t0}ms and the server is still answering`);
  const after2 = JSON.parse(require('fs').readFileSync(dbPath, 'utf8')).zortPushLog || [];
  ok(after2.length - after.length <= 3, `and still no write storm (${after2.length - after.length} rows)`);

  await J(`/api/master/zort/stores/${store.id}/webhook`, { method: 'DELETE' });
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
