'use strict';
// EVENT-LOOP LAG MONITOR + JOB NAMES + SCAN ACTIVITY.
//
// The floor reported whole-process freezes of 40-92 s: every request in flight,
// even static files, finished in the same second. That is one synchronous
// stretch of work holding the single request thread, and the logs could only
// say which REQUEST was slowest, never which piece of work held the loop. This
// module answers that the next time it happens:
//   - a cheap timer notices when it fired late (the loop was blocked), and
//     logs `[event-loop-lag]` with the block length, the named background jobs
//     that were running during that window, and the oldest requests in flight;
//   - trackJob(name, fn) labels background work (label sweep, store pulls,
//     backups) so the log line can name it;
//   - noteScanActivity()/msSinceScan() let heavy background work stay out of
//     the way while the floor is scanning.
// No dependencies, nothing persisted, nothing changes behaviour.

const _active = new Map();      // job name -> running count
let _seenSinceTick = new Set(); // jobs that were running at any point since the last tick
const _inflight = new Map();    // id -> { m, p, t }
let _reqSeq = 0;
let _lastScanAt = 0;

function beginJob(name) {
  _active.set(name, (_active.get(name) || 0) + 1);
  _seenSinceTick.add(name);
}
function endJob(name) {
  const n = (_active.get(name) || 0) - 1;
  if (n > 0) _active.set(name, n); else _active.delete(name);
  _seenSinceTick.add(name);
}
// Runs fn() with `name` registered as active. Works for sync and async fns.
function trackJob(name, fn) {
  beginJob(name);
  let r;
  try { r = fn(); }
  catch (e) { endJob(name); throw e; }
  if (r && typeof r.then === 'function') {
    return r.then(v => { endJob(name); return v; }, e => { endJob(name); throw e; });
  }
  endJob(name);
  return r;
}
function activeJobs() { return [..._active.keys()]; }

function noteScanActivity(now = Date.now()) { _lastScanAt = now; }
function lastScanAt() { return _lastScanAt; }
function msSinceScan(now = Date.now()) { return _lastScanAt ? now - _lastScanAt : Infinity; }

// Express middleware: records requests in flight (for the lag line) and marks
// scan activity on any /api/scan/* call.
function middleware(req, res, next) {
  const url = req.originalUrl || req.url || '';
  const p = url.split('?')[0];
  if (p.startsWith('/api/scan/')) noteScanActivity();
  if (p.startsWith('/api/')) {
    const id = ++_reqSeq;
    _inflight.set(id, { m: req.method, p, t: Date.now() });
    let done = false;
    const fin = () => { if (!done) { done = true; _inflight.delete(id); } };
    res.on('finish', fin);
    res.on('close', fin);
  }
  next();
}
function oldestInflight(now = Date.now(), n = 3) {
  return [..._inflight.values()]
    .sort((a, b) => a.t - b.t)
    .slice(0, n)
    .map(r => `${r.m} ${r.p} ${now - r.t}ms`);
}

let _timer = null;
function start({ intervalMs = 500, thresholdMs = 1000, log = console.log } = {}) {
  if (_timer) return;
  let expected = Date.now() + intervalMs;
  _timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + intervalMs;
    const jobs = new Set([..._seenSinceTick, ..._active.keys()]);
    _seenSinceTick = new Set(_active.keys());
    if (lag >= thresholdMs) {
      const inflight = oldestInflight(now);
      log(`[event-loop-lag] blocked ~${lag}ms; jobs=${jobs.size ? [...jobs].join(',') : 'none'}`
        + `; inflight=${_inflight.size}${inflight.length ? ' [' + inflight.join('; ') + ']' : ''}`);
    }
  }, intervalMs);
  _timer.unref?.();
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = {
  beginJob, endJob, trackJob, activeJobs,
  noteScanActivity, lastScanAt, msSinceScan,
  middleware, oldestInflight, start, stop,
};
