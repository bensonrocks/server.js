// A client configured under the shape this feature FIRST shipped with (one map
// for the whole account) must become the starting point for each of its logins,
// not a setting silently discarded when the shape changed.
//
// Two phases, because writing db.json under a running server is pointless — it
// holds the db in memory. `node vis-migrate.js seed` then restart, then `check`.
const fs = require('fs');
const DB = __dirname + '/sup/tenants/default/db.json';
const BASE = 'http://localhost:4636', MK = '201432547E';
const CLIENT = 'VisCo';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };

if (process.argv[2] === 'seed') {
  const raw = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const prof = (raw.clientProfiles || []).find(p => p.client === CLIENT);
  if (!prof) { console.error('seed: no ' + CLIENT); process.exit(1); }
  // Exactly what a client configured this morning looks like on disk.
  prof.portal_visibility = { overview: true, stock: true, orders: true, inbound: true, send: true, reports: false };
  for (const u of prof.portalUsers || []) delete u.visibility;
  fs.writeFileSync(DB, JSON.stringify(raw, null, 2));
  console.log('seeded the old client-level shape');
  process.exit(0);
}

(async () => {
  const J = async (p, o = {}) => {
    const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-master-key': MK, ...(o.headers || {}) } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const g = await J(`/api/master/client-profiles/${CLIENT}/portal-users`);
  const vera = g.body.users?.find(u => u.id === 'vera');
  ok(!!vera, 'the login is still there');
  ok(vera?.visibility?.reports === false,
     'a login with no map of its own inherits what the client was configured with');
  ok(vera?.visibility?.orders === true, 'and the rest of that arrangement comes with it');

  const li = await (await fetch(BASE + '/api/portal/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: CLIENT, user: 'vera', password: 'visco123' }) })).json();
  const P = async p => (await fetch(BASE + p, { headers: { 'x-auth-token': li.token } })).status;
  ok(await P('/api/portal/export/stock') === 403,
     'and it is ENFORCED — nothing configured before the change was silently dropped');
  ok(await P('/api/portal/orders') === 200, 'while what was left on still works');

  // Setting it on the login takes over from the inherited default.
  await J(`/api/master/client-profiles/${CLIENT}/portal-users`, { method: 'POST',
    body: JSON.stringify({ id: 'vera', visibility: { overview: true, stock: true, orders: true, inbound: true, send: true, reports: true } }) });
  ok(await P('/api/portal/export/stock') === 200, 'saving her own sections takes over from the inherited one');

  await fetch(BASE + '/api/portal/logout', { method: 'POST', headers: { 'x-auth-token': li.token } });
  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
