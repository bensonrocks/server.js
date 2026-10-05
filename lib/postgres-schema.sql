-- IdealOne Phase 2 document store. NOT executed by the application.
--
-- Phase 1 (DB_BACKEND) only ships this file so the intended first Postgres
-- shape is in the repo. scripts/postgres-plan.js prints it and refuses
-- --apply. Do not run this against idealone.tech, and do not run it against
-- the existing Railway MySQL TMS sidecar (MYSQLHOST / initMysqlPool). That
-- database holds drivers, zones, routes, route_stops, geocoding_cache. It is
-- not the order or scan source of truth.
--
-- Why a document row, not a normalized orders table: orders live INSIDE
-- db.batches[].orders, and scan state lives on batch.orderStates[orderNumber].
-- Hundreds of readDb/writeDb call sites mutate that one object. The first
-- store that can replace the file is one JSONB document per tenant, with an
-- optimistic version. Splitting orders, scan state, and inventory into
-- relational tables is a later phase (see docs/POSTGRES_MIGRATION.md).
--
-- Applying this file, when a later phase allows it, must only create
-- missing objects. It must not remove tables or rows.

CREATE TABLE IF NOT EXISTS schema_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_meta (key, value)
VALUES ('phase', '2-document-store')
ON CONFLICT (key) DO NOTHING;

-- One row per tenant. doc is the whole tenant db.json object
-- (batches, inbound, transport, drivers, auditLog, waves, clientProfiles, ...).
-- version increments on each successful write. Two replicas must compare-and-swap
-- on version; a lost update is a refused write, not a silent overwrite.
CREATE TABLE IF NOT EXISTS tenant_documents (
  tenant_id  TEXT PRIMARY KEY,
  doc        JSONB NOT NULL,
  version    BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- users and sessions. Must be readable before a tenant is known (login).
-- Today this is DATA_DIR/global.json. Password hashes and API-key hashes
-- live here; the row is a secret store, not something to log.
CREATE TABLE IF NOT EXISTS global_documents (
  id         TEXT PRIMARY KEY,
  doc        JSONB NOT NULL,
  version    BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immediate append, the SQL stand-in for scan-journal.ndjson.
-- Replay still takes the higher count and does not reopen a completed wave.
-- A unique (tenant_id, target, event_id) belongs with the normalized scan
-- phase, when event ids move off the document. Phase 2 keeps the payload.
CREATE TABLE IF NOT EXISTS scan_journal (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_journal_tenant_at
  ON scan_journal (tenant_id, at);

-- Settled batches that have left the hot document.
-- Same rules as lib/hot-cold-archive.js: work batches only when every order
-- is done or unprocessed and the newest settlement is older than the window;
-- reference_only batches stay on the window unless a run asks all_settled.
-- Nothing moves at boot. HOT_COLD_ARCHIVE stays off until an operator runs it.
CREATE TABLE IF NOT EXISTS cold_batches (
  tenant_id  TEXT NOT NULL,
  batch_id   TEXT NOT NULL,
  month      TEXT NOT NULL,
  doc        JSONB NOT NULL,
  moved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id)
);

CREATE INDEX IF NOT EXISTS cold_batches_tenant_month
  ON cold_batches (tenant_id, month);
