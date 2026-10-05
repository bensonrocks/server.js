// Incremental hot-db persist. Default OFF (DB_INCREMENTAL_PERSIST).
//
// writeDb's cost is JSON.stringify of the whole in-memory tenant db on the
// request thread. A scan only changes one order's state inside one batch, but
// that state lives on db.batches[].orderStates, so a top-level dirty flag
// still rewrites every order line.
//
// With the flag on, readDb hands back a deep proxy that records which path
// changed. Persist keeps a Buffer of each batch's orders JSON, each order
// state, and each other top-level key, and the file write streams those
// buffers. A scan stringifies one state object (and an audit-log append, if
// the scan wrote one). The file on disk stays ordinary db.json — turning the
// flag off is the rollback, with no migration.
//
// Cold archive shards are not in the hot object, and this module never reads
// them. The first persist after boot (and a safety rebuild every
// DB_INCREMENTAL_REBUILD_MS, default 10 min) still stringifies everything
// once. Anything this module cannot assemble falls back to a full stringify
// in server.js.

'use strict';

const RAW = Symbol('incrementalRaw');

function enabled() {
  const v = String(process.env.DB_INCREMENTAL_PERSIST || '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

function rebuildMs() {
  if (process.env.DB_INCREMENTAL_REBUILD_MS === undefined || process.env.DB_INCREMENTAL_REBUILD_MS === '') return 600000;
  const n = parseInt(process.env.DB_INCREMENTAL_REBUILD_MS, 10);
  return Number.isFinite(n) ? n : 600000;
}

function freshDirty() {
  return { keys: new Set(), auditFull: false, auditReplaced: false, auditAppend: false };
}

function freshState() {
  return {
    raw: null,
    primed: false,
    lastFullAt: 0,
    frags: new WeakMap(),
    keys: new Map(),
    audit: null,
    dirty: freshDirty(),
  };
}

const tenants = new Map();

function stateFor(tenantId) {
  let st = tenants.get(tenantId);
  if (!st) { st = freshState(); tenants.set(tenantId, st); }
  return st;
}

function isIndex(prop) {
  if (typeof prop === 'symbol') return false;
  const s = String(prop);
  if (!/^(0|[1-9]\d*)$/.test(s)) return false;
  return Number.isSafeInteger(Number(s));
}

function unwrap(v) {
  if (!v || typeof v !== 'object') return v;
  if (v instanceof Date || Buffer.isBuffer(v) || v instanceof RegExp) return v;
  const raw = v[RAW];
  if (raw && typeof raw === 'object' && raw !== v) return raw;
  return v;
}

const wrapCache = new WeakMap();

function isWrapable(v) {
  return !!v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) && !(v instanceof RegExp);
}

function wrap(value, path, st) {
  if (!isWrapable(value)) return value;
  value = unwrap(value);
  const hit = wrapCache.get(value);
  if (hit) return hit;
  const proxy = new Proxy(value, handler(value, path, st));
  wrapCache.set(value, proxy);
  return proxy;
}

function childPath(path, prop, target) {
  if (path.length === 0 && prop === 'batches') return ['batches'];
  if (path.length === 1 && path[0] === 'batches' && isIndex(prop)) return ['batch', target[prop]];
  if (path.length === 0) return [prop];
  return path.concat([prop]);
}

function handler(target, path, st) {
  return {
    get(t, prop, receiver) {
      if (prop === RAW) return t;
      if (typeof prop === 'symbol') {
        const val = Reflect.get(t, prop, receiver);
        return typeof val === 'function' ? function bound() { return val.apply(receiver, arguments); } : val;
      }
      const val = Reflect.get(t, prop, receiver);
      if (typeof val === 'function') return function bound() { return val.apply(receiver, arguments); };
      return wrap(val, childPath(path, prop, t), st);
    },
    set(t, prop, value) {
      const raw = unwrap(value);
      const ok = Reflect.set(t, prop, raw);
      mark(st, path, prop, t);
      return ok;
    },
    deleteProperty(t, prop) {
      const ok = Reflect.deleteProperty(t, prop);
      mark(st, path, prop, t);
      if (path.length === 0 && typeof prop !== 'symbol' && prop !== 'batches') st.dirty.keys.add(String(prop));
      if (path[0] === 'auditLog' || (path.length === 0 && prop === 'auditLog')) st.dirty.auditFull = true;
      return ok;
    },
    has(t, prop) {
      if (prop === RAW) return true;
      return Reflect.has(t, prop);
    },
    ownKeys(t) { return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, prop) { return Reflect.getOwnPropertyDescriptor(t, prop); },
  };
}

function fragOf(st, batch) {
  if (!batch || typeof batch !== 'object') return null;
  let f = st.frags.get(batch);
  if (!f) {
    f = {
      ordersBuf: null,
      ordersDirty: true,
      stateBufs: new Map(),
      statesAllDirty: true,
      statesDirty: new Set(),
      shell: new Map(),
      shellAll: true,
      shellDirty: new Set(),
      known: false,
    };
    st.frags.set(batch, f);
  }
  return f;
}

function mark(st, path, prop, target) {
  if (typeof prop === 'symbol') return;
  const key = String(prop);
  if (path.length === 0) {
    if (key === 'auditLog') st.dirty.auditReplaced = true;
    else if (key !== 'batches') st.dirty.keys.add(key);
    return;
  }
  if (path[0] === 'auditLog') {
    if (path.length === 1 && key === 'length') {
      const base = st.audit ? st.audit.len : 0;
      if (target.length < base) st.dirty.auditFull = true;
      return;
    }
    const idx = path.length === 1 && isIndex(key) ? Number(key)
      : (path.length >= 2 && isIndex(String(path[1])) ? Number(path[1]) : null);
    if (idx === null) { st.dirty.auditFull = true; return; }
    const base = st.audit ? st.audit.len : 0;
    if (idx < base) st.dirty.auditFull = true;
    else st.dirty.auditAppend = true;
    return;
  }
  if (path[0] === 'batch') {
    const frag = fragOf(st, path[1]);
    if (!frag) return;
    const rest = path.slice(2);
    if (rest.length === 0) {
      if (key === 'orders') frag.ordersDirty = true;
      else if (key === 'orderStates') frag.statesAllDirty = true;
      else { frag.shellDirty.add(key); }
      return;
    }
    if (rest[0] === 'orders') { frag.ordersDirty = true; return; }
    if (rest[0] === 'orderStates') {
      if (rest.length === 1) frag.statesDirty.add(key);
      else frag.statesDirty.add(String(rest[1]));
      return;
    }
    frag.shellDirty.add(String(rest[0]));
    return;
  }
  if (path[0] !== 'batches') st.dirty.keys.add(String(path[0]));
}

function noteIdentity(tenantId, raw) {
  const st = stateFor(tenantId);
  if (st.raw === raw) return;
  st.raw = raw;
  st.primed = false;
  st.lastFullAt = 0;
  st.frags = new WeakMap();
  st.keys = new Map();
  st.audit = null;
  st.dirty = freshDirty();
}

function invalidate(tenantId) {
  const st = tenants.get(tenantId);
  if (!st) return;
  st.primed = false;
  st.lastFullAt = 0;
  st.frags = new WeakMap();
  st.keys = new Map();
  st.audit = null;
  st.dirty = freshDirty();
}

function track(tenantId, raw) {
  if (!isWrapable(raw)) return raw;
  raw = unwrap(raw);
  const st = stateFor(tenantId);
  if (st.raw !== raw) noteIdentity(tenantId, raw);
  return wrap(raw, [], st);
}

function bufOf(s) { return Buffer.from(s); }

function pushFlat(out, parts) {
  for (const p of parts) out.push(p);
}

function emitStates(os, frag) {
  if (typeof os !== 'object' || os === null) {
    const s = JSON.stringify(os);
    return { parts: [s], stringified: s.length, reused: 0, statesRewritten: 0 };
  }
  const forceAll = frag.statesAllDirty || !frag.known;
  const keys = Object.keys(os);
  const parts = ['{'];
  let stringified = 0, reused = 0, rewritten = 0, first = true;
  const keep = new Set(keys);
  for (const k of keys) {
    let buf = frag.stateBufs.get(k);
    if (forceAll || frag.statesDirty.has(k) || !buf) {
      const s = JSON.stringify(os[k]);
      if (s === undefined) continue;
      buf = bufOf(s);
      frag.stateBufs.set(k, buf);
      stringified += s.length;
      rewritten++;
    } else {
      reused += buf.length;
    }
    if (!first) parts.push(',');
    first = false;
    parts.push(JSON.stringify(k) + ':');
    parts.push(buf);
  }
  for (const k of [...frag.stateBufs.keys()]) if (!keep.has(k)) frag.stateBufs.delete(k);
  parts.push('}');
  frag.statesAllDirty = false;
  frag.statesDirty.clear();
  return { parts, stringified, reused, statesRewritten: rewritten };
}

function emitBatch(batch, st) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    const s = JSON.stringify(batch === undefined ? null : batch);
    return { parts: [s], stringified: s.length, reused: 0, ordersRewritten: 0, statesRewritten: 0 };
  }
  const frag = fragOf(st, batch);
  const parts = ['{'];
  let stringified = 0, reused = 0, ordersRewritten = 0, statesRewritten = 0, first = true;
  const emitKey = (key, piece, bytes, fresh) => {
    if (piece === undefined) return;
    if (!first) parts.push(',');
    first = false;
    parts.push(JSON.stringify(key) + ':');
    if (Array.isArray(piece)) pushFlat(parts, piece);
    else parts.push(piece);
    if (fresh) stringified += bytes;
    else reused += bytes;
  };
  for (const k of Object.keys(batch)) {
    if (k === 'orders') {
      if (!frag.ordersDirty && frag.ordersBuf && frag.known) {
        emitKey(k, frag.ordersBuf, frag.ordersBuf.length, false);
      } else {
        const s = JSON.stringify(batch.orders);
        if (s === undefined) { frag.ordersBuf = null; frag.ordersDirty = false; continue; }
        frag.ordersBuf = bufOf(s);
        frag.ordersDirty = false;
        ordersRewritten++;
        emitKey(k, frag.ordersBuf, s.length, true);
      }
      continue;
    }
    if (k === 'orderStates') {
      const sub = emitStates(batch.orderStates, frag);
      statesRewritten += sub.statesRewritten;
      stringified += sub.stringified;
      reused += sub.reused;
      if (!first) parts.push(',');
      first = false;
      parts.push(JSON.stringify(k) + ':');
      pushFlat(parts, sub.parts);
      continue;
    }
    const redo = !frag.known || frag.shellAll || frag.shellDirty.has(k) || !frag.shell.has(k);
    if (!redo) {
      const buf = frag.shell.get(k);
      emitKey(k, buf, buf.length, false);
      continue;
    }
    const s = JSON.stringify(batch[k]);
    if (s === undefined) { frag.shell.delete(k); continue; }
    const buf = bufOf(s);
    frag.shell.set(k, buf);
    emitKey(k, buf, s.length, true);
  }
  parts.push('}');
  frag.known = true;
  frag.shellAll = false;
  frag.shellDirty.clear();
  frag.ordersDirty = false;
  return { parts, stringified, reused, ordersRewritten, statesRewritten };
}

function emitBatches(batches, st) {
  if (!Array.isArray(batches)) {
    const s = JSON.stringify(batches);
    return { parts: [s], stringified: s.length, reused: 0, ordersRewritten: 0, statesRewritten: 0 };
  }
  const parts = ['['];
  let stringified = 0, reused = 0, ordersRewritten = 0, statesRewritten = 0;
  for (let i = 0; i < batches.length; i++) {
    if (i) parts.push(',');
    if (!Object.prototype.hasOwnProperty.call(batches, i)) {
      parts.push('null');
      stringified += 4;
      continue;
    }
    const sub = emitBatch(batches[i], st);
    pushFlat(parts, sub.parts);
    stringified += sub.stringified;
    reused += sub.reused;
    ordersRewritten += sub.ordersRewritten;
    statesRewritten += sub.statesRewritten;
  }
  parts.push(']');
  return { parts, stringified, reused, ordersRewritten, statesRewritten };
}

function emitAudit(log, st, full) {
  const base = st.audit;
  const needFull = full || !base || st.dirty.auditFull || st.dirty.auditReplaced || !Array.isArray(log)
    || log.length < base.len
    || (log.length > base.len && !st.dirty.auditAppend)
    || (log.length === base.len && st.dirty.auditAppend);
  if (needFull) {
    const s = JSON.stringify(log);
    const body = bufOf(s.slice(0, -1));
    st.audit = { chunks: [body], len: Array.isArray(log) ? log.length : 0 };
    return { parts: [body, ']'], stringified: s.length, reused: 0, mode: 'full' };
  }
  if (log.length > base.len) {
    let stringified = 0;
    for (let i = base.len; i < log.length; i++) {
      const s = JSON.stringify(log[i]);
      if (base.len > 0 || i > base.len) { base.chunks.push(bufOf(',')); stringified += 1; }
      base.chunks.push(bufOf(s));
      stringified += s.length;
    }
    base.len = log.length;
    return { parts: base.chunks.concat([']']), stringified, reused: sizeOf(base.chunks) - stringified, mode: 'append' };
  }
  return { parts: base.chunks.concat([']']), stringified: 0, reused: sizeOf(base.chunks) + 1, mode: 'reuse' };
}

function sizeOf(chunks) {
  let n = 0;
  for (const c of chunks) n += typeof c === 'string' ? c.length : c.length;
  return n;
}

function emitScalarKey(st, key, value, full) {
  if (!full && !st.dirty.keys.has(key) && st.keys.has(key)) {
    const buf = st.keys.get(key);
    return { parts: [buf], stringified: 0, reused: buf.length, omit: false };
  }
  const s = JSON.stringify(value);
  if (s === undefined) { st.keys.delete(key); return { omit: true, parts: [], stringified: 0, reused: 0 }; }
  const buf = bufOf(s);
  st.keys.set(key, buf);
  return { parts: [buf], stringified: s.length, reused: 0, omit: false };
}

function assemble(raw, st, full) {
  if (full) {
    st.frags = new WeakMap();
    st.keys = new Map();
    st.audit = null;
  }
  const parts = ['{'];
  let stringified = 0, reused = 0, ordersRewritten = 0, statesRewritten = 0, first = true;
  let auditMode = null;
  const take = (key, sub) => {
    if (sub.omit) return;
    if (!first) parts.push(',');
    first = false;
    parts.push(JSON.stringify(key) + ':');
    pushFlat(parts, sub.parts);
    stringified += sub.stringified;
    reused += sub.reused;
  };
  for (const k of Object.keys(raw)) {
    if (k === 'batches') {
      const sub = emitBatches(raw.batches, st);
      ordersRewritten += sub.ordersRewritten;
      statesRewritten += sub.statesRewritten;
      take(k, sub);
      continue;
    }
    if (k === 'auditLog') {
      const sub = emitAudit(raw.auditLog, st, full);
      auditMode = sub.mode;
      take(k, sub);
      continue;
    }
    take(k, emitScalarKey(st, k, raw[k], full));
  }
  parts.push('}');
  const dirty = [
    ordersRewritten ? 'orders×' + ordersRewritten : '',
    statesRewritten ? 'states×' + statesRewritten : '',
    auditMode && auditMode !== 'reuse' ? 'audit:' + auditMode : '',
  ].filter(Boolean).join(', ') || 'none';
  return {
    parts,
    fullRebuild: full,
    stringifiedBytes: stringified,
    reusedBytes: reused,
    ordersRewritten,
    statesRewritten,
    auditMode,
    dirty,
  };
}

function build(tenantId, raw) {
  raw = unwrap(raw);
  if (!raw || typeof raw !== 'object') throw new Error('incremental persist expects an object');
  const st = stateFor(tenantId);
  if (st.raw !== raw) noteIdentity(tenantId, raw);
  const every = rebuildMs();
  const due = !!(st.primed && every > 0 && st.lastFullAt && (Date.now() - st.lastFullAt) >= every);
  const full = due || !st.primed;
  const built = assemble(raw, st, full);
  st.primed = true;
  st.dirty = freshDirty();
  if (full) st.lastFullAt = Date.now();
  return built;
}

function partsBytes(parts) {
  let n = 0;
  for (const p of parts) n += typeof p === 'string' ? p.length : p.length;
  return n;
}

function partsToString(parts) {
  let s = '';
  for (const p of parts) s += typeof p === 'string' ? p : p.toString('utf8');
  return s;
}

module.exports = {
  enabled, unwrap, track, noteIdentity, invalidate, build, partsBytes, partsToString, rebuildMs,
};
