#!/bin/bash
# Clean run of the waybill-chase suite.
#
# The orders persist in db.json, so a re-run would otherwise find them already
# carrying the waybills the previous run fetched — and "it imports with no
# waybill" would fail against perfectly good code. THE SERVER MUST BE STOPPED
# first: it holds db.json in memory and re-persists over anything written
# underneath it.
set -e
SP=/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad
[ -f "$SP/sup.pid" ] && kill "$(cat "$SP/sup.pid")" 2>/dev/null || true
[ -f "$SP/wb-mock.pid" ] && kill "$(cat "$SP/wb-mock.pid")" 2>/dev/null || true
sleep 2
rm -f "$SP/sup/scan-journal.ndjson"
node -e '
const fs = require("fs"), f = process.argv[1];
const db = JSON.parse(fs.readFileSync(f, "utf8"));
const NUMS = new Set(["WB-1", "WB-2", "WB-OLD", "WB-OLD2", "WB-DETAIL", "WB-GHOST"]);
let dropped = 0;
for (const b of db.batches || []) {
  const keep = (b.orders || []).filter(o => !NUMS.has(o.order_number));
  dropped += (b.orders || []).length - keep.length;
  b.orders = keep;
  for (const n of NUMS) delete (b.orderStates || {})[n];
}
db.batches = (db.batches || []).filter(b => (b.orders || []).length);
// The store must look back far enough to see them again on the first pull.
for (const s of db.zortStores || []) if (s.clientName === "ChaseCo") delete s.lastPullAt;
fs.writeFileSync(f, JSON.stringify(db, null, 2));
console.log(`reset: dropped ${dropped} test order(s)`);
' "$SP/sup/tenants/default/db.json"
cd "$SP"
node wb-mock.js 4928 > wb-mock.log 2>&1 &
echo $! > wb-mock.pid
sleep 1
bash "$SP/restart-sup.sh" >/dev/null
node "$SP/wb.js"
