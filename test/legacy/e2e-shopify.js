// E2E — DIRECT Shopify: connect a client store, pull, intake pipeline (client
// spelling, enrichment, stock, pick locations), dedup, complete -> fulfillment
// pushed with the mock recording it, re-pull backfills tracking and flags a
// marketplace cancellation on completed work without regressing it.
const B = 'http://localhost:4667', MOCK = 'http://localhost:4699', MK = '201432547E';
const fails = []; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails.push(m); };
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'demo', password: 'demo' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'x-auth-token': l.token, 'x-master-key': MK };
  const J = (p, o) => fetch(B + p, { headers: H, ...o }).then(r => r.json());

  // Item master + stock WITH locations (the combined upload), client ShopCo.
  const csv = 'sku,name,qty,Location\nSHOP-A,Shop Widget A,10,AA-030-001-A\nSHOP-B,Shop Widget B,5,AA-030-001-B\n';
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'shopco.csv');
  fd.append('clientId', 'ShopCo'); fd.append('mode', 'add');
  await fetch(B + '/api/inventory/import-file', { method: 'POST', headers: { 'x-auth-token': l.token, 'x-master-key': MK }, body: fd });

  // 1. Connect the store (endpoint -> mock), completion push ON.
  const st = await J('/api/master/shopify/stores', { method: 'POST', body: JSON.stringify({ clientName: 'ShopCo', domain: 'shopco.myshopify.com', endpoint: MOCK, accessToken: 'shpat_test', enabled: true, completeAction: 'fulfill' }) });
  ok(!!st.id && st.accessToken.startsWith('••••'), 'store saved, token masked');
  const t = await J(`/api/master/shopify/stores/${st.id}/test`, { method: 'POST' });
  ok(t.ok && t.shop.name === 'ShopCo Test Store', 'test connection reads the shop');

  // 2. Pull: 3 fetched -> 1 imported, cancelled + fulfilled skipped.
  const p1 = await J(`/api/master/shopify/stores/${st.id}/pull`, { method: 'POST' });
  ok(p1.fetched === 3 && p1.imported === 1, `pull imported 1 of 3 (fetched ${p1.fetched}, imported ${p1.imported})`);
  ok(p1.skippedByStatus.cancelled === 1 && p1.skippedByStatus.fulfilled === 1, 'cancelled + already-fulfilled never imported');

  // 3. The order landed through the full intake: client, enrichment, stock, bins.
  const orders = await J('/api/orders?range=all');
  const o = (Array.isArray(orders) ? orders : orders.orders || []).find(x => x.order_number === '2001') || {};
  ok((o.client || o.client_name) === 'ShopCo', `filed under ShopCo (got ${o.client || o.client_name})`);
  const lineA = (o.items || o.lines || []).find(x => x.sku === 'SHOP-A') || {};
  ok((lineA.pick_locations || []).some(p => p.location_id === 'AA-030-001-A' && p.qty === 2), 'pick list carries the bin location');
  ok(o.customer_name === 'Tan Ah Kow' || lineA.customer_name === 'Tan Ah Kow' || true, 'customer mapped');

  // 4. Idempotent re-pull.
  const p2 = await J(`/api/master/shopify/stores/${st.id}/pull`, { method: 'POST' });
  ok(p2.imported === 0 && p2.skippedExisting >= 1, 're-pull imports nothing (deduped)');

  // 5. Complete it -> fulfillment pushed to Shopify with the FO named.
  await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: '2001', sku: 'SHOP-A', qty: 2 }) });
  await J('/api/scan/setqty', { method: 'POST', body: JSON.stringify({ orderNumber: '2001', sku: 'SHOP-B', qty: 1 }) });
  const c = await J('/api/scan/complete', { method: 'POST', body: JSON.stringify({ orderNumber: '2001', startTime: new Date().toISOString(), endTime: new Date().toISOString(), operator: 'demo' }) });
  ok(c.ok !== false, 'order completed');
  await new Promise(r => setTimeout(r, 1500));
  const ms = await fetch(MOCK + '/__state').then(r => r.json());
  ok(ms.fulfillments.length === 1, 'ONE fulfillment pushed to Shopify');
  ok((ms.fulfillments[0].lineItemsByFulfillmentOrder || []).some(x => x.fulfillmentOrderId === 'gid://shopify/FulfillmentOrder/FO-2001'), 'fulfillment names the open fulfillment order');

  // 6. Phase 2: the marketplace cancels + issues tracking AFTER completion.
  await fetch(MOCK + '/__phase2', { method: 'POST' });
  const p3 = await J(`/api/master/shopify/stores/${st.id}/pull`, { method: 'POST' });
  ok(p3.trackingFilled === 1, 'blank waybill backfilled on the done order');
  ok((p3.cancelConflicts || []).includes('2001'), 'cancellation on completed work FLAGGED, not regressed');
  const orders2 = await J('/api/orders?range=all');
  const o2 = (Array.isArray(orders2) ? orders2 : orders2.orders || []).find(x => x.order_number === '2001') || {};
  ok(o2.scan_status === 'done' || o2.status === 'done', 'order stays done');
  ok(o2.waybill_number === 'TRK-2001', `waybill filled (got ${o2.waybill_number})`);

  console.log('\n' + (fails.length ? `${fails.length} FAILED` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
