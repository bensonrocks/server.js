// A CLIENT NEW TO THE HUB HAD NOWHERE TO LAND BUT THE STORE'S OWN LABEL.
//
// Reported live (21 Sep 2026) with a screenshot of the hub's Sell list: a new
// client, SmileFam, selling on a channel called `ShopeeSmilefam`, with a
// Pending order on it. The question was whether that order reaches IdealOne —
// and, if it does, under whose name.
//
// It reached IdealOne. It landed under IDEALONEHUB. `attributeSyncClient` ends
// `store.clientName || channel || 'ZORT'`, and on a hub account `clientName` is
// the account LABEL, nobody's account — so a client on their first day, with no
// item master loaded and no channel mapping made, is EXACTLY the case that
// falls all the way through. Their orders pool in one bin shared with every
// other unplaceable client, where their stock, billing and portal visibility
// sit against the wrong account, in silence.
//
// The fallback now files under the SALES CHANNEL on a hub — per client, named,
// visible, refileable — while a SINGLE-CLIENT store keeps its own label, which
// there really is the client. The store says which it is; `channelClients`
// carrying any entry is that declaration, and `newClientFromChannel` pins it.
//
// SERVER_JS=<path> points it at another build. The pre-fix build files SF-1001
// under IDEALONEHUB and reports no unmapped channel.
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const S = __dirname;
const PORT = 4797, MPORT = 4798, B = `http://localhost:${PORT}`, M = `http://localhost:${MPORT}`;
const MASTER = process.env.MASTER_KEY || '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kids = [];
function spawnLogged(args, env, log) {
  const c = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], detached: true });
  kids.push(c); return c;
}
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).status < 500) return; } catch {} await sleep(500); } throw new Error('not up ' + url); }
async function stop(c) { if (!c) return; try { process.kill(-c.pid, 'SIGTERM'); } catch {} try { process.kill(c.pid, 'SIGTERM'); } catch {} await sleep(1500); }
const J = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } };

let tok = '';
const H = () => ({ 'Content-Type': 'application/json', 'x-auth-token': tok, 'x-master-key': MASTER });
const SERVER = process.env.SERVER_JS || path.join(__dirname, '../../server.js');
const DDIR = path.join(S, 'newclient-data');

// A STRAY SERVER ON THIS PORT SERVES ITS OWN DATA AND THE RESULTS READ AS REAL
// BUGS. Wait for one of ours that is still dying, then refuse a foreign one.
async function portFree() {
  for (let i = 0; i < 20; i++) {
    try { await fetch(B + '/api/version'); } catch { return true; }
    await sleep(500);
  }
  return false;
}

const addOrder = (q) => fetch(M + '/_add?' + new URLSearchParams(q));

async function makeStore(body) {
  const st = await J(await fetch(B + '/api/master/zort/stores', { method: 'POST', headers: H(), body: JSON.stringify(body) }));
  return st.id || (st.store && st.store.id);
}
const pull = async id => J(await fetch(B + `/api/master/zort/stores/${id}/pull`, { method: 'POST', headers: H(), body: '{}' }));
const stores = async () => J(await fetch(B + '/api/master/zort/stores', { headers: H() }));
const storeById = async id => (await stores()).find(s => s.id === id);

const dbOf = () => JSON.parse(fs.readFileSync(path.join(DDIR, 'tenants', 'default', 'db.json'), 'utf8'));
// WHICH ACCOUNT AN ORDER IS FILED UNDER IS THE BATCH'S CLIENT — every reader
// (portal, billing, stock, the sidebar) resolves it that way, so that is what
// the checks read, not a display string.
function clientOf(order) {
  const db = dbOf();
  for (const b of db.batches || []) {
    if ((b.orders || []).some(o => o.order_number === order)) return b.client_name;
  }
  return null;
}

(async () => {
  const mock = spawnLogged([path.join(S, 'newclient-mock.js'), String(MPORT)], {}, path.join(S, 'newclient-mock.log'));
  await waitUp(M + '/_hits');

  if (!(await portFree())) throw new Error(`something is already answering on ${PORT} and it is not mine`);
  fs.rmSync(DDIR, { recursive: true, force: true }); fs.mkdirSync(DDIR, { recursive: true });
  const srv = spawnLogged([SERVER], {
    PORT: String(PORT), DATA_DIR: DDIR, ZORT_OUTBOX_MS: '60000',
  }, path.join(S, 'newclient-server.log'));
  await waitUp(B + '/api/version'); await sleep(2500);
  const v = await J(await fetch(B + '/api/version'));
  ok(!!v.bootedAt, 'the server under test is mine (bootedAt ' + (v.bootedAt || '?') + ')');
  tok = (await J(await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) }))).token;
  ok(!!tok, 'signed in');

  // ── THE HUB. One login, many clients' channels. Mayer is set up (mapped);
  //    SmileFam has just gone live and is set up nowhere. ─────────────────────
  const hub = await makeStore({
    clientName: 'IDEALONEHUB', storename: 'hub', apikey: 'k', apisecret: 's',
    endpoint: M, enabled: true, channelClients: { 'Lazada20082026Mayer': 'Mayer2026' },
  });
  ok(!!hub, 'hub store connected');
  let row = await storeById(hub);
  ok(row.newClientFromChannel === null, 'the hub store pins nothing — it is left on automatic');
  ok(row.newClientFromChannelEffective === true,
     'automatic resolves to ON for a hub (it maps a channel to a client, so its own name is a label)');

  const r1 = await pull(hub);
  await sleep(2000);
  ok((r1.result || r1).created >= 2, `the pull imported the two Pending orders (${(r1.result || r1).created})`);

  // 1. THE REPORTED ORDER — the whole point of the change.
  ok(clientOf('SF-1001') === 'ShopeeSmilefam',
     `SF-1001 is filed under its own sales channel, not the hub's label (got ${clientOf('SF-1001')})`);
  ok(clientOf('SF-1001') !== 'IDEALONEHUB',
     'SF-1001 did NOT pool into IDEALONEHUB with every other unplaceable client');

  // 2. A MAPPING STILL WINS. Nothing that already worked moves.
  ok(clientOf('SF-1002') === 'Mayer2026',
     `SF-1002 still follows the channel→client mapping (got ${clientOf('SF-1002')})`);

  // 3. Already handled on the hub — never floor work.
  ok(clientOf('SF-1003') === null, 'SF-1003 (Success at the hub) was not imported');

  // 4. THE NEW CHANNEL ANNOUNCES ITSELF, by name.
  row = await storeById(hub);
  const unmapped = row.lastResult?.unmappedChannels || [];
  ok(unmapped.includes('ShopeeSmilefam'), `the store row names the unmapped channel (${JSON.stringify(unmapped)})`);
  ok(!unmapped.includes('Lazada20082026Mayer'), 'a channel that IS mapped is not reported as unmapped');

  // 5. AND IT SAYS WHERE THE ORDER WENT. A count nobody can act on is noise.
  const un = (row.lastResult?.needsAttribution || []).find(x => x.order === 'SF-1001');
  ok(!!un, 'SF-1001 is reported as not attributed with confidence');
  ok(/sales channel/i.test(un?.why || ''), `the reason says it was filed under the sales channel (${un?.why || '—'})`);
  ok(/map the channel|item master/i.test(un?.why || ''), 'and says what to do about it');

  // 6. THE ORDER IS REAL FLOOR WORK, under that client.
  const orders = await J(await fetch(B + '/api/orders?range=all', { headers: H() }));
  const list = Array.isArray(orders) ? orders : (orders.orders || []);
  const sf = list.find(o => o.order_number === 'SF-1001');
  ok(!!sf, 'SF-1001 is on the Orders list');
  ok((sf?.client_name || '') === 'ShopeeSmilefam', `and reads as ShopeeSmilefam there too (${sf?.client_name})`);

  // ── THE PLACEHOLDER RESOLVES ITSELF once the client is properly set up.
  //    This is what makes filing under a channel a waypoint rather than a new
  //    kind of wrong: load their item master and the SKU takes over. ─────────
  await J(await fetch(B + '/api/inventory', { method: 'POST', headers: H(),
    body: JSON.stringify({ clientId: 'SmileFam', sku: 'SMILE-A', name: 'SmileFam Baby Wipes 80s', stock_qty: 0 }) }));
  await addOrder({ acc: 'hub', number: 'SF-1004', channel: 'ShopeeSmilefam', sku: 'SMILE-A', name: 'SmileFam Baby Wipes 80s' });
  await pull(hub); await sleep(2000);
  ok(clientOf('SF-1004') === 'SmileFam',
     `once SmileFam's item master exists the SKU places the order, not the channel (got ${clientOf('SF-1004')})`);
  ok(clientOf('SF-1001') === 'ShopeeSmilefam',
     'and the order already filed is left exactly where it was (🔄 Refile moves it, nothing moves it silently)');

  // ── A CHANNEL NAMED LIKE AN OBJECT PROPERTY. The channel name comes off the
  //    hub's reply, so a plain `map[channel]` answers `constructor` with an
  //    INHERITED, TRUTHY value — the order would read as mapped and be filed
  //    under a Function. Own-properties only, measured not reasoned about. ───
  await addOrder({ acc: 'hub', number: 'SF-1006', channel: 'constructor', sku: 'PROTO-A', name: 'Odd Channel' });
  await pull(hub); await sleep(2000);
  ok(clientOf('SF-1006') === 'constructor',
     `a channel named "constructor" is not mistaken for a mapped one (got ${JSON.stringify(clientOf('SF-1006'))})`);
  row = await storeById(hub);
  ok((row.lastResult?.unmappedChannels || []).includes('constructor'),
     'and it is still reported as unmapped rather than silently swallowed');

  // The same name arriving as a MAP KEY on the save route is refused outright.
  await J(await fetch(B + '/api/master/zort/stores', { method: 'POST', headers: H(),
    body: JSON.stringify({ id: hub, channelClients: { '__proto__': 'Evil', 'Lazada20082026Mayer': 'Mayer2026' } }) }));
  const saved = (await storeById(hub)).channelClients || {};
  ok(!Object.prototype.hasOwnProperty.call(saved, '__proto__'),
     'a channelClients key of __proto__ is dropped, never written');
  ok(saved['Lazada20082026Mayer'] === 'Mayer2026', 'and the real mapping beside it is kept');

  // ── THE SINGLE-CLIENT STORE — the regression this is guarded against.
  //    Here `clientName` IS the client, and a channel name would mint a
  //    phantom account beside a client that was filing correctly. ────────────
  const solo = await makeStore({
    clientName: 'AcmeSolo', storename: 'solo', apikey: 'k', apisecret: 's',
    endpoint: M, enabled: true,
  });
  let srow = await storeById(solo);
  ok(srow.newClientFromChannelEffective === false,
     'automatic resolves to OFF for a store that maps no channel — it reads as a single-client store');
  await pull(solo); await sleep(2000);
  ok(clientOf('SO-2001') === 'AcmeSolo',
     `a single-client store still files under its own client, NOT the channel (got ${clientOf('SO-2001')})`);

  // ── THE OPERATOR OVERRIDES EITHER WAY. ──────────────────────────────────
  await J(await fetch(B + '/api/master/zort/stores', { method: 'POST', headers: H(),
    body: JSON.stringify({ id: solo, newClientFromChannel: true }) }));
  srow = await storeById(solo);
  ok(srow.newClientFromChannel === true && srow.newClientFromChannelEffective === true,
     'pinning it ON is stored and takes effect');
  // A SKU NOTHING KNOWS. Re-using ACME-A would prove nothing: the first pull
  // harvested it into AcmeSolo's catalogue, so the SKU step places it and the
  // fallback never runs — which is the right answer, and not the one under
  // test here.
  await addOrder({ acc: 'solo', number: 'SO-2002', channel: 'ShopeeAcmeShop', sku: 'ACME-B', name: 'Acme Gadget' });
  await pull(solo); await sleep(2000);
  ok(clientOf('SO-2002') === 'ShopeeAcmeShop',
     `pinned ON, the single-client store files the next order under the channel (got ${clientOf('SO-2002')})`);

  await J(await fetch(B + '/api/master/zort/stores', { method: 'POST', headers: H(),
    body: JSON.stringify({ id: hub, newClientFromChannel: false }) }));
  await addOrder({ acc: 'hub', number: 'SF-1005', channel: 'ShopeeBrandNew', sku: 'NEW-A', name: 'Brand New Thing' });
  await pull(hub); await sleep(2000);
  ok(clientOf('SF-1005') === 'IDEALONEHUB',
     `pinned OFF, the hub goes back to its own label (got ${clientOf('SF-1005')})`);

  await J(await fetch(B + '/api/master/zort/stores', { method: 'POST', headers: H(),
    body: JSON.stringify({ id: hub, newClientFromChannel: '' }) }));
  const back = await storeById(hub);
  ok(back.newClientFromChannel === null && back.newClientFromChannelEffective === true,
     'clearing the pin returns it to automatic');

  // ── THE TRAIL. It decides which account a client's stock and billing sit
  //    against, so a change to it is named. ─────────────────────────────────
  await sleep(1500);
  const audit = (dbOf().auditLog || []).filter(e => e.type === 'zort_new_client_from_channel_changed');
  ok(audit.length >= 3, `every change to the setting is on the trail (${audit.length})`);
  ok(audit.some(e => e.setting === false) && audit.some(e => e.setting === 'auto'),
     'and records what it was set to, including back to automatic');
  ok(audit.every(e => 'effective' in e), 'with what that actually resolves to');

  console.log('\n' + (fails.length ? `FAILED ${fails.length}` : 'ALL PASSED'));
  await stop(srv); await stop(mock);
  process.exit(fails.length ? 1 : 0);
})().catch(async e => {
  console.error('CRASH', e);
  for (const k of kids) await stop(k);
  process.exit(2);
});
