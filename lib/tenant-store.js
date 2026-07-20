'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Tenant registry + per-tenant path resolution + one-time migration.
//
//  Model: TWO kinds of data.
//    GLOBAL   — users, sessions. Must be resolvable BEFORE we know which
//               tenant a request belongs to (login itself has no tenant yet),
//               so these stay in one shared file: DATA_DIR/global.json.
//    TENANT   — everything else that used to live in db.json (batches,
//               inbound, transport, drivers, fixSchedules, auditLog, ...) plus
//               inventory.db. Each tenant gets its own directory:
//               DATA_DIR/tenants/<tenantId>/
//
//  Migration: the very first time this runs against a pre-existing
//  single-tenant DATA_DIR (old flat db.json), everything is moved into a
//  tenant called "default" — zero manual steps, nothing lost (the original
//  file is renamed to a .migrated-backup, never deleted).
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const DEFAULT_TENANT_ID = 'default';

function init(dataDir) {
  const DATA_DIR      = dataDir;
  const TENANTS_FILE  = path.join(DATA_DIR, 'tenants.json');
  const TENANTS_DIR   = path.join(DATA_DIR, 'tenants');
  const LEGACY_DB     = path.join(DATA_DIR, 'db.json');
  const LEGACY_INV    = path.join(DATA_DIR, 'inventory.db');

  function tenantDir(tenantId) {
    const dir = path.join(TENANTS_DIR, String(tenantId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  function tenantDbFile(tenantId)   { return path.join(tenantDir(tenantId), 'db.json'); }
  function tenantInventoryFile(tenantId) { return path.join(tenantDir(tenantId), 'inventory.db'); }

  function readTenants() {
    try { return JSON.parse(fs.readFileSync(TENANTS_FILE, 'utf8')); }
    catch { return []; }
  }
  function writeTenants(list) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TENANTS_FILE, JSON.stringify(list, null, 2));
  }
  function listTenants() { return readTenants(); }
  function getTenant(id) { return readTenants().find(t => t.id === id) || null; }
  function tenantExists(id) { return !!getTenant(id); }
  function createTenant({ id, name }) {
    const cleanId = String(id || '').trim();
    if (!cleanId) throw new Error('Tenant id is required');
    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(cleanId)) {
      throw new Error('Tenant id may only contain letters, numbers, hyphens and underscores');
    }
    const tenants = readTenants();
    if (tenants.some(t => t.id === cleanId)) throw new Error(`Tenant "${cleanId}" already exists`);
    const tenant = { id: cleanId, name: String(name || cleanId).trim(), createdAt: new Date().toISOString() };
    tenants.push(tenant);
    writeTenants(tenants);
    tenantDir(cleanId); // ensure its data directory exists so first read never 404s
    return tenant;
  }

  // ── One-time migration: old flat single-tenant layout -> tenant "default" ──
  function migrateLegacyIfNeeded() {
    if (readTenants().length > 0) return; // already migrated (or already multi-tenant)
    if (!fs.existsSync(LEGACY_DB)) {
      // Fresh install, nothing to migrate — just register the default tenant
      // so callers always have at least one tenant to resolve to.
      writeTenants([{ id: DEFAULT_TENANT_ID, name: 'Default', createdAt: new Date().toISOString() }]);
      tenantDir(DEFAULT_TENANT_ID);
      return;
    }

    console.log('[tenant] migrating existing single-tenant data into tenant "default"...');
    let legacy;
    try { legacy = JSON.parse(fs.readFileSync(LEGACY_DB, 'utf8')); }
    catch (e) { console.error('[tenant] could not parse legacy db.json — aborting migration:', e.message); return; }

    const { users, sessions, ...tenantData } = legacy;

    // GLOBAL — users + sessions
    const GLOBAL_FILE = path.join(DATA_DIR, 'global.json');
    if (!fs.existsSync(GLOBAL_FILE)) {
      const usersWithTenant = (users || []).map(u => ({ ...u, tenant_id: u.tenant_id || DEFAULT_TENANT_ID }));
      fs.writeFileSync(GLOBAL_FILE, JSON.stringify({ users: usersWithTenant, sessions: sessions || {} }, null, 2));
    }

    // TENANT — everything else
    tenantDir(DEFAULT_TENANT_ID);
    fs.writeFileSync(tenantDbFile(DEFAULT_TENANT_ID), JSON.stringify(tenantData, null, 2));

    // Inventory SQLite files (main + WAL/SHM sidecars)
    for (const ext of ['', '-wal', '-shm']) {
      const src = LEGACY_INV + ext;
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, tenantInventoryFile(DEFAULT_TENANT_ID) + ext); } catch (e) { console.warn('[tenant] inventory migrate warning:', e.message); }
      }
    }

    // Register the tenant, then move the legacy file aside — NEVER delete —
    // so a bug here can always be recovered from by hand.
    writeTenants([{ id: DEFAULT_TENANT_ID, name: 'Default', createdAt: new Date().toISOString() }]);
    try { fs.renameSync(LEGACY_DB, LEGACY_DB + '.migrated-backup'); } catch (e) { console.warn('[tenant] could not rename legacy db.json:', e.message); }
    console.log('[tenant] migration complete — tenant "default" ready.');
  }

  return {
    DEFAULT_TENANT_ID,
    listTenants, getTenant, tenantExists, createTenant,
    tenantDir, tenantDbFile, tenantInventoryFile,
    migrateLegacyIfNeeded,
    globalFile: () => path.join(DATA_DIR, 'global.json'),
  };
}

module.exports = { init, DEFAULT_TENANT_ID };
