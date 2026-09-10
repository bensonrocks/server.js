// Make the VisCo fixture representative enough to DEMONSTRATE the report:
// several products per order with real-looking names, and two cancelled orders
// so the Order lines sheet shows both cases. Test data only — the server must
// be stopped before this runs (it holds db.json in memory).
const fs = require('fs');
const F = __dirname + '/sup/tenants/default/db.json';
const db = JSON.parse(fs.readFileSync(F, 'utf8'));

const CATALOGUE = [
  ['VS-OK-1',  'Aurora Desk Lamp — Warm White'],
  ['VS-KB-22', 'Compact Wireless Keyboard, 60%'],
  ['VS-MG-07', 'Ceramic Mug 350ml, Matte Black'],
  ['VS-CB-14', 'USB-C Braided Cable 2m'],
  ['VS-HP-03', 'Over-Ear Headphones, Charcoal'],
];
const PLAN = {                       // order → [[sku index, qty], …]
  'VS-ORD-1':  [[0, 2], [3, 4]],
  'VS-ORD-2':  [[1, 1], [2, 6], [3, 2]],
  'VS-ORD-3':  [[4, 1]],
  'VS-ORD-4':  [[2, 12]],
  'VS-ORD-5':  [[0, 1], [4, 2]],
  'VS-ORD-6':  [[3, 8]],
  'VS-ORD-7':  [[1, 2], [0, 1]],
  'VS-ORD-8':  [[2, 4]],
  'VS-ORD-9':  [[0, 1], [1, 1], [4, 1]],
  'VS-ORD-10': [[4, 1], [1, 1]],     // cancelled below
  'VS-ORD-11': [[2, 3], [3, 2]],     // cancelled below
};
const CANCEL = {
  'VS-ORD-10': 'Customer cancelled before picking',
  'VS-ORD-11': 'Out of stock — client asked us to hold',
};

let touched = 0, cancelled = 0;
for (const b of db.batches || []) {
  if (String(b.client_name || '').toLowerCase() !== 'visco') continue;
  for (const o of b.orders || []) {
    const plan = PLAN[o.order_number];
    if (!plan) continue;
    o.lines = plan.map(([i, qty]) => ({
      sku: CATALOGUE[i][0], description: CATALOGUE[i][1], qty,
    }));
    // The Pieces column and the line quantities have to agree — a line sheet
    // that disagrees with the order total is worse than none.
    o.total_qty = o.lines.reduce((s, l) => s + l.qty, 0);
    touched++;
    const st = (b.orderStates ||= {})[o.order_number] ||= {};
    if (CANCEL[o.order_number]) {
      st.status = 'unprocessed';
      st.unprocessed_reason = CANCEL[o.order_number];
      st.unprocessed_at = new Date(Date.now() - 2 * 86400000).toISOString();
      st.auto_cancelled = false;
      delete st.endTime;
      cancelled++;
    }
  }
}
fs.writeFileSync(F, JSON.stringify(db, null, 2));
console.log(`seeded ${touched} VisCo orders with real product lines, ${cancelled} of them cancelled`);
