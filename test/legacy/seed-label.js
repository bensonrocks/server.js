// Reset the demo order to un-picked, un-labelled. Writing db.json only works
// while the server is DOWN (it holds the db in memory) — restart after this.
const fs = require('fs'); const DB = __dirname + '/sup/tenants/default/db.json';
const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
db.batches = (db.batches || []).filter(b => b.id !== 'lbl-demo');
db.batches.unshift({
  id: 'lbl-demo', idealscan_code: 'IS-260821-42', filename: 'betime.xlsx',
  client_name: 'betime', uploaded_by: 'demo', uploaded_at: new Date().toISOString(),
  orders: [{ order_number: '24944949', customer_name: 'TML (052)', issue_no: 'GI-137641',
    lines: [
      { sku: 'K4925', description: 'Koli Pain Relief Plaster (ACTIVE) 5s (Orange)', qty: 3 },
      { sku: 'K5008', description: 'Koli Pain Relief Plaster (MALA) 5s (Khaki)', qty: 3 },
    ] }],
  orderStates: { '24944949': { status: 'pending', scanned: {}, scanLog: [] } },
});
fs.writeFileSync(DB, JSON.stringify(db, null, 2));
// THE CRASH JOURNAL REPLAYS AT STARTUP and takes the higher count, so a seed
// that only rewrites db.json is silently overwritten by the previous run's
// scans. Clear it too.
for (const j of ['scan-journal.ndjson', 'tenants/default/scan-journal.ndjson']) {
  try { fs.rmSync(__dirname + '/sup/' + j, { force: true }); } catch (_) {}
}
console.log('reset 24944949 (and the scan journal)');
