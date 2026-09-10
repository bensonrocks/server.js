// WHICH reports a login may download — not just whether Reports is on.
const BASE = 'http://localhost:4636', MK = '201432547E', CLIENT = 'VisCo';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', 'x-master-key': MK, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const setVis = (id, visibility) => J(`/api/master/client-profiles/${CLIENT}/portal-users`,
  { method: 'POST', body: JSON.stringify({ id, visibility }) });
const login = async (user, password) => (await (await fetch(BASE + '/api/portal/login', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client: CLIENT, user, password }) })).json());
const out = tok => fetch(BASE + '/api/portal/logout', { method: 'POST', headers: { 'x-auth-token': tok } });
const dl = async (kind, tok) => {
  const r = await fetch(`${BASE}/api/portal/export/${kind}`, { headers: { 'x-auth-token': tok } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json().catch(() => ({})) : null };
};
const ALLON = { overview: true, stock: true, orders: true, inbound: true, send: true, reports: true };

(async () => {
  // ── The office is told which reports exist.
  await setVis('vera', ALLON);
  let g = await J(`/api/master/client-profiles/${CLIENT}/portal-users`);
  ok(Array.isArray(g.body.reports) && g.body.reports.length === 3,
     `the office is told which reports exist (${(g.body.reports || []).map(r => r.key).join(', ')})`);
  ok(g.body.reports.every(r => r.key && r.label && r.hint), 'each one says what it is and what is in it');
  ok(g.body.users.find(u => u.id === 'vera').visibility.report_orders === true,
     'and every report starts on — nobody loses a download the day this ships');

  // ── ALL FOUR DOWNLOAD BY DEFAULT.
  let a = await login('vera', 'visco123'); let tok = a.token;
  for (const k of ['stock', 'report', 'inbound']) {
    ok((await dl(k, tok)).status === 200, `${k} downloads by default`);
  }
  await out(tok);

  // ── SWITCH OFF JUST THE ORDERS WORKBOOK.
  await setVis('vera', { ...ALLON, report_orders: false });
  a = await login('vera', 'visco123'); tok = a.token;
  const ref = await dl('report', tok);
  ok(ref.status === 403, `the orders workbook is refused (${ref.status})`);
  ok(/Orders & movements is not switched on/.test(ref.body?.error || ''),
     `and NAMES the report, not just "Reports" (${ref.body?.error})`);
  ok(ref.body?.hiddenSection === 'report_orders', 'so the page can react to the right thing');
  ok((await dl('stock', tok)).status === 200, 'while the stock position still downloads');
  ok((await dl('inbound', tok)).status === 200, '…and so does inbound');

  // ── AND EVERY KIND THAT FEEDS IT GOES WITH IT. A download switched off on
  // screen must not still be reachable by URL.
  for (const k of ['orders', 'cancelled', 'movements', 'transactions']) {
    ok((await dl(k, tok)).status === 403, `  ${k} is refused too — it is part of the same report`);
  }

  // ── AN UNKNOWN KIND IS NOT SILENTLY ALLOWED.
  await setVis('vera', { ...ALLON, reports: false });
  ok((await dl('made-up-kind', tok)).status === 403, 'an unrecognised kind still needs Reports');
  await setVis('vera', ALLON);
  ok((await dl('made-up-kind', tok)).status !== 403, 'and is not blocked once Reports is on (it 400s on its own merits)');

  // ── THE MASTER SWITCH STILL WINS.
  await setVis('vera', { ...ALLON, reports: false, report_stock: true });
  const m = await dl('stock', tok);
  ok(m.status === 403 && m.body?.hiddenSection === 'reports',
     `Reports off refuses everything, whatever the individual ticks say (${m.body?.hiddenSection})`);

  // ── PER LOGIN, still.
  await setVis('vera', { ...ALLON, report_orders: false });
  await J(`/api/master/client-profiles/${CLIENT}/portal-users`, { method: 'POST',
    body: JSON.stringify({ id: 'wes', visibility: ALLON }) });
  const w = await login('wes', 'visco456');
  ok((await dl('report', w.token)).status === 200,
     'Wes on the SAME client still downloads the workbook Vera cannot');
  await out(w.token);

  // ── IT BITES MID-SESSION.
  ok((await dl('inbound', tok)).status === 200, 'Vera has inbound');
  await setVis('vera', { ...ALLON, report_inbound: false });
  ok((await dl('inbound', tok)).status === 403, 'switched off mid-session and it is gone at once');
  await setVis('vera', ALLON);
  ok((await dl('inbound', tok)).status === 200, 'and back when it is switched on again');
  await out(tok);

  // ── "What can ship" IS GONE FROM THE CLIENT'S SCREEN, per the user — it
  // reports on OPEN orders, so an account with none saw an empty file and read
  // it as broken. The kind is still served behind the master switch so an old
  // bookmark answers rather than 500s.
  await setVis('vera', ALLON);
  a = await login('vera', 'visco123'); tok = a.token;
  ok((await dl('fulfillability', tok)).status === 200, 'an old bookmark still answers rather than erroring');
  await setVis('vera', { ...ALLON, reports: false });
  ok((await dl('fulfillability', tok)).status === 403, '…and is still refused when Reports is off');
  await setVis('vera', ALLON);
  await out(tok);

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
