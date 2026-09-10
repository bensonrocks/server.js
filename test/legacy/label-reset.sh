#!/bin/bash
# Put order 24944949 back to "one carton, 3 pcs, label NOT yet confirmed" so the
# auto-print prompt fires again.
#
# THE SERVER MUST BE STOPPED FIRST — it holds db.json in memory and will
# re-persist over anything written underneath it — and scan-journal.ndjson has
# to go, since replay takes the HIGHER count and would restore the old scans.
set -e
SP=/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad
[ -f "$SP/sup.pid" ] && kill "$(cat "$SP/sup.pid")" 2>/dev/null || true
sleep 2
rm -f "$SP/sup/scan-journal.ndjson"
node -e '
const fs = require("fs"), f = process.argv[1];
const db = JSON.parse(fs.readFileSync(f, "utf8"));
for (const b of db.batches || []) {
  const s = (b.orderStates || {})["24944949"];
  if (!s) continue;
  // A FRESH order: nothing scanned, one empty unconfirmed carton. That is the
  // state the label prompt is written for — the label goes on the box BEFORE
  // it is packed.
  s.status = "pending";
  s.scanned = {};
  s.activeCartonNum = 1;
  s.cartons = [{ num: 1, scans: {}, startedAt: new Date().toISOString() }];
  s.scanLog = [];
  delete s.endTime; delete s.endTime_derived; delete s.inventory_deducted;
}
fs.writeFileSync(f, JSON.stringify(db, null, 2));
console.log("reset 24944949 — fresh, one empty unconfirmed carton");
' "$SP/sup/tenants/default/db.json"
bash "$SP/restart-sup.sh"
