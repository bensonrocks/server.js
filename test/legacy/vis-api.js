// What each LOGIN may see. Two people on the same client can be given
// different sections, and a section switched off is refused, not just hidden.
const BASE = 'http://localhost:4636', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
let T = '';
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-master-key': MK, 'x-auth-token': T, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const P = async (p, tok, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-auth-token': tok, ...(o.headers || {}) } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json().catch(() => ({})) : null };
};
const CLIENT = 'VisCo';
const setVis = (id, visibility) => J(`/api/master/client-profiles/${CLIENT}/portal-users`,
  { method: 'POST', body: JSON.stringify({ id, visibility }) });
const login = async (user, password) => {
  const r = await fetch(BASE + '/api/portal/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: CLIENT, user, password }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const out = tok => P('/api/portal/logout', tok, { method: 'POST' });
const ALL = { overview: true, stock: true, orders: true, inbound: true, send: true, reports: true };

(async () => {
  T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;

  // ── A clean client with TWO logins — the case this shape exists for ──────
  await J(`/api/master/client-profiles/${CLIENT}`, { method: 'DELETE' }).catch(() => {});
  await J('/api/master/client-profiles', { method: 'POST', body: JSON.stringify({ client: CLIENT }) });
  await J('/api/master/client-profiles', { method: 'POST', body: JSON.stringify({ client: 'OtherCo' }) });
  await J(`/api/master/client-profiles/${CLIENT}/portal`, { method: 'POST', body: JSON.stringify({ enabled: true, email: 'v@x.com' }) });
  await J(`/api/master/client-profiles/${CLIENT}/portal-users`, { method: 'POST',
    body: JSON.stringify({ name: 'Vera', access: 'full', password: 'visco123' }) });
  await J(`/api/master/client-profiles/${CLIENT}/portal-users`, { method: 'POST',
    body: JSON.stringify({ name: 'Wes', access: 'full', password: 'visco456' }) });

  // ── 1. DEFAULT IS EVERYTHING, on every login.
  let g = await J(`/api/master/client-profiles/${CLIENT}/portal-users`);
  ok(Array.isArray(g.body.sections) && g.body.sections.length === 6,
     `the office is told which sections exist (${g.body.sections?.length})`);
  ok(g.body.sections.every(s => s.key && s.label && s.hint), 'each one says what it is and what is inside it');
  ok(g.body.users.length === 2 && g.body.users.every(u => Object.values(u.visibility).every(v => v === true)),
     'every login starts able to see everything');
  ok(g.body.visibility === undefined, 'and there is no client-level setting any more — it is per login');

  let a = await login('vera', 'visco123');
  ok(a.status === 200 && Object.values(a.body.visibility).every(v => v === true),
     'the login response carries that login\'s own map, for the first paint');
  let tokA = a.body.token;
  ok((await P('/api/portal/me', tokA)).body?.visibility?.reports === true, '/me carries it too');
  for (const [p, name] of [['/api/portal/overview', 'Overview'], ['/api/portal/stock', 'Stock'],
                           ['/api/portal/orders', 'Orders'], ['/api/portal/inbound', 'Inbound'],
                           ['/api/portal/movements', 'the stock statement'], ['/api/portal/submissions', 'Send']]) {
    ok((await P(p, tokA)).status === 200, `${name} is open by default`);
  }
  ok((await P('/api/portal/export/stock', tokA)).status === 200, 'and so is the report download');
  await out(tokA);

  // ── 2. TWO PEOPLE ON ONE CLIENT, DIFFERENT SECTIONS. The whole point.
  // Vera is the warehouse contact: Inbound and Orders, no Reports.
  let s = await setVis('vera', { ...ALL, reports: false, send: false });
  ok(s.status === 200, 'Vera\'s sections saved');
  ok(s.body.user?.visibility?.reports === false, 'and the answer says what she now sees');
  // Wes is the finance contact: Reports, but no Inbound.
  await setVis('wes', { ...ALL, inbound: false });

  a = await login('vera', 'visco123'); tokA = a.body.token;
  const bLog = await login('wes', 'visco456'); const tokB = bLog.body.token;
  ok(a.status === 200 && bLog.status === 200, 'both sign in at once — one seat each, they are different accounts');

  ok((await P('/api/portal/export/orders', tokA)).status === 403, 'Vera is refused the report download');
  ok((await P('/api/portal/export/orders', tokB)).status === 200,
     'and Wes, on the SAME client, still gets it — this is per login, not per account');
  ok((await P('/api/portal/inbound', tokB)).status === 403, 'Wes is refused Inbound');
  ok((await P('/api/portal/inbound', tokA)).status === 200, 'and Vera still has it');
  ok((await P('/api/portal/grn/anything', tokB)).status === 403, 'a GRN goes with Inbound');
  ok((await P('/api/portal/asn-template', tokB)).status === 403, '…and so does the ASN template');
  ok((await P('/api/portal/submissions', tokA)).status === 403, 'Send off refuses the submissions list');
  ok((await P('/api/portal/submissions', tokB)).status === 200, 'while Wes can still send work in');

  const ref = await P('/api/portal/export/orders', tokA);
  ok(/not switched on/i.test(ref.body?.error || ''), 'a refusal says why, in words a client can act on');
  ok(ref.body?.hiddenSection === 'reports', 'naming the section, so the page can react');

  // NEVER HIDDEN, whatever else is off.
  ok((await P('/api/portal/me', tokA)).status === 200, '/me is never hidden — the page has to know who it is');
  ok((await P('/api/portal/notices', tokA)).status === 200, 'nor are notices — we must always be able to tell them something');
  ok((await P('/api/portal/me', tokA)).body?.visibility?.reports === false, 'and /me reports this login\'s own arrangement');
  ok((await P('/api/portal/me', tokB)).body?.visibility?.reports === true, '…which differs from the other login\'s');

  // ── 3. STOCK OFF TAKES THE MOVEMENT STATEMENT WITH IT.
  await setVis('vera', { ...ALL, stock: false });
  ok((await P('/api/portal/stock', tokA)).status === 403, 'Stock off refuses the stock list');
  ok((await P('/api/portal/movements', tokA)).status === 403, '…and the movement statement');
  ok((await P('/api/portal/stock', tokB)).status === 200, 'Wes is untouched by a change to Vera');

  // ── 4. IT BITES ON THE NEXT REQUEST, not at the next login.
  ok((await P('/api/portal/orders', tokA)).status === 200, 'Vera has Orders');
  await setVis('vera', { ...ALL, stock: false, orders: false });
  ok((await P('/api/portal/orders', tokA)).status === 403, 'switched off mid-session and it is gone at once');

  // ── 5. A PORTAL SHOWING NOTHING IS A BROKEN LOGIN, NOT A CONFIGURATION.
  s = await setVis('vera', { overview: false, stock: false, orders: false, inbound: false, send: true, reports: true });
  ok(s.status === 400, `switching off every data section for a login is refused (${s.status})`);
  ok(/at least one/i.test(s.body?.error || ''), 'and the refusal says what to do about it');
  ok((await P('/api/portal/inbound', tokA)).status === 200, 'nothing was changed by the refusal');

  // ── 6. NOTHING IS STAMPED — switching it back on simply returns the section.
  await setVis('vera', ALL);
  ok((await P('/api/portal/stock', tokA)).status === 200, 'Stock is back for Vera, same session');
  ok((await P('/api/portal/export/orders', tokA)).status === 200, '…and so is her report download');
  await out(tokA); await out(tokB);

  // ── 7. ANOTHER CLIENT IS UNTOUCHED.
  const profs = (await J('/api/master/client-profiles')).body;
  const other = (Array.isArray(profs) ? profs : []).find(p => p.client === 'OtherCo');
  ok(!!other && other.portal_visibility === undefined, 'OtherCo carries no visibility setting at all');

  // ── 8. THE TRAIL NAMES THE LOGIN, not just the client.
  const dbj = JSON.parse(require('fs').readFileSync(__dirname + '/sup/tenants/default/db.json', 'utf8'));
  const rows = (dbj.auditLog || []).filter(e => e.type === 'client_portal_visibility_updated');
  ok(rows.length > 0, 'the change is on the audit trail');
  ok(rows.some(e => e.user === 'vera'), 'naming WHICH login was changed');
  ok(rows.some(e => (e.hidden || []).includes('reports')), 'and what was switched off');

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
