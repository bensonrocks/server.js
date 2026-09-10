#!/bin/bash
SP=/tmp/claude-0/-home-user-server-js/c6f7f812-7f43-5071-90d1-eb00f9dd51b6/scratchpad
cd "$SP"
[ -f sup.pid ] && kill "$(cat sup.pid)" 2>/dev/null
sleep 2
PORT=4636 ZORT_PUSH_BADTOKEN_LOG_MS=1500 ZORT_PUSH_IP_MAX=100000 DATA_DIR="$SP/sup" node /home/user/server.js/server.js > "$SP/sup.log" 2>&1 &
echo $! > sup.pid
for i in $(seq 1 25); do curl -sf localhost:4636/api/version >/dev/null && exit 0; sleep 1; done
echo "restart failed"; exit 1
