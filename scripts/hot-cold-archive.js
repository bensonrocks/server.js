#!/usr/bin/env node
'use strict';
// Move settled orders between the hot tenant db.json and the cold archive.
// The server holds db.json in memory and the next writeDb overwrites the
// file, so --run and --restore refuse unless --server-stopped is passed.
//
//   node scripts/hot-cold-archive.js --db /data/tenants/default/db.json
//   node scripts/hot-cold-archive.js --db ... --reference all_settled
//   HOT_COLD_ARCHIVE=on node scripts/hot-cold-archive.js --db ... --run --server-stopped --reference all_settled
//   node scripts/hot-cold-archive.js --db ... --restore --server-stopped
//
// --reference window|all_settled overrides HOT_COLD_ARCHIVE_REFERENCE for
// this process. Omitted, the env is used, and anything other than
// all_settled means the 28-day window (work batches always use the window).
//
// --data-dir overrides the volume root. Otherwise it is two directories
// above the tenant file: .../tenants/default/db.json → the directory that
// contains archive/ (Railway: /data).

const fs = require('fs');
const path = require('path');
const hotCold = require('../lib/hot-cold-archive');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) return '';
  return process.argv[i + 1];
}
function has(name) { return process.argv.includes(name); }

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const dbPath = arg('--db');
if (!dbPath) {
  die('Usage: node scripts/hot-cold-archive.js --db <tenant db.json> [--data-dir DIR] [--reference window|all_settled] [--dry-run | --run --server-stopped | --restore --server-stopped]');
}
const referenceExplicit = has('--reference') ? arg('--reference') : undefined;
if (has('--reference') && !referenceExplicit) {
  die('--reference needs window or all_settled.');
}
const absDb = path.resolve(dbPath);
const dataDir = arg('--data-dir')
  ? path.resolve(arg('--data-dir'))
  : path.resolve(path.dirname(absDb), '../..');
const env = process.env;
const mode = hotCold.modeFromEnv(env);

let db;
try { db = JSON.parse(fs.readFileSync(absDb, 'utf8')); }
catch (e) { die('Could not read ' + absDb + ': ' + e.message); }
if (!db || typeof db !== 'object' || !Array.isArray(db.batches)) die('That file has no batches array.');

function writeDbFile() {
  const tmp = absDb + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, absDb);
}
function planFromArgs() {
  const resolved = hotCold.resolveReferencePolicy(referenceExplicit, env);
  if (resolved.error) die(resolved.error);
  return hotCold.planArchive(db, {
    windowDays: hotCold.windowDaysFromEnv(env),
    referencePolicy: resolved.policy,
  });
}

if (has('--run') && has('--restore')) die('Pass either --run or --restore, not both.');

if (has('--run')) {
  if (!hotCold.movePermitted(mode)) {
    die('HOT_COLD_ARCHIVE is not "on" (it is "' + mode + '"). Nothing was moved.');
  }
  if (!has('--server-stopped')) {
    die('Refusing to write while a server may hold db.json in memory. Stop the server, then pass --server-stopped.');
  }
  const plan = planFromArgs();
  const result = hotCold.applyPlan(hotCold.coldDir(dataDir), db, plan);
  if (!result.noop) writeDbFile();
  console.log(JSON.stringify({
    ...result, cutoff: plan.cutoffIso, windowDays: plan.windowDays,
    referencePolicy: plan.referencePolicy, dataDir, cold: hotCold.coldDir(dataDir),
  }, null, 2));
  process.exit(0);
}

if (has('--restore')) {
  if (!has('--server-stopped')) {
    die('Refusing to write while a server may hold db.json in memory. Stop the server, then pass --server-stopped.');
  }
  const restored = hotCold.restoreAll(hotCold.coldDir(dataDir), db);
  if (restored.restored) writeDbFile();
  const onDisk = fs.readFileSync(absDb, 'utf8');
  if (restored.ids[0] && !onDisk.includes('"id":"' + restored.ids[0] + '"')) {
    die('Restored into memory but the hot file on disk does not show it. Cold archive was left in place.');
  }
  const retired = hotCold.retireCold(dataDir);
  console.log(JSON.stringify({ ...restored, retired, dataDir }, null, 2));
  process.exit(0);
}

const plan = planFromArgs();
console.log(JSON.stringify({
  ...hotCold.summarisePlan(plan, mode),
  dataDir,
  cold: hotCold.coldDir(dataDir),
  db: absDb,
}, null, 2));
