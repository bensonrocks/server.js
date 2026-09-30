CREATE TABLE IF NOT EXISTS nt_clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS nt_users (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES nt_clients(id),
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS nt_sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  username   TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nt_locations (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES nt_clients(id),
  country      TEXT NOT NULL,
  country_name TEXT NOT NULL,
  city         TEXT NOT NULL,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS nt_inventory (
  id                   TEXT PRIMARY KEY,
  location_id          TEXT NOT NULL REFERENCES nt_locations(id),
  sku                  TEXT NOT NULL,
  product_name         TEXT NOT NULL,
  qty_on_hand          INTEGER NOT NULL DEFAULT 0,
  replenish_threshold  INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS nt_orders (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES nt_clients(id),
  order_ref      TEXT NOT NULL,
  country        TEXT NOT NULL,
  country_name   TEXT NOT NULL,
  customer_name  TEXT NOT NULL,
  sku            TEXT NOT NULL,
  product_name   TEXT NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'dropped',
  issue_note     TEXT NOT NULL DEFAULT '',
  vendor_id      TEXT NOT NULL DEFAULT '',
  carrier        TEXT NOT NULL DEFAULT '',
  waybill_number TEXT NOT NULL DEFAULT '',
  due_date       TEXT NOT NULL DEFAULT '',
  order_date     TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'),
  created_at     TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS nt_order_events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES nt_orders(id),
  status     TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS nt_inbound_shipments (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES nt_clients(id),
  location_id    TEXT NOT NULL REFERENCES nt_locations(id),
  reference      TEXT NOT NULL,
  origin         TEXT NOT NULL DEFAULT 'Singapore',
  mode           TEXT NOT NULL DEFAULT 'air',
  carrier        TEXT NOT NULL DEFAULT '',
  waybill_number TEXT NOT NULL DEFAULT '',
  contents       TEXT NOT NULL DEFAULT '',
  expected_qty   INTEGER NOT NULL DEFAULT 0,
  received_qty   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'in_transit',
  expected_date  TEXT NOT NULL,
  arrived_date   TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'),
  created_at     TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS nt_rates (
  id             TEXT PRIMARY KEY,
  location_id    TEXT NOT NULL UNIQUE REFERENCES nt_locations(id),
  currency       TEXT NOT NULL DEFAULT 'USD',
  base_fee       DOUBLE PRECISION NOT NULL DEFAULT 0,
  per_unit_fee   DOUBLE PRECISION NOT NULL DEFAULT 0,
  storage_fee    DOUBLE PRECISION NOT NULL DEFAULT 0,
  notes          TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS nt_rate_cards (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL UNIQUE REFERENCES nt_clients(id),
  currency       TEXT NOT NULL DEFAULT 'USD',
  data_json      TEXT NOT NULL,
  prepared_by    TEXT NOT NULL DEFAULT '',
  prepared_title TEXT NOT NULL DEFAULT '',
  issued_date    TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'),
  created_at     TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS nt_vendors (
  id            TEXT PRIMARY KEY,
  country       TEXT NOT NULL,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS nt_vendor_sessions (
  token      TEXT PRIMARY KEY,
  vendor_id  TEXT NOT NULL,
  username   TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nt_staff_users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS nt_staff_sessions (
  token      TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL,
  username   TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nt_orders_client ON nt_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_nt_orders_country ON nt_orders(client_id, country);
CREATE INDEX IF NOT EXISTS idx_nt_orders_status ON nt_orders(client_id, status);
CREATE INDEX IF NOT EXISTS idx_nt_orders_vendor ON nt_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_nt_orders_date ON nt_orders(client_id, order_date);
CREATE INDEX IF NOT EXISTS idx_nt_orders_due ON nt_orders(client_id, due_date);
CREATE INDEX IF NOT EXISTS idx_nt_inventory_location ON nt_inventory(location_id);
CREATE INDEX IF NOT EXISTS idx_nt_order_events_order ON nt_order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_nt_inbound_client ON nt_inbound_shipments(client_id);
CREATE INDEX IF NOT EXISTS idx_nt_inbound_location ON nt_inbound_shipments(location_id);
