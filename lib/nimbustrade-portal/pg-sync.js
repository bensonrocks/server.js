'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const { translateSql } = require('./sql-translate');

const SAB_SIZE = 8 * 1024 * 1024;
const HEADER = 16;
const TIMEOUT_MS = 60000;

function sslFor(connectionString) {
  let mode = '';
  try {
    const u = new URL(String(connectionString).replace(/^postgres(?:ql)?:/i, 'http:'));
    mode = (u.searchParams.get('sslmode') || '').toLowerCase();
  } catch (_) {}
  if (mode === 'disable') return false;
  if (mode === 'require' || mode === 'verify-ca' || mode === 'verify-full' || process.env.PGSSL === '1') {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function open(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is empty');

  let sab = null;
  let i32 = null;
  let u8 = null;
  let worker = null;
  let dead = false;
  let generation = 0;

  function spawn() {
    if (worker) {
      try { worker.terminate(); } catch (_) {}
    }
    dead = false;
    sab = new SharedArrayBuffer(SAB_SIZE);
    i32 = new Int32Array(sab);
    u8 = new Uint8Array(sab);
    worker = new Worker(path.join(__dirname, 'pg-worker.js'), {
      workerData: {
        sab,
        connectionString,
        ssl: sslFor(connectionString),
        migrationsDir: path.join(__dirname, 'migrations'),
      },
    });
    worker.on('error', () => { dead = true; });
    worker.on('exit', () => { dead = true; });
    postAndWait('init');
  }

  function postAndWait(op, extra) {
    const gen = ++generation;
    Atomics.store(i32, 0, 0);
    Atomics.store(i32, 1, 0);
    Atomics.store(i32, 2, 0);
    Atomics.store(i32, 3, 0);
    worker.postMessage(Object.assign({ op, gen }, extra || {}));
    const waited = Atomics.wait(i32, 0, 0, TIMEOUT_MS);
    if (Atomics.load(i32, 0) !== 1) {
      dead = true;
      try { worker.terminate(); } catch (_) {}
      throw new Error(waited === 'timed-out' ? 'Database request timed out' : 'Database worker stopped');
    }
    if (Atomics.load(i32, 3) !== gen) {
      dead = true;
      try { worker.terminate(); } catch (_) {}
      throw new Error('Stale database reply');
    }
    const len = Atomics.load(i32, 1);
    const isError = Atomics.load(i32, 2) === 1;
    const json = Buffer.from(u8.subarray(HEADER, HEADER + len)).toString('utf8');
    let obj;
    try {
      obj = JSON.parse(json);
    } catch (_) {
      throw new Error('Bad database reply');
    }
    if (isError) {
      const err = new Error(obj.message || 'Database error');
      if (obj.code) err.code = obj.code;
      throw err;
    }
    return obj;
  }

  function call(op, extra) {
    if (!worker || dead) spawn();
    return postAndWait(op, extra);
  }

  function norm(params) {
    return params.map((p) => (p === undefined ? null : p));
  }

  spawn();

  return {
    prepare(sql) {
      const translated = translateSql(sql);
      return {
        get(...params) {
          const row = call('query', { sql: translated, params: norm(params), mode: 'get' });
          if (row && row.__empty) return undefined;
          return row;
        },
        all(...params) {
          return call('query', { sql: translated, params: norm(params), mode: 'all' });
        },
        run(...params) {
          const r = call('query', { sql: translated, params: norm(params), mode: 'run' });
          return { changes: r.changes || 0, lastInsertRowid: 0 };
        },
      };
    },
    exec(sql) {
      call('exec', { sql: translateSql(sql) });
    },
    transaction(fn) {
      return function runTx(...args) {
        call('begin');
        try {
          const result = fn(...args);
          call('commit');
          return result;
        } catch (e) {
          try { call('rollback'); } catch (_) {}
          throw e;
        }
      };
    },
  };
}

module.exports = { open, sslFor };
