#!/usr/bin/env node
'use strict';

// Prints the Phase 1 plan. Does not connect, does not apply DDL, does not
// read or write db.json. --apply exits non-zero: apply is a later phase,
// and only with the server stopped and Benson's cutover approval.

const dbBackend = require('../lib/db-backend');

const apply = process.argv.includes('--apply');

const s = dbBackend.status();
console.log('IdealOne Postgres plan — phase ' + s.phase);
console.log('requested=' + s.requested);
console.log('serving=' + s.serving);
console.log('recognised=' + s.recognised);
console.log('cutoverAsked=' + s.cutoverAsked);
console.log('cutoverHonoured=' + s.cutoverHonoured);
console.log('databaseUrlSet=' + s.databaseUrlSet);
console.log(s.note);
console.log('');
console.log('Hot path today: DATA_DIR/tenants/<tenantId>/db.json (atomic tmp+rename).');
console.log('Inventory today: DATA_DIR/tenants/<tenantId>/inventory.db (SQLite, one writer).');
console.log('Sessions today: in-memory activeSessions, plus global.json.');
console.log('This script does not open Postgres and does not change either store.');
console.log('');
console.log('--- lib/postgres-schema.sql (not applied) ---');
console.log(dbBackend.schemaSql());

if (apply) {
  console.error('');
  console.error('refusing --apply: phase 1 does not migrate data or run DDL.');
  console.error('A real apply needs: server stopped, backup taken, Benson cutover approval, and a later migrate script.');
  process.exit(1);
}
