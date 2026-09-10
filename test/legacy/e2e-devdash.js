// E2E — DEV-DASHBOARD auth: the store is configured with Client ID + Secret
// only (no pasted token). IdealOne mints the 24h token itself, caches it
// across calls, and the whole flow (test, pull, complete->fulfill) works.
const B = 'http://localhost:4667', MOCK = 'http://localhost:4699', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': l.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());

  // Master + located stock for the client.
  const csv = 'sku,name,qty,Location\nSHOP-A,Shop Widget A,10,AA-030-001-A\nSHOP-B,Shop Widget B,5,AA-030-001-B\n';
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'aa.csv');
  fd.append('clientId', 'AlchemyAffair'); fd.append('mode', 'add');
  await fetch(B + '/api/inventory/import-file', { method: 'POST', headers: { 'x-auth-token': l.token, 'x-master-key': MK }, body: fd });

  // 1. Credentials-only store (no accessToken at all).
  const st = await J('/api/master/shopify/stores', { method: 'POST', body: JSON.stringify({ clientName: 'AlchemyAffair', domain: 'alchemy-affair.myshopify.com', endpoint: MOCK, apiClientId: 'cid_test', apiClientSecret: 'shpss_test', enabled: true, completeAction: 'fulfill' }) });
  ok(!!st.id && !st.accessToken && st.apiClientSecret.startsWith('••••'), 'store saved with credentials only, secret masked');
  ok(/dev-dashboard/.test(st.authMode), `authMode says dev-dashboard (${st.authMode})`);

  // 2. Wrong credentials are refused in Shopify's words.
  const bad = await J('/api/master/shopify/stores', { method: 'POST', body: JSON.stringify({ id: st.id, apiClientId: 'wrong' }) });
  const tBad = await J(`/api/master/shopify/stores/${st.id}/test`, { method: 'POST' });
  ok(tBad.ok === false && /refused the token mint|invalid_client/i.test(tBad.error), 'bad client id -> mint refused in words');
  await J('/api/master/shopify/stores', { method: 'POST', body: JSON.stringify({ id: st.id, apiClientId: 'cid_test' }) });

  // 3. Test mints and reads the shop.
  const t = await J(`/api/master/shopify/stores/${st.id}/test`, { method: 'POST' });
  ok(t.ok && t.shop.name === 'ShopCo Test Store', 'test mints a token and reads the shop');

  // 4. Pull works on the minted token; ONE mint covers test+pull (cached).
  const p1 = await J(`/api/master/shopify/stores/${st.id}/pull`, { method: 'POST' });
  ok(p1.fetched === 3 && p1.imported === 1, `pull works on minted auth (fetched ${p1.fetched}, imported ${p1.imported})`);
  const ms1 = await fetch(MOCK + '/__state').then(r => r.json());
  ok(ms1.mints === 1, `one cached mint covers test + pull (mints=${ms1.mints})`);

  // 5. Complete -> fulfillment pushed, still on minted auth.
  await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: '2001', sku: 'SHOP-A', qty: 2 }) });
  await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: '2001', sku: 'SHOP-B', qty: 1 }) });
  await J('/api/scan/complete', { method: 'POST', body: JSON.stringify({ orderNumber: '2001', startTime: new Date().toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) });
  await new Promise(r => setTimeout(r, 1500));
  const ms2 = await fetch(MOCK + '/__state').then(r => r.json());
  ok(ms2.fulfillments.length === 1, 'fulfillment pushed on minted auth');

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
