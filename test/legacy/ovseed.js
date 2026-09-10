// Give VisCo a real position so the Overview has alerts and a chart to draw.
const BASE = 'http://localhost:4636', MK = '201432547E';
const fs = require('fs');
const DB = __dirname + '/sup/tenants/default/db.json';
(async () => {
  const T = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'demo', password: 'demo' }) })).json()).token;
  const H = { 'content-type': 'application/json', 'x-auth-token': T, 'x-master-key': MK };
  // Two out of stock, two running low, two healthy.
  const items = [
    ['VS-OUT-1', 0, 10], ['VS-OUT-2', 0, 10],
    ['VS-LOW-1', 3, 10], ['VS-LOW-2', 5, 10],
    ['VS-OK-1', 90, 10], ['VS-OK-2', 120, 10],
  ];
  for (const [sku, qty, rp] of items) {
    await fetch(BASE + '/api/inventory', { method: 'POST', headers: H,
      body: JSON.stringify({ clientId: 'visco', sku, name: 'Test ' + sku, stock_qty: qty, reorder_point: rp }) });
  }
  // Completed orders spread over the last fortnight, so the chart has shape.
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  db.batches = (db.batches || []).filter(b => !String(b.id).startsWith('ovseed-'));
  const now = Date.now();
  const days = [1, 1, 1, 3, 3, 6, 9, 9, 9, 9, 12];
  const orders = [], states = {};
  days.forEach((d, i) => {
    const num = `VS-ORD-${i + 1}`;
    orders.push({ order_number: num, lines: [{ sku: 'VS-OK-1', description: 'Test VS-OK-1', qty: 1 + (i % 3) }] });
    states[num] = { status: 'done', scanned: { 'VS-OK-1': 1 + (i % 3) },
                    endTime: new Date(now - d * 86400000).toISOString(), scanLog: [] };
  });
  // …and one still open, so "Orders in progress" is not zero.
  orders.push({ order_number: 'VS-ORD-OPEN', lines: [{ sku: 'VS-OK-2', description: 'Test VS-OK-2', qty: 4 }] });
  states['VS-ORD-OPEN'] = { status: 'pending', scanned: {}, scanLog: [] };
  db.batches.unshift({ id: 'ovseed-1', idealscan_code: 'VS-1', filename: 'seed.xlsx',
    client_name: 'VisCo', uploaded_by: 'test', uploaded_at: new Date(now - 86400000).toISOString(),
    orders, orderStates: states });
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
  console.log('seeded 6 SKUs (2 out, 2 low) and 12 orders across the fortnight');
})();
