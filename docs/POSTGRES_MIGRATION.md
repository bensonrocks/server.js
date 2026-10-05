# IdealOne — Postgres migration (Phase 1 scaffold)

**Status: draft. Not a cutover. Do not merge, deploy, or set `DB_BACKEND` on idealone.tech until Benson authorises the cutover plan.**

This document describes how the live app stores data today, the first Postgres shape that matches that model, and the phases required before more than one app replica can serve about ten concurrent users. Phase 1 (this change) adds the flag and this document. The running server still reads and writes tenant `db.json`.

## What is live today

IdealOne is one Node process. Hot operational state is a whole JSON document, rewritten on every `writeDb`. Inventory is a separate SQLite file. An optional MySQL pool is a TMS/geocode sidecar and is **not** the order store.

| Store | Path | What it holds |
|---|---|---|
| Global | `DATA_DIR/global.json` | `users`, `sessions`. Resolved before a tenant is known. |
| Tenant document | `DATA_DIR/tenants/<tenantId>/db.json` | Batches, inbound, transport, waves, audit log, and the rest of the old flat `db.json`. |
| Inventory | `DATA_DIR/tenants/<tenantId>/inventory.db` | SQLite (WAL). Stock, bins, movements, bundles, serials. |
| Scan journal | `DATA_DIR/scan-journal.ndjson` | Immediate append. Replayed at boot, then truncated. |
| Cold archive | `DATA_DIR/archive/cold/batches-YYYY-MM.json` | Settled batches. Flag `HOT_COLD_ARCHIVE` defaults **off**. |
| Files | volume dirs | Label PDFs, inbound photos, POD photos, waybill PDFs, nightly gzip backups. |

`DATA_DIR` is the `DATA_DIR` env var, else `RAILWAY_VOLUME_MOUNT_PATH`, else `./data`. A legacy flat `db.json` is migrated once into tenant `default` and renamed `.migrated-backup`. It is never deleted by that migration.

`readDb()` serves an in-memory cache (`_dbCacheByTenant`). `writeDb()` updates that cache and persists on a debounce (250 ms, max wait 2 s; scan-rate writes wait longer). `_persistDb` writes the **entire** `JSON.stringify` of the tenant document via tmp+rename. That stringify runs on the Node thread. A large account has already peaked around a 100 MB+ document every couple of seconds during a scan burst.

There are hundreds of `readDb()` / `writeDb()` call sites in `server.js`. They mutate one object. A second process on the same volume would race the rename and the SQLite file.

### Orders are not a table

An order is a nested object:

- `db.batches[]` is newest-first. A batch carries `id`, `filename`, `idealscan_code`, `uploaded_at`, `uploaded_by`, `client_name`, `order_count`, `row_count`, `orders`, `orderStates`, and often `contentHash`, `reference_only`, `onecart_store_id`, `inventory_tracked`, `inventory_client`.
- `batch.orders[]` lines come from `summarizeOrders`: `order_number`, `customer_name`, `tel`, `delivery_address`, `carrier`, `waybill_number`, `issue_no`, `pick_ticket`, `po_number`, `platform`, `shop_name`, `date`, `lines`, `total_qty`. Channel stamps (`zort_id`, `onecart_id`, …) are added after that.
- A line is `sku`, `description`, `qty`, `uom`, `location`, `batch_number`, `serial_number`, `expiry_date`, `remarks_betime`, plus optional `source_description`, `barcode`, `sku_source`, `from_bundle`.
- Scan progress is `batch.orderStates[orderNumber]`: `status` (`pending` / `processing` / `done` / `unprocessed`), `scanned`, `cartons`, `activeCartonNum`, `startTime`, `endTime`, `pickup`, `scanLog`, `scanEventIds` (last 100), `inventory_deducted`, `platform_cancelled`, `wave_id`, and related fields. There is no top-level `db.orders` and no top-level `db.orderStates`.

`order_number` is the stored identifier the duplicate tiers, scan lookup, and reports use. `issue_no` is where a GI number lands on the XLSX/CSV path when `Reference` wins `order_number`. A later schema must keep both. Do not collapse them.

### Clients are a string, plus a profile list

There is no clients table. The client on an order is `batch.client_name`. `canonicalClientName` / `invClientId` fold case onto the spelling already on file. `db.clientProfiles[]` holds onboarding data: `client`, `type`, `commodity`, portal users, `stock_tracking`, aging, visibility. A suffix does not fold (`BETIME` and `Betime Online` are different). Reference-only OneCart batches (`reference_only: true`) are a ledger, not floor work. This migration does not change that.

### Tenant document keys the code actually initialises

These are the arrays and objects `server.js` creates on the tenant document. A Postgres design that invents a different required set would be wrong.

`batches`, `inbound`, `transport`, `drivers`, `fixSchedules`, `geocodeCache`, `config`, `auditLog`, `noBarcodeSkus`, `jobCodeSeq`, `waveCodeSeq`, `inboundCodeSeq`, `stagingCodeSeq`, `stockSnapshots`, `rateCards`, `pokes`, `orderLabels`, `labelImports`, `outboundQueue`, `outboundLog`, `quarantine`, `stockImports`, `dismissedLedgerUploads`, `addressBook`, `transportTemplates`, `learnedSkuAliases`, `learnedBarcodes`, `stockDiscrepancies`, `apiKeys`, `outboundHooks`, `lazadaPushLog`, `shopeePushLog`, `zortPushLog`, `shopifyStores`, `onecartStores`, `bundleTemplateFiles`, `undoneLedgerPostings`, `waves`, `geofence`, `clientProfiles`, `backorders`, `pickupPolicy`, `fulfilmentPolicy`, `piiPolicy`, `piiDue`, `transportDepot`, `clientSubmissions`, `systemErrors`, `zortStores`, `zortOutbox`.

Personal data (name, address, phone) sits on orders inside `batches` and is purged in place after the retention window. A JSONB copy is the same data. Postgres logs and backups must not dump document bodies.

### Inventory (already relational — SQLite)

`lib/inventory-store.js` creates:

`inventory` (unique `client_id, sku`; later product-master columns: barcode, brand, model, carton/unit dimensions, flags, platform SKUs, `learned_from_orders`), `warehouse_locations` (later length/width/height, kind, tier, level, row, bay, `tier_locked`), `stock_by_location`, `stock_movements`, `suppliers`, `supplier_sku_mapping`, `cycle_counts`, `cycle_count_lines`, `stock_alerts`, `bundles` (`components` JSON text), `batch_tracking`, `bin_lots` (authoritative lot/bin; `stock_by_location` is derived), `serials` (unique `client_id, serial`; later `location_id`, `lot_number`).

`available_qty` is `max(0, stock_qty - reserved_qty)`. SQLite on the volume allows one writer. A second replica opening the same file is unsafe.

### Existing MySQL is a different database

`initMysqlPool()` uses `MYSQLHOST` / `MYSQLPORT` / `MYSQLUSER` / `MYSQLPASSWORD` / `MYSQL_DATABASE` (defaults point at a Railway **MySQL** proxy). Tables it creates: `drivers`, `zones`, `zone_assignments`, `routes`, `route_stops`, `geocoding_cache`. Login does not wait for it. Failure disables TMS features only. **Do not point `DATABASE_URL` at that host, and do not extend that pool for orders or scans.**

### What is process-local (blocks a second replica)

- `_dbCacheByTenant`, `_globalCache`, debounce timers.
- `activeSessions` (one device per staff user; portal and driver sessions too).
- Pull/outbox reentry guards (`_zortPulling` and the drain guard).
- The scan journal file and every PDF/photo directory on the volume.

Sticky sessions do not fix a shared file. Two replicas writing one volume will corrupt `db.json` and `inventory.db`.

### Offline scans and hot/cold — keep the behaviour

The offline queue is **client** `localStorage` (`is_offline_scans`), kinds `order` | `inbound` | `wave`. The client mints `eventId`. The server remembers the last 100 ids on the target and returns `{dedup:true}`. This PR does not change that client or those routes.

SQL equivalent, later: a `scan_journal` append plus a unique `(tenant_id, target, event_id)` so a replay still counts once across replicas.

Hot/cold (`lib/hot-cold-archive.js`): `HOT_COLD_ARCHIVE` is `off` | `read` | `on`. Unknown values stay off. Default window 28 days. Work batches move only when every order is `done` or `unprocessed`, each has a settlement time, and the newest is older than the window. Reference batches stay on the age window unless a run passes `reference=all_settled`. Nothing moves at boot. A run still requires `HOT_COLD_ARCHIVE=on`. SQL equivalent: `cold_batches` (see `lib/postgres-schema.sql`). This PR does not move batches and does not change the flag.

## Why one replica is the limit

Ten concurrent users on several replicas need three things the file store does not give:

1. A store that accepts writes from more than one process without a shared file.
2. Session and idempotency state that every replica can see.
3. Scan updates that do not stringify the whole tenant document on the request thread.

A single JSONB row with optimistic locking unblocks (1) for the document. It does **not** fix (3): two replicas would still read-modify-write a very large blob, and a scan burst would still serialize the whole account. Real headroom for ten packers is a later split of hot scan state (`orderStates`, scan journal, inventory) out of that blob.

## Recommended path: migrate, then cut over

**Do not start with dual-write.** Dual-writing the whole document from day one means every scan pays two stores, and a bug in the new store can still be mistaken for the source of truth.

1. **Scaffold (this PR).** Flag defaults to json. Postgres is recognised and ignored as a serving backend.
2. **Migrate, server stopped.** Export `global.json`, each tenant `db.json`, and `inventory.db` into Postgres. Dry-run by default. Apply only with an explicit flag, a backup, and the process stopped so the debounce and the scan journal are flushed. Not in this PR.
3. **Dual-read on a shadow process.** A process that is not serving traffic loads the same snapshot from Postgres and from json and logs diffs. idealone.tech still serves json.
4. **Short dual-write, then cutover.** Both stores, then serving flips. The flip is a **future code change** plus `DB_BACKEND_CUTOVER=approved`. This PR records the flag and does not honour it (`cutoverHonoured` is always false, `serving` is always `json`).
5. **Multi-replica.** Only after sessions, inventory, and the hot document are in Postgres. Label/photo/waybill files stay on exactly one volume, or move to object storage. That file move is out of scope here.

Keep the json files on the volume until a soak period after cutover. Do not delete them as part of enabling the flag.

## Phase 2 schema (shipped, not applied)

`lib/postgres-schema.sql` is the document store only:

- `tenant_documents (tenant_id, doc jsonb, version, updated_at)`
- `global_documents` — one row for users/sessions
- `scan_journal (tenant_id, kind, payload jsonb, at)`
- `cold_batches (tenant_id, batch_id, month, doc jsonb)`
- `schema_meta`

No `DROP`, `DELETE`, or `TRUNCATE`. The app does not execute this file. `scripts/postgres-plan.js` prints the plan and exits non-zero on `--apply`.

Normalized tables for orders, lines, and `order_states` belong in a later phase, mapped from the nested shape above. Inventory’s later home is the existing SQLite tables, translated, not a new invented catalogue. Phase 1 does not add the `pg` driver.

## Flag

| Env | Phase 1 behaviour |
|---|---|
| unset, empty, `json`, `file`, `db.json` | Serve json. Boot log stays quiet. |
| `postgres`, `postgresql` | Recognised. Still serve json. One boot line says so. |
| anything else (`mysql`, `true`, `1`, `pg`, …) | Ignored. Still serve json. One boot line says the value was not recognised. |
| `DB_BACKEND_CUTOVER=approved` | Recorded on `/api/version` as `cutoverAsked: true`, `cutoverHonoured: false`. Still serve json. |
| `DATABASE_URL` | Noted only as `databaseUrlSet: true/false`. The URL is never logged or returned. |

`/api/version` includes `dbBackend` from `lib/db-backend.js` `status()`. Callers that read `bootedAt` are unchanged. Default persist behaviour is unchanged.

## Railway Postgres (document only — do not provision)

When Benson authorises a **staging** database, not the live service:

1. Railway project → the **staging** environment → New → Database → PostgreSQL.
2. On the **staging** app service, add a reference to that plugin so Railway injects `DATABASE_URL`.
3. Leave `DB_BACKEND` unset on idealone.tech. Do not set `DB_BACKEND=postgres` on production. Do not deploy this branch to production.
4. One primary. App replicas are separate Node services sharing that primary later. They must not share the current volume: the volume stays attached to exactly one replica until cutover, because two writers corrupt `db.json` and SQLite.
5. After a future cutover the volume is still required for PDFs and photos until those move to object storage.
6. Pool size stays small (on the order of the ten users, not connections × replicas × every library). Phase 1 opens no pool.

Do not run these steps from this change. Do not call Railway from this change.

## Rollback

**Phase 1:** unset `DB_BACKEND`, or set it to `json`. There is no Postgres data to roll back. The hot path never left the file.

**After a later cutover:**

1. Stop every replica (the start command is `exec node server.js`, so SIGTERM flushes the debounce — do not change that).
2. Point serving back to json. The code that would honour cutover does not exist yet; when it does, unsetting `DB_BACKEND_CUTOVER` and `DB_BACKEND` must be sufficient to serve the files again.
3. The rollback source is the tenant `db.json` kept on the volume, or a document exported from `tenant_documents` back into that file, plus `inventory.db` restored from the pre-cutover gzip if the SQLite file was replaced.
4. Take a nightly gzip first (`POST /api/master/backups/run-now` or Administrator → Backups) and restore-drill it before any apply. Those backups are the file-back path.
5. Scan journal lines newer than the restored file still replay on the next json boot (higher count wins). A rollback drill has to include one scan and one offline replay.

Do not delete `db.json` to “finish” a migration.

## What a real cutover still needs

- Benson’s explicit approval to merge, deploy, and cut over. Until then idealone.tech stays on json.
- A backup taken and a restore drill, including personal-data fields and inventory row counts.
- A downtime window with the server **stopped** (debounce flushed, journal flushed, no packer mid-scan).
- A migrate script (not in this PR) that prints counts before writing: batches, orders, inventory rows, `bin_lots`, users. Dry-run default. Apply only with `--apply` and a stopped server.
- Proof on staging: two replicas, one scan increments once; the same `eventId` replayed from the offline queue does not double-count; a reference batch is still not scannable; hot/cold still moves nothing at boot.
- Rollback drill on staging: serve json again, data not older than the journal window.

## What this PR contains vs later

**In this PR**

- This document.
- `lib/db-backend.js`, `lib/postgres-schema.sql`, `scripts/postgres-plan.js`.
- `dbBackend` on `/api/version`, one boot notice when the flag is not the quiet default.
- Unit tests that the serving backend stays `json`.

**Not in this PR**

- No `pg` dependency, no connection, no DDL apply, no data copy.
- No change to `readDb` / `writeDb`, the scan journal, the offline queue, hot/cold defaults, Betime/Stellar/reference mode, `railway.json`, or the MySQL TMS pool.
- No Railway Postgres plugin, no env change on idealone.tech, no deploy.
