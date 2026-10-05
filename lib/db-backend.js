'use strict';

// Phase 1 backend selector.
//
// The hot operational path ALWAYS stays the tenant db.json file. Setting
// DB_BACKEND=postgres is recognised and reported on /api/version and in the
// boot log. It does not open a socket, load a database driver, or change
// readDb/writeDb. A later phase is what would honour a cutover; this module
// refuses to, including when DB_BACKEND_CUTOVER=approved is set.
//
// Unknown values stay on json. Same discipline as HOT_COLD_ARCHIVE: an
// unrecognised flag must not flip the live store.
//
// This is not the optional MySQL TMS sidecar (MYSQLHOST / initMysqlPool).
// That pool is a different database and is not an order or scan source of
// truth.

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'postgres-schema.sql');

function classify(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (!token || token === 'json' || token === 'file' || token === 'db.json') {
    return { requested: 'json', recognised: true };
  }
  if (token === 'postgres' || token === 'postgresql') {
    return { requested: 'postgres', recognised: true };
  }
  return { requested: 'json', recognised: false };
}

function status(env) {
  const source = env || process.env;
  const raw = String(source.DB_BACKEND == null ? '' : source.DB_BACKEND).trim();
  const cls = classify(raw);
  const cutoverAsked = String(source.DB_BACKEND_CUTOVER || '').trim().toLowerCase() === 'approved';
  const databaseUrlSet = Boolean(String(source.DATABASE_URL || '').trim());
  let note;
  if (!cls.recognised) {
    note = 'DB_BACKEND value is not recognised. Serving tenant db.json. Accepted: json (default), postgres (phase 1: recognised only, still serves json).';
  } else if (cls.requested === 'postgres') {
    note = 'DB_BACKEND=postgres is recognised. Phase 1 still serves tenant db.json. Cutover is not implemented.';
  } else if (cutoverAsked) {
    note = 'DB_BACKEND_CUTOVER=approved was set, but phase 1 does not honour it. Serving tenant db.json.';
  } else {
    note = 'Serving tenant db.json (default).';
  }
  return {
    requested: cls.requested,
    recognised: cls.recognised,
    raw,
    serving: 'json',
    phase: 1,
    cutoverHonoured: false,
    cutoverAsked,
    databaseUrlSet,
    note,
  };
}

let _noticed = false;

function bootNotice(env) {
  const s = status(env);
  if (_noticed) return s;
  _noticed = true;
  // Default json with no cutover request stays silent. A postgres request,
  // an unrecognised token, or a cutover flag is logged once so an operator
  // can see the hot path did not move.
  if (s.requested === 'json' && s.recognised && !s.cutoverAsked) return s;
  console.log(
    '[db-backend] ' + s.note
    + ' serving=' + s.serving
    + ' phase=' + s.phase
    + ' cutoverHonoured=' + s.cutoverHonoured
  );
  return s;
}

function schemaSql() {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

function resetBootNoticeForTests() {
  _noticed = false;
}

module.exports = {
  status,
  bootNotice,
  schemaSql,
  classify,
  resetBootNoticeForTests,
};
