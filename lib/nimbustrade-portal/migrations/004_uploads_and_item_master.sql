ALTER TABLE nt_orders ADD COLUMN IF NOT EXISTS detail_json TEXT;

CREATE TABLE IF NOT EXISTS nt_item_master (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  description TEXT NOT NULL,
  batch_details TEXT,
  serial_number TEXT,
  remark_1 TEXT,
  remark_2 TEXT,
  updated_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (client_id, sku)
);

CREATE TABLE IF NOT EXISTS nt_uploads (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'),
  decided_at TEXT,
  decided_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_nt_uploads_client ON nt_uploads (client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_nt_uploads_status ON nt_uploads (status, created_at);
CREATE INDEX IF NOT EXISTS idx_nt_item_master_client ON nt_item_master (client_id, sku);
