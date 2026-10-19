# Event-loop lag — root cause (19 Oct 2026) + prevention

Plain-language summary for Benson, from Performance IDEALONE (Railway
motivated-acceptance/server.js, 1 replica asia-southeast1, deploy aef9d0c9,
healthy, no restarts/OOM, CPU avg 0.18, memory 2.61 GB) and code verification
on live branch `claude/ecommerce-order-dashboard-cxMNo` @ 4e483ed (PR #100).

## What happened today
- 58 `[event-loop-lag]` entries 13:02–13:52 SGT. `GET /api/orders` 3.2–8.5 s in flight.
- 13:40–13:45 spikes: loop blocked 14.9–16.9 s on `/api/portal/orders`,
  `/api/portal/stock`, `/api/portal/overview`, `/api/portal/inbound`.
- Blocks also occurred with `inflight=0` — i.e. background jobs
  (label-auto-rematch / zort-auto-pull), not a request, held the loop.
- Timed from the box: `/api/ping` TTFB 0.76–1.02 s, `/api/orders?range=today`
  2.7–3.0 s / 2.95 MB / 945 orders, daily-summary XLSX 4.2–4.9 s for an 18 KB
  file, `/api/stats` 1.3–1.6 s.
- CPU/memory were healthy — this is NOT capacity, NOT OOM, NOT a restart.
  One Node process can only do one synchronous thing at a time; while it does
  a big synchronous job, every request (even `/api/ping`) waits.

## Causes — confirmed vs suspected (verified in code @4e483ed)
| Cause | Status | Evidence |
|---|---|---|
| Single Node process; any long sync stretch blocks all routes | CONFIRMED (architecture) | `server.js` is one process; `lib/loop-lag.js` logs exactly these blocks |
| `/api/orders` enriches the whole kept set per request (stock lookup, SLA, zort push/label state) | CONFIRMED | `globalOrdersWithState()` in server.js; per-order `_zortPushState/_zortLabelState` did `.find()` over stores/outbox per order (O(orders×outbox)); pre-range `keep` filter already existed, so cost grows with the *kept* set (945 orders today) |
| Portal list endpoints re-derive per order (transport job = filter over all transport jobs per order; stock verdict per order) | CONFIRMED | `/api/portal/orders` called `transportJobForOrder()` (full `db.transport` filter) for every row; overview/stock/inbound rescan client data per request, no cache |
| `/api/stats` loops all batches/orders on every call | CONFIRMED | Handler loops every batch/order/state; no cache. Sidebar polls it |
| Daily-summary XLSX scans audit history + `XLSX.write` on the request thread | CONFIRMED | `/api/master/report/:kind`: `readAuditLogForRange` + filters over the log (419k entries in the 18 Oct backup) then synchronous `XLSX.write` |
| Background jobs don't yield enough | CONFIRMED in part | Label sweep yielded only *between imports*; `rematchLabelImport` processed all pages of an import synchronously; `pullZortStore` processed all fetched orders synchronously; `buildLabelMatchIndex()` called full `globalOrdersWithState()` enrichment just to read 4 id fields |
| db.json whole-file rewrite per write | CONFIRMED as code path; live env value NOT verifiable from code | `lib/incremental-persist.js`: incremental persist is **default OFF** (`DB_INCREMENTAL_PERSIST` must be `on`). When off, `writeDb` debounces (250 ms/2 s; scans 1 s/6 s, #57) then does one synchronous `JSON.stringify(db)` of the WHOLE db. Local prod-size restore (below): `/api/version` reports `mode:"full", incrementalEnabled:false, stringifyMs:807` for a 168 MB db.json, and `[writeDb] serialising db.json (160.4 MB, mode full) held the thread for ~800 ms` repeated. If Railway has `DB_INCREMENTAL_PERSIST=on` set, this cause shrinks to periodic rebuilds — check Connections → Health Check (`db.incrementalEnabled`) on live to settle it. Do NOT assume it is on |
| Static `app.js` (1.27 MB) + HTML/CSS `no-cache` | CONFIRMED (contributor, not the 15 s cause) | `express.static` set `Cache-Control: no-cache` on html/js/css: every load re-downloaded/revalidated the full 1.27 MB on the same contended loop |
| Postgres/multi-replica would fix it | OUT OF SCOPE / not the proximate cause | The blocks are synchronous CPU stretches; a second replica is explicitly not in this fix |

## Why it recurs as orders grow
Every cost above is proportional to total history: orders enriched per list
request, audit entries scanned per report, transport/outbox arrays scanned
per order, and (if incremental persist is off) the whole 160 MB+ db stringified
per write burst. More orders → longer sync stretches → longer lag spikes.
Fixes must therefore be *sub-linear or cached*, not just faster loops.

## What this PR changes (perf/event-loop-lag-slim-cache)
Slim opt-in lists + pagination, indexed zort/transport lookups, raw-field
label index, 45 s TTL caches (stats/portal/daily-summary, stale-while-
revalidate for the XLSX), yielded background batches, ETag static assets,
`[perf-alert]` log guardrails. Scan/pack endpoints and shapes are unchanged;
default `/api/orders` and `/api/portal/orders` responses are byte-compatible
bare arrays (new behaviour is opt-in via `?slim=1` / `?page=` / `?limit=`).

## Prevention guardrails in this PR
- `[perf-alert]` structured logs (route, durationMs, bytes, status, p95) for
  `/api/orders`, `/api/stats`, `/api/portal/*`, daily-summary when a route
  exceeds 1.5 s (`PERF_ALERT_MS`) or its rolling p95 (120 samples) does;
  `[perf-alert] type=event-loop-lag` when lag > 2 s (`PERF_ALERT_LAG_MS`).
  Log-only: wiring this to the client poke/audit channel would write db.json
  during the very block being reported. Railway log alerts can match the
  literal `[perf-alert]` / `[event-loop-lag]`.
- Hard pagination cap (pageSize ≤ 500, in `lib/perf.js`, tested).
- Regression test: slim list must not contain heavy raw fields and must be
  < ½ the full payload (test/perf-cache-slim.test.js) — it fails if the list
  returns full enrichment again.

## Post-deploy monitoring plan (30 min)
Expected downtime: Railway rolling restart ~30–60 s (as prior deploys); no
data migration; rollback is redeploying 4e483ed / reverting this PR's merge
commit (see below).

| When (SGT, from deploy) | Check |
|---|---|
| +5 min | `/api/ping`, `/api/orders?range=today`, `/api/stats`, daily-summary, one portal login+orders — time each; Railway logs: count `[event-loop-lag]` and `[perf-alert]` since deploy |
| +15 min | Repeat probes; counts should not be climbing; check `[writeDb]` mode still as expected |
| +30 min | Repeat; compare lag count vs the 58-in-50-min pre-fix rate |

Rollback trigger: any single block > 10 s, any 5xx on orders/portal/stats, or
lag entries continuing at the pre-fix rate for 15 min → roll back.
Rollback procedure: Railway → Deployments → redeploy the previous (4e483ed)
deployment, or `git revert` this PR's merge commit and push to the live
branch. No migration to undo; caches are in-memory and die with the process.
Partial mitigation without redeploy: `PERF_CACHE_TTL_MS=0` (Railway env +
restart) makes cache entries instantly stale. Prefer full redeploy for rollback.

## Remaining / later (explicitly out of scope)
Turn on / verify `DB_INCREMENTAL_PERSIST=on` on Railway (env change + the
Health Check figure is the proof); Postgres or splitting audit log out of
db.json; moving XLSX generation to the existing PDF-worker-style worker
thread; server-driven pagination of the main Orders UI (it currently takes
the whole day list and filters client-side).
