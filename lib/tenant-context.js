'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Tenant context — request-scoped "which tenant is this?" signal.
//
//  Shared between server.js and lib/inventory-store.js (and anything else that
//  needs to know the current tenant) so that storage functions like readDb(),
//  writeDb(), and the inventory module can stay ZERO-ARGUMENT and tenant-aware
//  at the same time — no call-site changes needed at any of their ~300 uses.
//
//  Set once per request (in server.js, right after auth resolves who the user
//  is) via tenantContext.run({tenantId}, next). Read anywhere downstream via
//  tenantContext.currentTenantId().
// ─────────────────────────────────────────────────────────────────────────────

const { AsyncLocalStorage } = require('async_hooks');

const DEFAULT_TENANT_ID = 'default';

const als = new AsyncLocalStorage();

function run(tenantId, fn) {
  return als.run({ tenantId: tenantId || DEFAULT_TENANT_ID }, fn);
}

// Falls back to DEFAULT_TENANT_ID outside a request (cron jobs, module init,
// etc.) so nothing ever silently writes to a null/undefined tenant.
function currentTenantId() {
  const store = als.getStore();
  return (store && store.tenantId) || DEFAULT_TENANT_ID;
}

module.exports = { run, currentTenantId, DEFAULT_TENANT_ID };
