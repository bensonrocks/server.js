export interface AuditEntry {
    id: string;
    channel: string;
    operation: string;
    externalId: string | null;
    rawPayload: unknown;
    tenantId: string | null;
    fetchedAt: string;
}
export declare const auditLogService: {
    /** Persist a raw platform payload and return the generated audit row ID. */
    save(entry: Omit<AuditEntry, "id" | "fetchedAt">): string;
    findByChannel(channel: string, limit?: number): AuditEntry[];
    findByExternalId(externalId: string): AuditEntry[];
    findById(id: string): AuditEntry | null;
};
//# sourceMappingURL=audit-log.service.d.ts.map