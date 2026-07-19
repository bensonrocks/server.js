// ─────────────────────────────────────────────────────────────────────────────
//  Gateway audit log — zero-dependency, pluggable.
//
//  Every adapter records the raw platform payload here before it is mapped to a
//  Standard Model, so you always have the untouched source for debugging and
//  compliance. This build keeps NO hard dependency (no SQLite / no disk) so the
//  package drops into any app and runs immediately:
//
//    • Default sink   → in-memory ring buffer (last N entries, queryable).
//    • Custom sink    → call auditLogService.setSink(mySink) to persist to your
//                       own DB / file / log pipeline (SQLite, Postgres, etc.).
//
//  The public surface (save / findByChannel / findByExternalId / findById) is
//  unchanged from the original SQLite implementation, so adapters need no edits.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id:         string;
  channel:    string;
  operation:  string;
  externalId: string | null;
  rawPayload: unknown;
  tenantId:   string | null;
  fetchedAt:  string;
}

/**
 * Implement this to persist audit entries wherever you like (SQLite, Postgres,
 * an object store, a logging service …). Register it with
 * `auditLogService.setSink(yourSink)` at startup. Any method you leave out
 * falls back to the built-in in-memory buffer.
 */
export interface AuditSink {
  save?(entry: AuditEntry): void;
  findByChannel?(channel: string, limit: number): AuditEntry[];
  findByExternalId?(externalId: string): AuditEntry[];
  findById?(id: string): AuditEntry | null;
}

// How many entries the default in-memory buffer keeps before evicting oldest.
const MAX_MEMORY_ENTRIES = 2000;

const _mem: AuditEntry[] = [];
let _sink: AuditSink | null = null;

/** Crypto-quality UUID when available, else a timestamp+random fallback. */
function uuid(): string {
  const g: any = globalThis as any;
  if (g.crypto && typeof g.crypto.randomUUID === 'function') return g.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const auditLogService = {

  /** Swap the storage backend. Pass `null` to return to the in-memory buffer. */
  setSink(sink: AuditSink | null): void {
    _sink = sink;
  },

  /** Persist a raw platform payload and return the generated audit entry ID. */
  save(entry: Omit<AuditEntry, 'id' | 'fetchedAt'>): string {
    const full: AuditEntry = {
      id:         uuid(),
      fetchedAt:  new Date().toISOString(),
      channel:    entry.channel,
      operation:  entry.operation,
      externalId: entry.externalId ?? null,
      rawPayload: entry.rawPayload,
      tenantId:   entry.tenantId ?? null,
    };
    if (_sink?.save) {
      _sink.save(full);
    } else {
      _mem.push(full);
      if (_mem.length > MAX_MEMORY_ENTRIES) _mem.shift();
    }
    return full.id;
  },

  findByChannel(channel: string, limit = 100): AuditEntry[] {
    if (_sink?.findByChannel) return _sink.findByChannel(channel, limit);
    return _mem
      .filter((e) => e.channel === channel)
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
      .slice(0, limit);
  },

  findByExternalId(externalId: string): AuditEntry[] {
    if (_sink?.findByExternalId) return _sink.findByExternalId(externalId);
    return _mem
      .filter((e) => e.externalId === externalId)
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  },

  findById(id: string): AuditEntry | null {
    if (_sink?.findById) return _sink.findById(id);
    return _mem.find((e) => e.id === id) ?? null;
  },

};
