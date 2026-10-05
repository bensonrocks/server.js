// Phase 1 DB_BACKEND selector. No server, no network, no driver.
// Default and every non-json flag must keep serving = json.
const test = require('node:test');
const assert = require('node:assert/strict');
const dbBackend = require('../lib/db-backend');

const SECRET = 'postgres://user:super-secret-password@db.internal:5432/ideal';

function env(extra) {
  return Object.assign({
    DB_BACKEND: '',
    DB_BACKEND_CUTOVER: '',
    DATABASE_URL: '',
  }, extra);
}

test('unset and json aliases serve json and stay silent in status', () => {
  for (const raw of ['', 'json', 'JSON', ' file ', 'db.json']) {
    const s = dbBackend.status(env({ DB_BACKEND: raw }));
    assert.equal(s.requested, 'json');
    assert.equal(s.serving, 'json');
    assert.equal(s.recognised, true);
    assert.equal(s.phase, 1);
    assert.equal(s.cutoverHonoured, false);
    assert.equal(s.cutoverAsked, false);
  }
});

test('postgres is recognised and still serves json', () => {
  for (const raw of ['postgres', 'PostgreSQL', ' postgresql ']) {
    const s = dbBackend.status(env({
      DB_BACKEND: raw,
      DATABASE_URL: SECRET,
    }));
    assert.equal(s.requested, 'postgres');
    assert.equal(s.recognised, true);
    assert.equal(s.serving, 'json');
    assert.equal(s.cutoverHonoured, false);
    assert.equal(s.databaseUrlSet, true);
    assert.equal(JSON.stringify(s).includes(SECRET), false);
    assert.equal(JSON.stringify(s).includes('super-secret-password'), false);
    assert.match(s.note, /still serves tenant db\.json/);
  }
});

test('unknown aliases stay on json', () => {
  for (const raw of ['mysql', 'true', '1', 'pg', 'on']) {
    const s = dbBackend.status(env({ DB_BACKEND: raw }));
    assert.equal(s.requested, 'json');
    assert.equal(s.recognised, false);
    assert.equal(s.serving, 'json');
    assert.equal(s.cutoverHonoured, false);
    assert.match(s.note, /not recognised/);
  }
});

test('cutover flag is recorded and not honoured', () => {
  const s = dbBackend.status(env({
    DB_BACKEND: 'postgres',
    DB_BACKEND_CUTOVER: 'approved',
  }));
  assert.equal(s.cutoverAsked, true);
  assert.equal(s.cutoverHonoured, false);
  assert.equal(s.serving, 'json');

  const onlyFlag = dbBackend.status(env({ DB_BACKEND_CUTOVER: 'APPROVED' }));
  assert.equal(onlyFlag.requested, 'json');
  assert.equal(onlyFlag.cutoverAsked, true);
  assert.equal(onlyFlag.cutoverHonoured, false);
  assert.equal(onlyFlag.serving, 'json');
});

test('boot notice logs only when the flag is not a quiet default', () => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    dbBackend.resetBootNoticeForTests();
    dbBackend.bootNotice(env({}));
    assert.equal(lines.length, 0);

    dbBackend.resetBootNoticeForTests();
    dbBackend.bootNotice(env({ DB_BACKEND: 'postgres', DATABASE_URL: SECRET }));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /serving=json/);
    assert.match(lines[0], /cutoverHonoured=false/);
    assert.equal(lines[0].includes(SECRET), false);

    dbBackend.resetBootNoticeForTests();
    lines.length = 0;
    dbBackend.bootNotice(env({ DB_BACKEND: 'mysql' }));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not recognised/);

    dbBackend.resetBootNoticeForTests();
    lines.length = 0;
    dbBackend.bootNotice(env({ DB_BACKEND_CUTOVER: 'approved' }));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /does not honour/);
  } finally {
    console.log = orig;
    dbBackend.resetBootNoticeForTests();
  }
});

test('schema SQL is a document store and has no destructive statements', () => {
  const sql = dbBackend.schemaSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tenant_documents/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS global_documents/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS scan_journal/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cold_batches/);
  assert.equal(/\bDROP\b/i.test(sql), false);
  assert.equal(/\bDELETE\b/i.test(sql), false);
  assert.equal(/\bTRUNCATE\b/i.test(sql), false);
  assert.match(sql, /NOT executed by the application/);
  assert.match(sql, /MySQL TMS/);
});

test('postgres-plan --apply refuses without connecting', async () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'postgres-plan.js'), '--apply'], {
    env: Object.assign({}, process.env, {
      DB_BACKEND: 'postgres',
      DATABASE_URL: SECRET,
      DB_BACKEND_CUTOVER: 'approved',
    }),
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing --apply/);
  assert.match(r.stdout, /serving=json/);
  assert.match(r.stdout, /tenant_documents/);
  assert.equal(r.stdout.includes(SECRET), false);
  assert.equal(r.stderr.includes(SECRET), false);
});
