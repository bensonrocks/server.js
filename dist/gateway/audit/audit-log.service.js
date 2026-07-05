"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLogService = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const DATA_DIR = path_1.default.join(process.cwd(), 'data');
const DB_PATH = path_1.default.join(DATA_DIR, 'audit.db');
let _db = null;
function getDb() {
    if (!_db) {
        fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
        _db = new better_sqlite3_1.default(DB_PATH);
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
function toEntry(row) {
    return {
        id: row.id,
        channel: row.channel,
        operation: row.operation,
        externalId: row.external_id,
        rawPayload: JSON.parse(row.raw_payload),
        tenantId: row.tenant_id,
        fetchedAt: row.fetched_at,
    };
}
exports.auditLogService = {
    /** Persist a raw platform payload and return the generated audit row ID. */
    save(entry) {
        const id = crypto_1.default.randomUUID();
        const now = new Date().toISOString();
        getDb()
            .prepare(`
        INSERT INTO gateway_audit
          (id, channel, operation, external_id, raw_payload, tenant_id, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
            .run(id, entry.channel, entry.operation, entry.externalId ?? null, JSON.stringify(entry.rawPayload), entry.tenantId ?? null, now);
        return id;
    },
    findByChannel(channel, limit = 100) {
        return getDb()
            .prepare('SELECT * FROM gateway_audit WHERE channel = ? ORDER BY fetched_at DESC LIMIT ?')
            .all(channel, limit).map(toEntry);
    },
    findByExternalId(externalId) {
        return getDb()
            .prepare('SELECT * FROM gateway_audit WHERE external_id = ? ORDER BY fetched_at DESC')
            .all(externalId).map(toEntry);
    },
    findById(id) {
        const row = getDb()
            .prepare('SELECT * FROM gateway_audit WHERE id = ?')
            .get(id);
        return row ? toEntry(row) : null;
    },
};
//# sourceMappingURL=audit-log.service.js.map