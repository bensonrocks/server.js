'use strict';

const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { Client, types } = require('pg');
const { splitSql } = require('./sql-translate');

types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const HEADER = 16;
const sab = workerData.sab;
const i32 = new Int32Array(sab);
const u8 = new Uint8Array(sab);

let client = null;
let inTx = false;
let chain = Promise.resolve();

function reply(payload, isError, gen) {
  let body;
  try {
    body = Buffer.from(JSON.stringify(payload), 'utf8');
  } catch (e) {
    body = Buffer.from(JSON.stringify({ message: 'Could not serialise database result' }), 'utf8');
    isError = true;
  }
  if (body.length > sab.byteLength - HEADER) {
    body = Buffer.from(JSON.stringify({ message: 'Database result is too large' }), 'utf8');
    isError = true;
  }
  u8.set(body, HEADER);
  Atomics.store(i32, 1, body.length);
  Atomics.store(i32, 2, isError ? 1 : 0);
  Atomics.store(i32, 3, gen);
  Atomics.store(i32, 0, 1);
  Atomics.notify(i32, 0, 1);
}

async function connect() {
  if (client) return;
  const opts = { connectionString: workerData.connectionString };
  if (workerData.ssl === false) opts.ssl = false;
  else if (workerData.ssl) opts.ssl = workerData.ssl;
  client = new Client(opts);
  await client.connect();
}

async function migrate() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  const dir = workerData.migrationsDir;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const id = path.basename(file, '.sql');
    const seen = await client.query('SELECT id FROM schema_migrations WHERE id = $1', [id]);
    if (seen.rows.length) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const stmts = splitSql(sql);
    await client.query('BEGIN');
    try {
      for (const stmt of stmts) await client.query(stmt);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }
}

async function runStatement(sql, params) {
  if (inTx) await client.query('SAVEPOINT nt_stmt');
  try {
    const res = await client.query(sql, params || []);
    if (inTx) await client.query('RELEASE SAVEPOINT nt_stmt');
    return res;
  } catch (e) {
    if (inTx) {
      try { await client.query('ROLLBACK TO SAVEPOINT nt_stmt'); } catch (_) {}
    }
    throw e;
  }
}

async function handle(msg) {
  if (msg.op === 'init') {
    await connect();
    await migrate();
    return { ok: true };
  }
  if (!client) throw new Error('Database is not connected');
  if (msg.op === 'begin') {
    await client.query('BEGIN');
    inTx = true;
    return { ok: true };
  }
  if (msg.op === 'commit') {
    await client.query('COMMIT');
    inTx = false;
    return { ok: true };
  }
  if (msg.op === 'rollback') {
    await client.query('ROLLBACK');
    inTx = false;
    return { ok: true };
  }
  if (msg.op === 'exec') {
    for (const stmt of splitSql(msg.sql)) await runStatement(stmt, []);
    return { ok: true };
  }
  if (msg.op === 'query') {
    const res = await runStatement(msg.sql, msg.params);
    if (msg.mode === 'get') {
      if (!res.rows.length) return { __empty: true };
      return res.rows[0];
    }
    if (msg.mode === 'all') return res.rows;
    return { changes: res.rowCount || 0 };
  }
  throw new Error('Unknown database operation');
}

parentPort.on('message', (msg) => {
  chain = chain.then(() => handle(msg)).then(
    (result) => reply(result == null ? { ok: true } : result, false, msg.gen),
    (err) => reply({ message: err.message || 'Database error', code: err.code || '' }, true, msg.gen)
  );
});
