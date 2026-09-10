// The hub tells us instead of us asking every few minutes — and a push costs
// ONE targeted read, not a sweep.
const BASE = 'http://localhost:4636', MK = '201432547E', HUB = 'http://localhost:4927';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
let T = '', STORE = '';
const settle = (ms = 900) => new Promise(r => setTimeout(r, ms));
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const calls = (reset) => fetch(`${HUB}/__calls${reset ? '?reset=1' : ''}`).then(r => r.json()).then(d => d.calls);
const hubSet = (n, s) => fetch(`${HUB}/__set?n=${n}&s=${encodeURIComponent(s)}`).then(r => r.json());
const listStores = async () => { const b = (await J('/api/master/zort/stores')).body; return Array.isArray(b) ? b : (b.stores || []); };
const push = (token, body) => fetch(`${BASE}/api/zort/webhook/${token}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const T0 = new Date().toISOString();
const audit = () => (JSON.parse(require('fs').readFileSync(__dirname + '/sup/tenants/default/db.json', 'utf8')).auditLog || [])
  .filter(e => String(e.at || '') >= T0);
const store = async () => (await listStores()).find(s => s.id === STORE);
const hookInfo = () => J(`/api/master/zort/stores/${STORE}/webhook`);

(async () => {
  T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  STORE = (await listStores()).find(s => s.clientName === 'ExCo')?.id;
  ok(!!STORE, 'the ExCo store is connected');
  // A previous run leaves it registered — revoke first, or the next check
  // measures the last run rather than this one.
  await J(`/api/master/zort/stores/${STORE}/webhook`, { method: 'DELETE' });

  // ── NOT REGISTERED UNTIL ASKED.
  let info = await hookInfo();
  ok(info.body.registered === false, `no push URL until one is asked for (${info.body.registered})`);

  // ── A PUBLIC ADDRESS IS REQUIRED. The hub has to be able to reach us.
  let reg = await J(`/api/master/zort/stores/${STORE}/webhook`, { method: 'POST', body: JSON.stringify({ baseUrl: 'http://localhost:4636' }) });
  ok(reg.status === 400 && /https/i.test(reg.body.error || ''), `a non-https address is refused (${reg.status})`);
  reg = await J(`/api/master/zort/stores/${STORE}/webhook`, { method: 'POST', body: JSON.stringify({ baseUrl: 'https://idealone.tech' }) });
  ok(reg.status === 200 && reg.body.ok, `registering succeeds and reports what the hub said (${reg.body.said})`);
  ok(/\/api\/zort\/webhook\/[0-9a-f]{32}$/.test(reg.body.url || ''), `the URL carries a 32-char secret (${reg.body.url})`);
  await settle();   // db.json persistence is deferred
  ok(audit().some(e => e.type === 'zort_webhook_registered'), 'and who registered it is on the trail');

  const token = reg.body.url.split('/').pop();
  info = await hookInfo();
  ok(info.body.registered === true && !!info.body.registeredAt, 'the store now says it is registered');
  ok(!JSON.stringify(info.body).includes(token), 'THE TOKEN IS NEVER READ BACK — it is what authenticates the push');

  // ── A PUSH ON A TOKEN NOBODY HOLDS IS LOGGED, NOT SILENTLY DROPPED.
  let r = await push('0'.repeat(32), { number: 'EX-OPEN' });
  ok(r.status === 200, 'an unknown token still gets a fast 200 — a receiver that argues gets switched off');
  await settle();
  ok((await hookInfo()).body.recent.some(e => e.action === 'unknown_token'), 'and it is visible in the log');

  // ── THE PUSH IS A TRIGGER: one targeted read, not a sweep.
  await hubSet('EX-OPEN', 'Pending');
  await calls(true);
  r = await push(token, { number: 'EX-OPEN' });
  ok(r.status === 200, 'a real push is acknowledged immediately');
  await settle(1500);
  const c = await calls();
  const reads = c.filter(x => x.p === '/Order/GetOrders');
  ok(reads.length === 1, `it costs exactly ONE order read (${reads.length})`);
  ok(reads[0].numberlist === 'EX-OPEN', `and asks for that order by name, not a date window (${reads[0].numberlist})`);
  ok(!reads[0].updatedafter, 'with no updatedafter — that is the sweep, and the sweep is what costs');
  ok(audit().some(e => e.type === 'zort_webhook_read'),
     'recorded as a webhook read, kept apart from the scheduled pull on the trail');

  // ── A PUSH STORM IS NOT A CALL STORM.
  await calls(true);
  for (let i = 0; i < 5; i++) await push(token, { number: 'EX-OPEN' });
  await settle(1500);
  ok((await calls()).filter(x => x.p === '/Order/GetOrders').length === 0,
     'five more pushes on the same order inside the window cost NOTHING');
  ok((await hookInfo()).body.recent.some(e => e.action === 'debounced'), 'and say so in the log');

  // ── A PUSH WE CANNOT READ AN ORDER OUT OF IS LOGGED, NOT GUESSED AT.
  await push(token, { hello: 'world' });
  await settle();
  ok((await hookInfo()).body.recent.some(e => e.action === 'no_order'),
     'a push carrying no recognisable order is logged rather than acted on');

  // ── IT FINDS THE ORDER UNDER OTHER KEYS TOO.
  await calls(true);
  await push(token, { data: { orderid: 'EX-DONE' } });
  await settle(1500);
  ok((await calls()).filter(x => x.p === '/Order/GetOrders').length === 1,
     'an order nested under data.orderid is still found and read');

  // ── THE SWEEP IS NOT SWITCHED OFF, and a targeted read never moves its window.
  const s1 = await store();
  const beforeWindow = s1.lastPullAt;
  await calls(true);
  await push(token, { number: 'EX-DONE' });   // different order, so not debounced
  await settle(1500);
  const s2 = await store();
  ok(s2.lastPullAt === beforeWindow,
     'a webhook read does NOT advance lastPullAt — the safety-net sweep would start skipping');
  ok(!!s2.lastWebhookReadAt, 'it stamps its own timestamp instead');
  ok(JSON.stringify(s2.lastResult) === JSON.stringify(s1.lastResult),
     'and does not overwrite the store row with "fetched 1"');

  // ── AND IT CAN BE TURNED OFF AGAIN. Registering without a way back is a
  // one-way door.
  const rev = await J(`/api/master/zort/stores/${STORE}/webhook`, { method: 'DELETE' });
  ok(rev.status === 200 && rev.body.had === true, 'the push URL can be revoked');
  ok((await hookInfo()).body.registered === false, 'and the store says so');
  const dead = await push(token, { number: 'EX-OPEN' });
  await settle();
  ok(dead.status === 200, 'a push on the revoked URL is still acknowledged');
  ok((await hookInfo()).body.recent.some(e => e.action === 'unknown_token'),
     'but does nothing — the old URL is dead here whatever the channel still holds');
  await settle();
  ok(audit().some(e => e.type === 'zort_webhook_revoked'), 'and the revocation is on the trail');

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
