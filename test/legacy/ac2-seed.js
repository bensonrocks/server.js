// Seed the two-clock auto-cancel fixture: client AcCo with AC-ABC (1 on hand)
// and AC-BCD (0), plus a zort-sync batch of four API orders. Run with the
// server STOPPED (it holds db.json in memory).
const fs = require('fs');
const f = process.argv[2];
const db = JSON.parse(fs.readFileSync(f, 'utf8'));
db.batches = (db.batches || []).filter(b => b.id !== 'ac2-batch');
db.batches.unshift({
  id: 'ac2-batch', client_name: 'AcCo', uploaded_at: new Date().toISOString(),
  uploaded_by: 'zort-sync', idealscan_code: 'IS-AC2-01', filename: 'ac2-sync',
  inventory_tracked: true, inventory_client: 'AcCo',
  orders: [
    // NOTHING coverable — the 10-minute clock.
    { order_number: 'AC-NONE',  zort_id: 'zn1', customer_name: 'C1', lines: [{ sku: 'AC-BCD', qty: 1 }] },
    // PART covered (ABC yes, BCD no) — the 90-minute clock.
    { order_number: 'AC-PART',  zort_id: 'zp1', customer_name: 'C2', lines: [{ sku: 'AC-ABC', qty: 1 }, { sku: 'AC-BCD', qty: 1 }] },
    // PART covered by QUANTITY (needs 2 ABC, 1 on hand) — stays armed, shows the live pill.
    { order_number: 'AC-PART2', zort_id: 'zp2', customer_name: 'C3', lines: [{ sku: 'AC-ABC', qty: 2 }] },
    // Fully covered — never touched.
    { order_number: 'AC-OK',    zort_id: 'zk1', customer_name: 'C4', lines: [{ sku: 'AC-ABC', qty: 1 }] },
  ],
  orderStates: {},
});
fs.writeFileSync(f, JSON.stringify(db, null, 2));
console.log('seeded ac2-batch (4 API orders under AcCo)');
