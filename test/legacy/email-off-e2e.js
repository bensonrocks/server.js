// With no email configured, completing an order must not log a per-order
// warning, must not stamp/write an "email failed" mark, and the row must not
// carry ⚠ Resend. Resend says so honestly. A row stamped the OLD way heals on
// read.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const XLSX = require('/home/user/server.js/node_modules/xlsx');
const S = __dirname;
const PORT = 4797, B = `http://localhost:${PORT}`, DDIR = path.join(S, 'email-off-data'), MASTER = process.env.MASTER_KEY || '201432547E';
const LOG = path.join(S, 'email-off-server.log');
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms)); const kids = [];
function spawnLogged(args, env, log) { const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true }); kids.push(c); return c; }
async function waitUp(url) { for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stop(c) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} await sleep(1500); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };
let tok = '';
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': tok, 'x-master-key': MASTER });
async function login() { const d = await J(await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) })); tok = d.token; }
function xlsxOf(rows) { const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S'); return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); }
const DBP = path.join(DDIR, 'tenants', 'default', 'db.json');
const boot = async (env = {}) => { const c = spawnLogged(['/home/user/server.js/server.js'], { PORT: String(PORT), DATA_DIR: DDIR, EMAIL_USER: '', EMAIL_PASS: '', EMAIL_TO: '', ...env }, LOG); await waitUp(B + '/api/version'); await sleep(2500); await login(); return c; };

(async () => {
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.mkdirSync(DDIR, { recursive: true }); fs.rmSync(LOG, { force: true });
  let srv = await boot();
  const fd = new FormData();
  fd.append('orderFile', new Blob([xlsxOf([{ 'Order No': 'EM-1', 'SKU Code': 'EM-SKU', 'Quantity': 1 }, { 'Order No': 'EM-2', 'SKU Code': 'EM-SKU', 'Quantity': 1 }])]), 'em.xlsx');
  fd.append('client_name', 'EMCO'); fd.append('arrange_delivery', 'no');
  ok((await fetch(B + '/api/upload', { method: 'POST', headers: { 'x-auth-token': tok, 'x-master-key': MASTER }, body: fd })).status === 200, 'seed: two orders uploaded');
  for (const n of ['EM-1', 'EM-2']) {
    await J(await fetch(B + '/api/scan/setqty', { method: 'POST', headers: H(), body: JSON.stringify({ orderNumber: n, sku: 'EM-SKU', qty: 1 }) }));
    const c = await J(await fetch(B + '/api/scan/complete', { method: 'POST', headers: H(), body: JSON.stringify({ orderNumber: n, startTime: new Date().toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) }));
    ok(c.ok === true, `order ${n} completed`);
  }
  await sleep(2500);
  const log = fs.readFileSync(LOG, 'utf8');
  ok(!/Completion alert for .* skipped/.test(log), 'no per-order "Completion alert … skipped — email not configured" line');
  ok((log.match(/Completion alert emails are off/g) || []).length <= 1, `the fact is said at most once per boot (${(log.match(/Completion alert emails are off/g) || []).length} time(s))`);
  let orders = await J(await fetch(B + '/api/orders?range=all', { headers: H() }));
  const rows = orders.filter(o => /^EM-/.test(o.order_number));
  ok(rows.length === 2 && rows.every(o => o.scan_status === 'done'), 'both orders read as done');
  ok(rows.every(o => o.alert_email_sent === null && !o.alert_email_error), 'neither row carries an email verdict (no ⚠ / Resend on the row)');
  const db = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  const b = db.batches.find(x => x.client_name === 'EMCO');
  ok(b && !('alert_email_sent' in (b.orderStates['EM-1'] || {})) && !('alert_email_at' in (b.orderStates['EM-1'] || {})), 'nothing about email was stamped on the order (no extra write)');
  const rs = await fetch(B + '/api/scan/resend-completion-alert', { method: 'POST', headers: H(), body: JSON.stringify({ orderNumber: 'EM-1' }) });
  const rsd = await J(rs);
  ok(rs.status === 400 && /not configured/i.test(rsd.error || ''), `Resend with no email says so (${rs.status}: ${rsd.error})`);
  const db2 = JSON.parse(fs.readFileSync(DBP, 'utf8'));
  ok(db2.batches.find(x => x.client_name === 'EMCO').orderStates['EM-1'].alert_email_sent !== true, 'and does not mark the order as sent');
  await stop(srv);

  // A row stamped the OLD way (false, no error) reads as "no verdict", not as a failed email.
  { const raw = JSON.parse(fs.readFileSync(DBP, 'utf8')); const bb = raw.batches.find(x => x.client_name === 'EMCO');
    bb.orderStates['EM-2'].alert_email_sent = false; bb.orderStates['EM-2'].alert_email_at = new Date().toISOString();
    bb.orderStates['EM-1'].alert_email_sent = false; bb.orderStates['EM-1'].alert_email_error = 'SMTP refused';
    fs.writeFileSync(DBP, JSON.stringify(raw)); }
  srv = await boot();
  orders = await J(await fetch(B + '/api/orders?range=all', { headers: H() }));
  const r1 = orders.find(o => o.order_number === 'EM-1'), r2 = orders.find(o => o.order_number === 'EM-2');
  ok(r2 && r2.alert_email_sent === null, 'a legacy "not configured" stamp (false, no error) heals to no verdict on read');
  ok(r1 && r1.alert_email_sent === false && r1.alert_email_error === 'SMTP refused', 'a GENUINE failed email still reads as failed with its reason');
  await stop(srv);
  console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`); fails.forEach(f => console.log('  ✗ ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); for (const c of kids) await stop(c); process.exit(2); });
