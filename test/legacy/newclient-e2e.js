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

  // ── THE REPORTED SHAPE: A HUB THAT MAPS NO CHANNEL AT ALL. ─────────────
  //    Every client has an item master, so the SKU step places each order on
  //    its own and there is no reason to map a single channel. The first cut
  //    read "no mappings" as "single-client store" and a new client's orders
  //    still pooled into the store label — the live account disproved the
  //    heuristic in a day. What settles it is what the store has FILED.
  const hub2 = await makeStore({
    clientName: 'IDEALONEHUB2', storename: 'hub', apikey: 'k', apisecret: 's',
    endpoint: M, enabled: true,            // <- no channelClients whatsoever
  });
  let h2 = await storeById(hub2);
  ok(h2.newClientFromChannelEffective === false,
     'a store that has filed nothing yet reads as single-client — the safe default holds');
  // It files SF-2001 by SKU (SmileFam's master exists by now), which is the
  // very act that proves the login serves somebody other than its own label.
  await addOrder({ acc: 'hub', number: 'SF-2001', channel: 'ShopeeSmilefam', sku: 'SMILE-A', name: 'SmileFam Baby Wipes 80s' });
  await pull(hub2); await sleep(2000);
  ok(clientOf('SF-2001') === 'SmileFam', `the SKU places it (got ${clientOf('SF-2001')})`);
  h2 = await storeById(hub2);
  ok(h2.newClientFromChannelEffective === true,
     'having filed under a client that is NOT its own label, the store now reads as a hub');
  // …so the NEXT unplaceable order lands under its channel, with no mapping
  // and nothing switched on by hand — which is what was asked for.
  await addOrder({ acc: 'hub', number: 'SF-2002', channel: 'ShopeeBrandNew2', sku: 'NEW2-A', name: 'Another New Client' });
  await pull(hub2); await sleep(2000);
  ok(clientOf('SF-2002') === 'ShopeeBrandNew2',
     `a new client lands under its channel with NO mapping made (got ${clientOf('SF-2002')})`);
  ok(clientOf('SF-2002') !== 'IDEALONEHUB2', 'and not in the hub label bin');

  // ── THE TWO WAYS AN ORDER USED TO VANISH WITH NOTHING SAID. ────────────
  //    Reported as "still don't see it" with a client list whose own numbers
  //    added up exactly, so the order was provably not in IdealOne — and the
  //    store row named no reason, because these two skips had no counter.
  await addOrder({ acc: 'hub', number: 'SF-3001', channel: 'ShopeeGhostShop', sku: 'GHOST-A', noLines: '1' });
  await addOrder({ acc: 'hub', number: 'SF-3002', channel: 'ShopeeSmilefam', sku: 'SMILE-A', noNumber: '1' });
  const r3 = await pull(hub2); await sleep(2000);
  const res3 = r3.result || r3;
  ok(clientOf('SF-3001') === null, 'a line-less order is still not imported — there is nothing to pick');
  ok(res3.skippedNoLinesCount === 1, `but it is COUNTED now (${res3.skippedNoLinesCount})`);
  ok((res3.skippedNoLines || []).some(x => x.order === 'SF-3001'),
     'and NAMED, so it can be looked up on the hub');
  ok((res3.skippedNoLines || []).some(x => x.channel === 'ShopeeGhostShop'),
     'with the channel it came in on');
  ok((res3.unmappedChannels || []).includes('ShopeeGhostShop'),
     'a brand-new shop whose first order is line-less STILL names itself — the channel is read before the lines check');
  ok(res3.skippedNoNumberCount === 1, `a row with no order number is counted too (${res3.skippedNoNumberCount})`);
  ok((res3.skippedNoNumber || []).length === 1, 'and its hub id kept, since there is no number to name it by');

  // ── THE ORDER THAT WENT NOWHERE: "45 fetched, 43 known, 1 voided, +0 new".
  //    Its one line had NO SKU — a Shopee listing that never had one set —
  //    and the pull's FINAL filter dropped it after every counter, while
  //    Find order said "1 line, would bring it in". Per the user: a client
  //    with no products uploaded still gets their order, IdealOne learns and
  //    saves the product as the basis, and the person is PROMPTED. ─────────
  const pokesBefore = ((await J(await fetch(B + '/api/pokes', { headers: H() }))).rows || []).length;
  await addOrder({ acc: 'hub', number: 'SF-4001', channel: 'ShopeeSmilefam', name: 'SmileFam Bottle Warmer', noSku: '1', productid: '777' });
  await addOrder({ acc: 'hub', number: 'SF-4002', channel: 'ShopeeSmilefam', sku: 'SMILE-Z', name: 'Zero Qty Thing', zeroQty: '1' });
  const r4 = await pull(hub2); await sleep(2500);
  const res4 = r4.result || r4;
  ok(clientOf('SF-4001') === 'ShopeeSmilefam',
     `the SKU-less order IMPORTS, under its channel (got ${clientOf('SF-4001')})`);
  const o4 = (await J(await fetch(B + '/api/orders?range=all', { headers: H() })));
  const sf4 = (Array.isArray(o4) ? o4 : (o4.orders || [])).find(o => o.order_number === 'SF-4001');
  const ln = (sf4?.lines || sf4?.items || [])[0] || {};
  ok(ln.sku === 'ZORT-P777', `its line carries the hub's product id as a placeholder code (got ${ln.sku})`);
  ok(ln.description === 'SmileFam Bottle Warmer', 'with the product NAME as the description — what a packer picks by');
  ok(ln.sku_source === 'zort-productid', 'and says the code was minted here, not read off the hub');
  ok(res4.placeholderSkuCount === 1 && (res4.placeholderSkuOrders || [])[0]?.sku === 'ZORT-P777',
     'the store row names the placeholder line');
  ok(clientOf('SF-4002') === null, 'a zero-quantity line is still not importable');
  ok(res4.droppedOrdersCount === 1 && (res4.droppedOrders || [])[0]?.order === 'SF-4002',
     'but the dropped order is NAMED on the store row now');
  ok(((res4.droppedOrders || [])[0]?.why || []).includes('zero-qty'), 'with the reason');
  ok(((res4.droppedOrders || [])[0]?.keys || []).includes('number'), 'and the field names the hub line carried');

  // IT LEARNS. The product is saved into ShopeeSmilefam's catalogue as the
  // basis, name and all.
  const inv = await J(await fetch(B + '/api/inventory?clientId=ShopeeSmilefam', { headers: H() }));
  const invRows = Array.isArray(inv) ? inv : (inv.rows || inv.items || []);
  const learned = invRows.find(r => r.sku === 'ZORT-P777');
  ok(!!learned, 'the placeholder product is saved into the client\'s catalogue');
  ok((learned?.name || '') === 'SmileFam Bottle Warmer', `under its real name (got ${learned?.name})`);

  // AND IT PROMPTS. A 🔔 New Work poke names the client and the product.
  const pokes = (await J(await fetch(B + '/api/pokes', { headers: H() }))).rows || [];
  const pk = pokes.find(p => p.kind === 'catalogue_learned' && p.client === 'ShopeeSmilefam'
                           && (p.skus || []).some(x => x.sku === 'ZORT-P777'));
  ok(!!pk, 'a New Work prompt says products were learned for ShopeeSmilefam, naming ZORT-P777');
  ok(pk?.minted === 1, 'and flags that the code was minted, so the SKU gets set on the hub');
  ok(pokes.length > pokesBefore, 'the prompt is a NEW row on the feed');

  // FIND ORDER AGREES WITH THE PULL — it reads the lines the same way.
  await addOrder({ acc: 'hub', number: 'SF-4003', channel: 'ShopeeSmilefam', name: 'Another SKU-less', noSku: '1', productid: '778' });
  await addOrder({ acc: 'hub', number: 'SF-4004', channel: 'ShopeeSmilefam', sku: 'SMILE-Q', name: 'Zero again', zeroQty: '1' });
  const look = JSON.stringify(await J(await fetch(B + `/api/master/zort/stores/${hub2}/lookup`, {
    method: 'POST', headers: H(), body: JSON.stringify({ numbers: ['SF-4003', 'SF-4004'] }) })));
  ok(/ZORT-P778/.test(look) && /placeholder code/i.test(look),
     'Find order says the SKU-less order imports under a placeholder, naming it');
  ok(/would DROP it/.test(look) && /zero quantity/.test(look),
     'and says the zero-quantity order would be dropped, with the reason');

  // ── "KNOWN" CAN HIDE A FILING ERROR. SF-2002 was filed under its channel
  //    placeholder (ShopeeBrandNew2) because nothing else could place it.
  //    The client's REAL item master arrives afterwards, under the account
  //    they actually are. A re-pull skips numbers it holds, by design — so
  //    the order can never move on its own, and "known" would say nothing.
  //    The row now names it, with where it sits and where it belongs. ──────
  await J(await fetch(B + '/api/inventory', { method: 'POST', headers: H(),
    body: JSON.stringify({ clientId: 'BrandNew Ltd', sku: 'NEW2-A', name: 'Another New Client', stock_qty: 0 }) }));
  const r5 = await pull(hub2); await sleep(2000);
  const res5 = r5.result || r5;
  ok(clientOf('SF-2002') === 'ShopeeBrandNew2', 'the re-pull moves nothing by itself (a held number is skipped, by design)');
  const kn = (res5.knownUnderOtherClient || []).find(x => x.order === 'SF-2002');
  ok(!!kn, `but the row names the order as filed under a different client than it would be today (${JSON.stringify(res5.knownUnderOtherClient || [])})`);
  ok(kn?.heldBy === 'ShopeeBrandNew2' && kn?.wouldFileTo === 'BrandNew Ltd',
     `saying where it sits and where it belongs (${kn?.heldBy} → ${kn?.wouldFileTo})`);
  ok(kn?.via === 'sku', 'because the SKU now places it — the real item master beats the learned placeholder');

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
