// Event-loop lag monitor + job names + scan activity (lib/loop-lag.js). No server.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const lag = require('../lib/loop-lag');

test('trackJob names sync and async jobs while they run', async () => {
  assert.equal(lag.trackJob('sync-job', () => { assert.ok(lag.activeJobs().includes('sync-job')); return 7; }), 7);
  assert.ok(!lag.activeJobs().includes('sync-job'));
  const p = lag.trackJob('async-job', async () => { await new Promise(r => setTimeout(r, 5)); return 'ok'; });
  assert.ok(lag.activeJobs().includes('async-job'));
  assert.equal(await p, 'ok');
  assert.ok(!lag.activeJobs().includes('async-job'));
  await assert.rejects(lag.trackJob('bad-job', async () => { throw new Error('x'); }));
  assert.ok(!lag.activeJobs().includes('bad-job'));
  assert.throws(() => lag.trackJob('bad-sync', () => { throw new Error('y'); }));
  assert.ok(!lag.activeJobs().includes('bad-sync'));
});

test('middleware marks scan activity and tracks in-flight API requests', () => {
  const before = lag.lastScanAt();
  const mk = url => { const res = new EventEmitter(); let n = 0; lag.middleware({ method: 'POST', originalUrl: url }, res, () => n++); assert.equal(n, 1); return res; };
  const r1 = mk('/api/orders?range=today');
  assert.equal(lag.lastScanAt(), before);
  assert.ok(lag.oldestInflight().some(s => s.startsWith('POST /api/orders ')));
  r1.emit('finish'); r1.emit('close');
  assert.ok(!lag.oldestInflight().some(s => s.startsWith('POST /api/orders ')));
  const r2 = mk('/api/scan/increment');
  assert.ok(lag.lastScanAt() >= before && lag.msSinceScan() < 1000);
  r2.emit('close');
  mk('/app.js').emit('finish');   // static: not tracked, no throw
});

test('monitor logs a block over the threshold with the running job', async () => {
  const lines = [];
  lag.start({ intervalMs: 20, thresholdMs: 150, log: l => lines.push(l) });
  try {
    await new Promise(r => setTimeout(r, 50));
    lag.trackJob('busy-loop-job', () => { const t = Date.now(); while (Date.now() - t < 300) {} });
    await new Promise(r => setTimeout(r, 80));
  } finally { lag.stop(); }
  const hit = lines.find(l => l.startsWith('[event-loop-lag] blocked'));
  assert.ok(hit, JSON.stringify(lines));
  assert.match(hit, /jobs=.*busy-loop-job/);
});
