import Database from 'better-sqlite3';
import path     from 'path';
import crypto   from 'crypto';
import fs       from 'fs';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH  = path.join(DATA_DIR, 'audit.db');

interface AuditRow {
  id:          string;
  channel:     string;
  operation:   string;
  external_id: string | null;
  raw_payload: string;
  tenant_id:   string | null;
  fetched_at:  string;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_audit (
        id          TEXT PRIMARY KEY,
        channel     TEXT NOT NULL,
        operation   TEXT NOT NULL,
        external_id TEXT,
        raw_payload TEXT NOT NULL,
        tenant_id   TEXT,
        fetched_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_channel  ON gateway_audit(channel);
      CREATE INDEX IF NOT EXISTS idx_audit_ext_id   ON gateway_audit(external_id);
      CREATE INDEX IF NOT EXISTS idx_audit_fetched  ON gateway_audit(fetched_at);
    `);
  }
  return _db;
}

export interface AuditEntry {
  id:         string;
  channel:    string;
  operation:  string;
  externalId: string | null;
  rawPayload: unknown;
  tenantId:   string | null;
  fetchedAt:  string;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id:         row.id,
    channel:    row.channel,
    operation:  row.operation,
    externalId: row.external_id,
    rawPayload: JSON.parse(row.raw_payload),
    tenantId:   row.tenant_id,
    fetchedAt:  row.fetched_at,
  };
}

export const auditLogService = {

  /** Persist a raw platform payload and return the generated audit row ID. */
  save(entry: Omit<AuditEntry, 'id' | 'fetchedAt'>): string {
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(`
        INSERT INTO gateway_audit
          (id, channel, operation, external_id, raw_payload, tenant_id, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        entry.channel,
        entry.operation,
        entry.externalId ?? null,
        JSON.stringify(entry.rawPayload),
        entry.tenantId  ?? null,
        now,
      );
    return id;
  },

  findByChannel(channel: string, limit = 100): AuditEntry[] {
    return (
      getDb()
        .prepare('SELECT * FROM gateway_audit WHERE channel = ? ORDER BY fetched_at DESC LIMIT ?')
        .all(channel, limit) as AuditRow[]
    ).map(toEntry);
  },

  findByExternalId(externalId: string): AuditEntry[] {
    return (
      getDb()
        .prepare('SELECT * FROM gateway_audit WHERE external_id = ? ORDER BY fetched_at DESC')
        .all(externalId) as AuditRow[]
    ).map(toEntry);
  },

  findById(id: string): AuditEntry | null {
    const row = getDb()
      .prepare('SELECT * FROM gateway_audit WHERE id = ?')
      .get(id) as AuditRow | undefined;
    return row ? toEntry(row) : null;
  },

};
