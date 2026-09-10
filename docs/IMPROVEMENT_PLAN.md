# IdealOne structural improvement plan — one item every Sunday

Owner of the schedule: the Sunday routine. Owner of the decisions: Benson.

## The rules every Sunday session follows

1. Work ONLY on the next unticked week below. One week per Sunday. Never two.
2. Branch `claude/ecommerce-order-dashboard-cxMNo`. Never another branch.
3. Nothing a user sees changes. Every item is a move, a test, or a measurement.
4. Before pushing: `npm test` green, the boot smoke test green, and every
   suite listed under the item green. **A red suite means no push** — tick
   nothing, write what failed in `docs/IMPROVEMENT_LOG.md`, stop.
5. One commit per week's item, message starting `Plan W<n>:`. Push with
   `git push -u origin claude/ecommerce-order-dashboard-cxMNo`. Never
   `--no-verify`.
6. After pushing: tick the item here, append a dated entry to
   `docs/IMPROVEMENT_LOG.md` (what moved, what was measured, what is next),
   commit and push that too.
7. If the item cannot be finished in one session, do NOT leave half-moved
   code on the branch. Revert to the last green state, log why, and the next
   Sunday retries the same item.
8. Nobody is watching the session. Never wait on a question. If a decision is
   genuinely Benson's, log the question and do the rest of the item.
9. Sunday is the one day nothing leaves the warehouse (`noCollectionDays`
   includes Sunday), which is why it is the deploy window. Push before
   18:00 SGT so a bad deploy has hours to show before Monday.
10. CodeQL on the PR carries a standing baseline (~180 alerts). Only a NEW
    alert on changed lines needs fixing.

Suites live in `test/` from Week 1 onward. `npm test` runs all of them.

---

## Phase 0 — make it safe to change

- [ ] **W1 · Tests into the repo.** Copy every `*-e2e.js`, `br-*.js` and
  their mocks/fixtures from the session scratchpad into `test/e2e/` and
  `test/browser/`, rewrite absolute paths to `path.join(__dirname, …)`,
  give each its own port and data dir, and add an `npm run test:e2e` and
  `npm run test:browser` script. Add both to `.github/workflows/test.yml`.
  Done when: CI runs them and is green.
- [ ] **W2 · Boot smoke test + size guard.** `test/smoke.test.js`: boot on a
  scratch dir, log in as demo, hit 25 core routes (orders, upload preview,
  scan increment/complete, inbound list, putaway queue, labels list,
  transport, reports list, portal login, driver login, health check,
  version), assert 2xx/expected. Add `scripts/size-guard.js` that fails CI
  when `server.js` has MORE lines than the committed baseline in
  `.size-baseline`. Done when: both run in CI.

## Phase 1 — split server.js by domain, behaviour unchanged

Pattern for every extraction: `routes/<domain>.js` exports
`module.exports = (ctx) => router` where `ctx` carries
`{readDb, writeDb, logAudit, inventory, requireAuth, checkMaster,
requireInboundAdmin, tenantContext, sgDateStr, …}` and pure helpers move to
`lib/<domain>.js`. server.js mounts routers in the SAME order the routes
were registered. Literal paths before `:id` paths inside each router.
Each week: extract, smoke + domain suites green, commit, push, update
`.size-baseline` downward.

- [ ] **W3 · Transport, address book, delivery history** → `routes/transport.js`.
  Suites: smoke, any transport e2e.
- [ ] **W4 · Drivers and the driver app** → `routes/drivers.js`, `routes/driver-app.js`.
- [ ] **W5 · Reports and dashboards** (`/api/master/report/:kind`,
  `/api/master/dashboard/*`) → `routes/reports.js`.
- [ ] **W6 · Client portal** → `routes/portal.js` (+ `lib/portal.js` for
  `portalPickup`, `PORTAL_STATUS_LABEL`, visibility, sheet builders).
  Suites: every portal e2e + browser suite.
- [ ] **W7 · Inbound, staging, putaway** → `routes/inbound.js`, `routes/putaway.js`.
- [ ] **W8 · Labels** (imports, match index, rematch, PNG route, bulk print)
  → `routes/labels.js` + `lib/label-match.js`. Suites: label-parcels,
  label-ref, bulk-print, br-preview, perf-ocr.
- [ ] **W9 · ZORT part 1** (stores, pull, attribution, refile, find/cross-check)
  → `routes/zort.js` + `lib/zort-sync.js`.
- [ ] **W10 · ZORT part 2** (outbox drain, labels, browser worker glue,
  webhook receiver, health check) → `lib/zort-outbox.js`. Suites: lag-e2e,
  web-note-e2e, perf-e2e.
- [ ] **W11 · Shopify, OneCart, Lazada/Shopee direct, partner API + webhooks**
  → `routes/shopify.js`, `routes/onecart.js`, `routes/marketplace.js`,
  `routes/integration.js`.
- [ ] **W12 · Orders, scanning, waves, upload** → `routes/orders.js`,
  `routes/scan.js`, `routes/waves.js`, `routes/upload.js`. server.js is
  now wiring, boot, persistence and middleware only. Target: under 3,000
  lines. Update `.size-baseline`.

## Phase 2 — one identity layer

- [ ] **W13 · `lib/auth.js`.** One `resolveIdentity(req)` returning
  `{kind: 'staff'|'portal'|'driver'|'apikey'|'master', tenant, user, scopes}`
  built from the four existing schemes. `requireAuth`, `requireAuthOrToken`,
  `requirePortalAuthMiddleware`, `requireDriverAuthMiddleware`,
  `verifyApiKey` become thin wrappers over it. Add `test/auth.test.js`:
  every namespace refused on every other namespace's routes (the two holes
  found in 2026, as permanent tests).
- [ ] **W14 · Remove the wrappers' own logic.** Every gate calls
  `resolveIdentity` only. Delete the duplicated namespace-skip code.
  Suites: all portal, driver, integration and fence suites.

## Phase 3 — orders out of db.json

- [ ] **W15 · Two doors only.** Audit every `readDb().batches` and
  `orderStates` access in the codebase; route each through
  `findBatchForOrder`, `globalOrdersWithState`, or a new
  `lib/orders-repo.js` (`listBatches`, `getBatch`, `saveBatch`,
  `getOrderState`, `saveOrderState`, `removeOrder`). Count remaining
  direct accesses; log the number. Done when: zero outside the repo file.
- [ ] **W16 · SQLite schema.** Tables `batches`, `orders`, `order_lines`,
  `order_states` in the existing inventory SQLite file (better-sqlite3),
  with a migration that copies db.json batches in. Repo file gains a
  SQLite backend behind a flag `ORDERS_STORE=json|sqlite` (default json).
- [ ] **W17 · Dual write.** With the flag `json`, every write ALSO writes
  SQLite. A background comparer every 5 min diffs the two and files a
  System Outage row on any difference. Deploy. Watch for a week.
- [ ] **W18 · Read from SQLite** (`ORDERS_STORE=sqlite`) with dual write
  still on. Measure `/api/orders` p50/p95 before and after on the same
  seeded data; log both.
- [ ] **W19 · Verify.** Comparer silent for seven days on live data (check
  System Outages). If not silent: fix, keep flag on json, retry next week.
- [ ] **W20 · Cut over.** JSON backend removed from the orders repo; batches
  leave db.json; db.json write cost measured on the Health Check and
  logged before/after. Archive job rewritten to move SQLite rows to the
  monthly archive files.
- [ ] **W21 · Buffer week.** Anything Phase 3 left behind. If nothing,
  start Phase 4 early.

## Phase 4 — background work out of the request process

- [ ] **W22 · `jobs/` registry.** Every `setInterval`/`setTimeout` schedule
  in server.js moves to `jobs/index.js` as `{name, everyMs, run, lastRun,
  lastMs, lastError}`; the Health Check lists them. No new interval outside
  `jobs/`.
- [ ] **W23 · Worker service.** `worker.js` entry point that runs ONLY the
  PDF/OCR pool, the ZORT label browser worker and the outbox label drain,
  taking work from a `jobs` table in SQLite. Same repo, second Railway
  service (`railway.worker.json`). Behind `WORKER_MODE=inline|service`
  (default inline).
- [ ] **W24 · Cut over** to `service` on Railway, confirm on Metrics that the
  web service's memory sawtooth is gone and p99 is flat; log the numbers.

## Phase 5 — the notes

- [ ] **W25 · Split CLAUDE.md** into `docs/<domain>.md` next to each router,
  plus `docs/DECISIONS.md` holding only the rules marked "do not relitigate".
  CLAUDE.md becomes a 200-line index. Nothing deleted, only moved.
- [ ] **W26 · Re-grade.** Run every suite, measure the four numbers this plan
  set out to move (db write ms, p99, server.js lines, tests in CI), write
  the before/after table into `docs/IMPROVEMENT_LOG.md`, and list what is
  still worth doing.
