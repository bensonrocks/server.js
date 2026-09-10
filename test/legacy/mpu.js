// SAME LOGIN, SEVERAL DEVICES — the per-login multi-device toggle.
//   1. default stays ONE PLACE AT A TIME (regression: second login 409);
//   2. toggled on, three devices sign in together, all three tokens live and
//      correctly scoped, office row counts them;
//   3. ⏏ release frees ALL devices at once;
//   4. toggling back OFF signs everything out and restores the single seat;
//   5. the cap refuses a ninth device with words, not silence.
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const B = 'http://localhost:4636';
const MK = '201432547E';
const CL = 'ChaseCo', UID = 'pu-demo', PW = 'pudemo1';

(async () => {
  const login = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': login.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());
  const pLogin = () => fetch(`${B}/api/portal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: CL, user: UID, password: PW }) });
  const me = (tok) => fetch(`${B}/api/portal/me`, { headers: { 'x-auth-token': tok } });
  const setMulti = (on) => J(`/api/master/client-profiles/${CL}/portal-users`, { method: 'POST', body: JSON.stringify({ id: UID, multi_session: on }) });
  const release = () => J(`/api/master/client-profiles/${CL}/portal-users/${UID}/release`, { method: 'POST' });
  const listUser = async () => (await J(`/api/master/client-profiles/${CL}/portal-users`)).users.find(u => u.id === UID);

  await release();   // clean slate — free anything a previous run left signed in

  // ── 1. DEFAULT: one place at a time, unchanged.
  const a = await pLogin();
  ok(a.status === 200, 'first sign-in takes the seat');
  const b2 = await pLogin();
  const bBody = await b2.json();
  ok(b2.status === 409 && bBody.inUse, `a second device is still refused by default (${b2.status}, "${(bBody.error || '').slice(0, 60)}…")`);
  await release();

  // ── 2. TOGGLED ON: three devices together, all live, all scoped right.
  const t1 = await setMulti(true);
  ok(t1.ok && t1.user.multi_session === true, 'the toggle saves on the login');
  const toks = [];
  for (let i = 0; i < 3; i++) {
    const r = await pLogin();
    ok(r.status === 200, `device ${i + 1} signs in (${r.status})`);
    toks.push((await r.json()).token);
  }
  ok(new Set(toks).size === 3, 'three distinct tokens');
  for (const [i, t] of toks.entries()) {
    const m = await me(t);
    const d = await m.json().catch(() => ({}));
    ok(m.status === 200 && (d.client === CL || d.user?.id === UID || JSON.stringify(d).includes(UID)),
       `device ${i + 1}'s token is live and scoped to ${CL}/${UID}`);
  }
  const row = await listUser();
  ok(row.multi_session === true && row.sessions >= 3,
     `the office row counts the devices (multi=${row.multi_session}, sessions=${row.sessions})`);

  // ── 3. ⏏ RELEASE frees them ALL.
  const rel = await release();
  ok(rel.sessions >= 3, `release reports every seat it freed (${rel.sessions})`);
  for (const [i, t] of toks.entries()) {
    ok((await me(t)).status === 401, `device ${i + 1} is signed out after release`);
  }

  // ── 4. TOGGLING OFF signs everything out and restores the single seat.
  const c1 = await pLogin(); const c2 = await pLogin();
  ok(c1.status === 200 && c2.status === 200, 'two devices back in while multi is on');
  const ct1 = (await c1.json()).token, ct2 = (await c2.json()).token;
  await setMulti(false);
  ok((await me(ct1)).status === 401 && (await me(ct2)).status === 401,
     'switching multi OFF signs both devices out at once');
  const d1 = await pLogin();
  ok(d1.status === 200, 'the next sign-in takes the single seat');
  const d2 = await pLogin();
  ok(d2.status === 409, 'and a second device is refused again — the one-seat rule is back');
  await release();

  // ── 5. THE CAP: an eighth device is the last; the ninth is told so.
  await setMulti(true);
  let last = null;
  for (let i = 0; i < 8; i++) last = await pLogin();
  ok(last.status === 200, 'eight devices sign in');
  const nine = await pLogin();
  const nineBody = await nine.json();
  ok(nine.status === 409 && /8 devices/.test(nineBody.error || ''),
     `the ninth is refused with the count named ("${(nineBody.error || '').slice(0, 70)}")`);
  // tidy: back to the arrangement the pu fixture had
  await setMulti(false);
  await release();

  console.log('\n' + (fails.length ? `${fails.length} FAILED: ${fails.join(' | ')}` : 'ALL PASS'));
})();
