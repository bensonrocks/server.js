// Mock Shopify Admin GraphQL API — the sandbox cannot reach *.myshopify.com,
// so the client is exercised against this, mirroring the zort-mock pattern.
const http = require('http');
const state = { phase: 1, fulfillments: [], mints: 0, protectedDenied: false };
const ORD = (name, extra = {}) => ({
  id: `gid://shopify/Order/${name.replace('#','')}`,
  name, createdAt: '2026-08-30T10:00:00Z', cancelledAt: null,
  displayFulfillmentStatus: 'UNFULFILLED', phone: '',
  customer: { displayName: 'Tan Ah Kow' },
  shippingAddress: { name: 'Tan Ah Kow', address1: '1 Test Way', address2: '', city: 'Singapore', zip: '609216', country: 'SG', phone: '91234567' },
  lineItems: { nodes: [
    { sku: 'SHOP-A', title: 'Shop Widget A', quantity: 2, variant: { barcode: '555000111' } },
    { sku: 'SHOP-B', title: 'Shop Widget B', quantity: 1, variant: { barcode: '' } },
  ] },
  fulfillments: [],
  ...extra,
});
function orders() {
  const list = [
    ORD('#2001'),
    ORD('#2002', { cancelledAt: '2026-08-30T11:00:00Z' }),
    ORD('#2003', { displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ trackingInfo: [{ number: 'TRACK-2003', company: 'x' }] }] }),
  ];
  if (state.phase >= 2) {
    list[0] = ORD('#2001', { cancelledAt: '2026-08-31T09:00:00Z', fulfillments: [{ trackingInfo: [{ number: 'TRK-2001', company: 'x' }] }] });
  }
  return list;
}
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/__state') return res.end(JSON.stringify(state));
    // Dev-Dashboard token mint: client-credentials grant, 24h token. The
    // GraphQL below then REQUIRES the minted value, so a stale/pasted token
    // fails exactly the way a real dashboard app would after a day.
    if (req.url.endsWith('/admin/oauth/access_token')) {
      let b = {}; try { b = JSON.parse(body); } catch (_) {}
      if (b.client_id !== 'cid_test' || b.client_secret !== 'shpss_test' || b.grant_type !== 'client_credentials') {
        res.statusCode = 401; return res.end(JSON.stringify({ error: 'invalid_client' }));
      }
      state.mints++;
      return res.end(JSON.stringify({ access_token: 'minted_' + state.mints, expires_in: 86400 }));
    }
    if (req.url === '/__phase2') { state.phase = 2; return res.end('{"ok":true}'); }
    if (req.url === '/__protecteddenied') { state.protectedDenied = true; return res.end('{"ok":true}'); }
    if (req.url === '/__protectedapproved') { state.protectedDenied = false; return res.end('{"ok":true}'); }
    let q = {}, vars = {};
    try { q = JSON.parse(body); vars = q.variables || {}; } catch (_) {}
    const query = String(q.query || '');
    const tok = req.headers['x-shopify-access-token'];
    if (!tok) return res.end(JSON.stringify({ errors: [{ message: 'Invalid API key or access token' }] }));
    // When mints have happened, only the LATEST minted token is valid.
    if (state.mints > 0 && tok !== 'minted_' + state.mints) {
      return res.end(JSON.stringify({ errors: [{ message: 'Invalid API key or access token (expired)' }] }));
    }
    if (query.includes('shop {') || query.includes('shop{')) {
      return res.end(JSON.stringify({ data: { shop: { name: 'ShopCo Test Store', myshopifyDomain: 'shopco.myshopify.com' } } }));
    }
    if (query.includes('fulfillmentOrders')) {
      return res.end(JSON.stringify({ data: { order: { fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/FO-2001', status: 'OPEN' }] } } } }));
    }
    if (query.includes('fulfillmentCreate')) {
      state.fulfillments.push(vars.fulfillment);
      return res.end(JSON.stringify({ data: { fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS' }, userErrors: [] } } }));
    }
    if (query.includes('orders(')) {
      const wantsProtected = query.includes('shippingAddress');
      if (wantsProtected && state.protectedDenied) {
        return res.end(JSON.stringify({ errors: [{ message: "Access denied for customer field. Required access: `Protected customer data` access, learn more at https://shopify.dev/docs/apps/launch/protected-customer-data" }] }));
      }
      const list = orders().map(o => wantsProtected ? o : { ...o, shippingAddress: undefined, customer: undefined, phone: undefined });
      return res.end(JSON.stringify({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: vars.after ? [] : list } } }));
    }
    res.end(JSON.stringify({ errors: [{ message: 'mock: unknown query' }] }));
  });
}).listen(4699, () => console.log('shopify mock on 4699'));
