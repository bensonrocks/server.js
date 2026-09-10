#!/bin/bash
# Clean run of the reclassify suite. The RC-* orders persist in db.json and the
# server holds the db in memory, so the reset must happen with it STOPPED —
# and scan-journal.ndjson must go, or replay restores the old counts.
set -e
SP=/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad
[ -f "$SP/sup.pid" ] && kill "$(cat "$SP/sup.pid")" 2>/dev/null || true
sleep 2
rm -f "$SP/sup/scan-journal.ndjson"
node -e '
const fs = require("fs"), f = process.argv[1];
const db = JSON.parse(fs.readFileSync(f, "utf8"));
let dropped = 0;
db.batches = (db.batches || []).filter(b => {
  const keep = (b.orders || []).filter(o => !/^RC-ORD-/.test(o.order_number));
  dropped += (b.orders || []).length - keep.length;
  b.orders = keep;
  for (const n of Object.keys(b.orderStates || {})) if (/^RC-ORD-/.test(n)) delete b.orderStates[n];
  return b.orders.length;
});
fs.writeFileSync(f, JSON.stringify(db, null, 2));
console.log(`reset: dropped ${dropped} RC order(s)`);
' "$SP/sup/tenants/default/db.json"
bash "$SP/restart-sup.sh" >/dev/null
node "$SP/reclass.js"
