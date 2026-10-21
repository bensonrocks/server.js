// Per-login device cap (max_sessions) for multi-device portal logins, through
// the REAL server on a throwaway DATA_DIR. Master-key only; no staff login.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const PORT = 4000 + Math.floor(Math.random() * 900) + 50;
const B = `http://localhost:${PORT}`;
const MASTER = process.env.MASTER_KEY || '201432547E';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async r => { const t = await r.text(); try { return { ...JSON.parse(t), status: r.status }; } catch { return { status: r.status, _raw: t }; } };
const MH = { 'Content-Type': 'application/json', 'x-master-key': MASTER };
const C = 'MAXSESSCO';
const U = `${B}/api/master/client-profiles/${C}/portal-users`;
let kid, DDIR;
const save = body => fetch(U, { method: 'POST', headers: MH, body: JSON.stringify(body) }).then(J);
const login = () => fetch(B + '/api/portal/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: C, user: 'ops', password: 'Passw0rd!x' }) }).then(J);
const release = () => fetch(`${U}/ops/release`, { method: 'POST', headers: MH });

test.before(async () => {
  DDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-'));
  kid = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DDIR }, stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/version')).status < 500) break; } catch {} await sleep(500); }
  await sleep(1500);
  const c = await J(await fetch(B + '/api/master/client-profiles', { method: 'POST', headers: MH, body: JSON.stringify({ client: C }) }));
  assert.ok(c.status < 300, JSON.stringify(c));
  const u = await save({ name: 'ops', access: 'full', password: 'Passw0rd!x', multi_session: true });
  assert.strictEqual(u.user.id, 'ops');
});
test.after(async () => { try { process.kill(-kid.pid, 'SIGTERM'); } catch {} await sleep(500); fs.rmSync(DDIR, { recursive: true, force: true }); });

test('default stays at 8 devices when max_sessions is unset', async () => {
  const g = await J(await fetch(U, { headers: MH }));
  const u = (g.users || []).find(x => x.id === 'ops');
  assert.strictEqual(u.max_sessions, 8);
  assert.strictEqual(u.max_sessions_custom, false);
  for (let i = 0; i < 8; i++) assert.ok((await login()).token, 'device ' + (i + 1));
  const ninth = await login();
  assert.strictEqual(ninth.status, 409); assert.ok(ninth.inUse);
  await release();
});

test('max_sessions=3 refuses a 4th device with 409, changes nothing else', async () => {
  const before = (await J(await fetch(U, { headers: MH }))).users.find(x => x.id === 'ops');
  const r = await save({ id: 'ops', max_sessions: 3 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.user.max_sessions, 3);
  for (const k of ['name', 'access', 'enabled', 'multi_session', 'hasPassword', 'email']) assert.deepStrictEqual(r.user[k], before[k], k);
  assert.deepStrictEqual(r.user.visibility, before.visibility);
  for (let i = 0; i < 3; i++) assert.ok((await login()).token, 'device ' + (i + 1));
  const fourth = await login();
  assert.strictEqual(fourth.status, 409); assert.match(fourth.error, /3 devices/);
  await release();
});

test('out-of-range values are refused; null clears back to 8', async () => {
  for (const v of [0, 9, 2.5, 'abc']) assert.strictEqual((await save({ id: 'ops', max_sessions: v })).status, 400, String(v));
  const r = await save({ id: 'ops', max_sessions: null });
  assert.strictEqual(r.user.max_sessions, 8); assert.strictEqual(r.user.max_sessions_custom, false);
});
