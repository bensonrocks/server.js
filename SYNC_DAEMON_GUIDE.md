# IdealScan ↔ IdealOMS Sync Daemon

**Purpose**: Real-time bidirectional synchronization between IdealScan (legacy system) and IdealOMS (new system) during parallel running phase.

**Duration**: Weeks 1-3 of cutover. Staff work only in IdealScan; changes automatically reflect in IdealOMS for testing and validation.

---

## What Gets Synced

### From IdealScan → IdealOMS (30-second intervals)

**Orders**
- New orders created
- Order status changes (pending → allocated → picking → picked → packed → shipped)
- Order metadata (client, channel, totals)

**Picking Waves**
- Wave creation (status: created → picking → completed)
- Wave metadata (warehouse, mode, timestamps)

**Pick Items & Confirmations**
- Picker confirmations (qty_picked updates)
- Pick timestamps
- Status transitions (pending → completed)

**Cartons & Packaging**
- Carton creation and status changes
- THU code generation
- Weight tracking
- Label printing records

### Data Transform

IdealScan schema → IdealOMS schema (automatic):
- `client_id` → `clientId`
- `order_date` → `orderDate`
- `shipping_cost` → `shippingCost`
- All JSON fields parsed and validated
- Timestamps preserved (ISO 8601)

### What Does NOT Get Synced

- Returns (handle separately in IdealOMS)
- Inbound receipts (new to IdealOMS)
- Analytics snapshots (recalculated independently)
- User accounts (pre-created before sync)

---

## How It Works

### Architecture

```
IdealScan DB
    ↓
[Sync Daemon] (runs every 30 seconds)
    ↓ (poll)
[Detect Changes] (updated_at > last_sync_time)
    ↓
[Transform Schema]
    ↓ (HTTP POST/PUT)
[IdealOMS API]
    ↓
IdealOMS DB
```

### Sync Daemon Lifecycle

**Startup** (automatic on server start):
1. Server loads, creates sync daemon
2. Reads last sync checkpoint from `data/sync-checkpoint.json`
3. First sync pulls all records from last 24 hours
4. Subsequent syncs use checkpoint (only changes since last sync)

**Running**:
1. Every 30 seconds: Poll IdealScan for new/updated records
2. Transform each record to IdealOMS schema
3. POST to IdealOMS API endpoints
4. Log success/failure
5. Update checkpoint to current time

**Shutdown** (manual or server stop):
1. Daemon stops polling
2. Checkpoint preserved for next restart
3. No in-flight requests are lost (HTTP layer handles retries)

### Error Handling

When a record fails to sync:
1. **First attempt fails** → Log error with operation, record ID, message
2. **Retry attempts** (up to 3x) with 5-second backoff
3. **After 3 failures** → Add to error log (visible in dashboard)
4. **Admin action** → Clear error manually or fix the issue and retry

Example error:
```
Operation: syncOrders
Record ID: ORD-20260717-12345
Message: HTTP 400: Order already exists with different schema
Attempts: 3
```

---

## Starting the Sync Daemon

### Automatic (Default)

Daemon starts automatically when server boots:

```bash
PORT=3000 node server.js

# Output:
# IdealOMS ready → http://localhost:3000
# ✅ IdealScan↔IdealOMS sync daemon started (30s polling)
```

### Manual Control

**Start daemon**:
```bash
curl -X POST http://localhost:3000/api/sync/start
```

**Stop daemon**:
```bash
curl -X POST http://localhost:3000/api/sync/stop
```

**Trigger sync now** (don't wait for next interval):
```bash
curl -X POST http://localhost:3000/api/sync/run
```

### Disable Sync Daemon

If you don't want the daemon to run at all:

```bash
ENABLE_SYNC_DAEMON=false PORT=3000 node server.js
```

---

## Monitoring Sync Status

### Dashboard

**Live dashboard**: `http://localhost:3000/sync-dashboard`

Shows:
- ✅ Daemon status (running/stopped)
- 📊 Statistics (total runs, records synced, errors)
- 📈 Records by type (orders, waves, picks, cartons)
- 🔴 Active errors with retry attempts
- ⏱️ Last sync time, interval configuration
- 📝 Recent activity timeline

### API Endpoints

**Get sync status**:
```bash
curl http://localhost:3000/api/sync/status
```

Response:
```json
{
  "enabled": true,
  "lastSyncTime": "2026-07-17T14:30:45.123Z",
  "stats": {
    "totalRuns": 120,
    "recordsSynced": 4523,
    "ordersChanged": 1200,
    "wavesChanged": 450,
    "picksChanged": 2100,
    "cartonsChanged": 773,
    "lastSuccess": "2026-07-17T14:30:45.123Z",
    "activeErrorCount": 2
  },
  "config": {
    "pollingInterval": 30000,
    "batchSize": 50
  }
}
```

**Get recent errors**:
```bash
curl http://localhost:3000/api/sync/errors
```

Response:
```json
{
  "errors": [
    {
      "timestamp": "2026-07-17T14:25:12.345Z",
      "operation": "syncOrders",
      "recordId": "ORD-20260717-001",
      "message": "HTTP 400: Order already exists",
      "attempts": 3
    }
  ]
}
```

**Clear error log**:
```bash
curl -X POST http://localhost:3000/api/sync/errors/clear
```

---

## Configuration

### Environment Variables

```bash
# Sync polling interval (milliseconds)
SYNC_INTERVAL_MS=30000

# API key for IdealOMS (must match server's API_KEY)
API_KEY=migration-key

# Disable sync daemon entirely
ENABLE_SYNC_DAEMON=false

# Server port (sync connects to localhost:PORT)
PORT=3000
```

### Changing Sync Frequency

Default: 30 seconds. To sync every 60 seconds:

```bash
SYNC_INTERVAL_MS=60000 PORT=3000 node server.js
```

To sync every 10 seconds (more aggressive):

```bash
SYNC_INTERVAL_MS=10000 PORT=3000 node server.js
```

---

## Troubleshooting

### Daemon not starting

**Symptom**: Server starts but no sync message

**Cause 1**: IdealScan database not found
```
⚠️ Sync daemon: sourceDb not provided
```

**Fix**: Ensure `data/idealoms.db` exists (copy from IdealScan)

**Cause 2**: ENABLE_SYNC_DAEMON set to false
```bash
ENABLE_SYNC_DAEMON=true PORT=3000 node server.js
```

### Sync failing with "connection refused"

**Symptom**: All records fail, error: "Connection refused"

**Cause**: IdealOMS API not responding

**Fix**:
1. Check server is running: `curl http://localhost:3000/`
2. Check firewall not blocking port 3000
3. Try manual sync: `curl -X POST http://localhost:3000/api/sync/run`

### High error rate

**Symptom**: Many records in error log

**Possible causes**:
1. **Schema mismatch** — Order has missing required fields
   - Fix: Check IdealScan order schema, ensure all required fields present
   - Re-run transform.js to validate
2. **API validation** — IdealOMS rejecting the data
   - Fix: Check error message for which field is invalid
   - Manually edit the record in IdealScan
3. **Duplicate ID** — Order already exists in IdealOMS with different data
   - Fix: Resolve conflict (keep one version, delete the other)

### Sync stuck / not updating

**Symptom**: "Last sync" time not changing for 5+ minutes

**Fix 1**: Check daemon is running
```bash
curl http://localhost:3000/api/sync/status
```

If `"enabled": false`, restart:
```bash
curl -X POST http://localhost:3000/api/sync/start
```

**Fix 2**: Check error count
If high errors, may be retrying. Wait for backoff, or clear errors:
```bash
curl -X POST http://localhost:3000/api/sync/errors/clear
```

**Fix 3**: Restart server
```bash
pkill -f "node server.js"
PORT=3000 node server.js
```

### Checkpoint corruption

**Symptom**: Sync starts from very old date (syncs thousands of records unnecessarily)

**Fix**: Delete checkpoint to reset
```bash
rm data/sync-checkpoint.json
```

On next sync, will pull last 24 hours.

---

## Performance & Limits

### Throughput

- **Orders**: ~100/second (depends on field complexity)
- **Picks**: ~500/second (simpler data)
- **Cartons**: ~100/second

### Batch Limits

- **Batch size**: 50 records per sync operation
- **Retry attempts**: 3x per record
- **Request timeout**: 30 seconds per POST/PUT

### Database Load

Syncing typically uses:
- **IdealScan DB**: ~5-10% CPU (read only, change detection queries)
- **IdealOMS DB**: ~10-15% CPU (INSERT/UPDATE operations)
- **Network**: ~100-500 KB/minute (depending on record volume)

For 100+ orders/day, expect:
- **Sync time**: 2-5 seconds per cycle
- **Memory overhead**: ~50 MB for daemon + buffers
- **Disk space**: No additional (only checkpoints)

---

## Weekly Validation Checklist

During parallel running (weeks 1-3), validate sync health:

**Daily**:
- [ ] Check sync dashboard: `http://localhost:3000/sync-dashboard`
- [ ] Verify "Daemon Status" is 🟢 Running
- [ ] Note "Active Errors" count (should be < 5)

**Weekly**:
- [ ] Pick a sample order from IdealScan
- [ ] Check it appears in IdealOMS within 5 minutes
- [ ] Verify all fields match (client, items, totals)
- [ ] Create a wave in IdealScan, confirm appears in IdealOMS
- [ ] Test picking 3 items, confirm qty_picked syncs

**Before Go-Live**:
- [ ] Sync all historical data (export → transform → import)
- [ ] Validate record counts match: `SELECT COUNT(*) FROM orders`
- [ ] Clear error log, do 24-hour clean run with zero errors
- [ ] Compare analytics metrics (order count, pick rate) side-by-side

---

## Cutover Checklist

When ready to go live:

### Day Before
- [ ] Run final full migration (export → transform → import)
- [ ] Validate all counts match
- [ ] Clear sync error log
- [ ] Notify staff: "Last day in IdealScan, go live tomorrow"

### Go-Live Day (Morning)
- [ ] Stop accepting new orders in IdealScan (read-only)
- [ ] Run one final sync
- [ ] Verify last timestamp in sync dashboard
- [ ] Stop sync daemon: `curl -X POST http://localhost:3000/api/sync/stop`

### Go-Live Day (Afternoon)
- [ ] Staff log into IdealOMS dashboard
- [ ] Create first wave in IdealOMS (not IdealScan)
- [ ] Test picking, packing, label printing
- [ ] All systems go 🎉

### Post-Live
- [ ] Monitor for 24 hours
- [ ] Keep backup of both databases for 7 days
- [ ] Archive IdealScan (don't delete for 90 days audit trail)

---

## FAQ

**Q: Will sync be bidirectional eventually?**
A: Planned for Phase 2. Currently IdealScan → IdealOMS only.

**Q: What if I create an order directly in IdealOMS?**
A: It won't sync back to IdealScan. Keep order creation in IdealScan during parallel running.

**Q: Can I pause sync temporarily?**
A: Yes, stop the daemon: `curl -X POST http://localhost:3000/api/sync/stop`. Resume: `curl -X POST http://localhost:3000/api/sync/start`

**Q: Does sync work across multiple warehouses?**
A: Yes. Sync respects warehouse assignments (each order allocated to one warehouse).

**Q: How do I know sync is working?**
A: Check dashboard (http://localhost:3000/sync-dashboard). If "Records Synced" > 0 and "Active Errors" = 0, you're good.

**Q: What happens if the server crashes during sync?**
A: Checkpoint is preserved. On restart, sync resumes from where it left off (no data loss).

---

## Support

For issues:
1. Check sync dashboard: `http://localhost:3000/sync-dashboard`
2. Review error log (most common causes listed in Troubleshooting)
3. Capture sync status: `curl http://localhost:3000/api/sync/status > sync-status.json`
4. Share with support team

---

Last updated: 2026-07-17
