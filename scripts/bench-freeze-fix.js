// Benchmark for the 2026-10-20 freeze fix. node scripts/bench-freeze-fix.js [MB]
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const XLSX = require('xlsx');
const inc = require('../lib/incremental-persist');
const { makeSyntheticDb } = require('../test/fixtures/synthetic-db');
const MB = parseInt(process.argv[2] || '176', 10);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bench-'));
function probe() { let max = 0, last = process.hrtime.bigint(), on = true; const t = () => { if (!on) return; const n = process.hrtime.bigint(); const d = Number(n - last) / 1e6; if (d > max) max = d; last = n; setImmediate(t); }; setImmediate(t); return () => { on = false; return Math.round(max); }; }
const settle = () => new Promise(r => setTimeout(r, 50));
async function durableWrite(file, parts) {
  const tmp = file + '.tmp'; const fh = await fs.promises.open(tmp, 'w');
  let g = [], size = 0, last = Date.now();
  for (const p of parts) { const b = typeof p === 'string' ? Buffer.from(p) : p; if (!b.length) continue; g.push(b); size += b.length;
    if (size >= 1048576) { await fh.write(Buffer.concat(g, size)); g = []; size = 0; last = Date.now(); } else if (Date.now() - last > 8) { await new Promise(r => setImmediate(r)); last = Date.now(); } }
  if (g.length) await fh.write(Buffer.concat(g, size));
  await fh.sync(); await fh.close(); await fs.promises.rename(tmp, file);
}
const SG = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' });
function dailyOld(db, from, to) { // PR #101 path: proxied log, Intl per event, sync
  const log = db.auditLog; const day = at => at ? SG.format(new Date(at)) : ''; const inRange = ev => day(ev.at) >= from && day(ev.at) <= to;
  const mins = ev => (ev.startTime && ev.endTime) ? Math.round((new Date(ev.endTime) - new Date(ev.startTime)) / 6000) / 10 : null;
  const avg = a => a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length * 10) / 10 : '';
  const uploads = log.filter(e => e.type === 'upload' && inRange(e)); const completed = log.filter(e => e.type === 'order_completed' && inRange(e));
  log.filter(e => e.type === 'order_cancelled' && inRange(e)); log.filter(e => ['batch_deleted', 'order_deleted', 'order_deletion_rejected', 'master_reset'].includes(e.type) && inRange(e));
  const wb = XLSX.utils.book_new(); const days = {}; const D = d => days[d] ||= { batches: 0, ordUp: 0, lines: 0, done: 0, pieces: 0, durs: [] };
  for (const e of uploads) { const x = D(day(e.at)); x.batches++; x.ordUp += e.orders || 0; x.lines += e.lines || 0; }
  for (const e of completed) { const x = D(day(e.at)); x.done++; x.pieces += e.pieces || 0; const m = mins(e); if (m !== null) x.durs.push(m); }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date'], ...Object.keys(days).sort().map(d => [d, days[d].batches, days[d].ordUp, days[d].lines, days[d].done, days[d].pieces, avg(days[d].durs)])]), 'Daily');
  const dc = {}; for (const e of completed) { const k = day(e.at) + '|' + (e.client || '—'); dc[k] ||= { done: 0, pieces: 0 }; dc[k].done++; dc[k].pieces += e.pieces || 0; }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date'], ...Object.keys(dc).sort().map(k => [k, dc[k].done])]), 'By Client');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function dailyNew(raw, from, to) {
  const days = {}, dc = {}; const D = d => days[d] ||= { batches: 0, ordUp: 0, lines: 0, done: 0, pieces: 0, durs: [] };
  const log = raw.auditLog, n = log.length; let last = Date.now();
  for (let i = 0; i < n; i++) { const e = log[i];
    if (e && (e.type === 'upload' || e.type === 'order_completed')) { const t = Date.parse(e.at); const dd = new Date(t + 288e5).toISOString().slice(0, 10);
      if (dd >= from && dd <= to) { if (e.type === 'upload') { const x = D(dd); x.batches++; x.ordUp += e.orders || 0; } else { const x = D(dd); x.done++; x.pieces += e.pieces || 0; if (e.startTime && e.endTime) x.durs.push(1); const k = dd + '|' + e.client; dc[k] ||= { done: 0 }; dc[k].done++; } } }
    if ((i & 1023) === 1023 && Date.now() - last >= 8) { await new Promise(r => setImmediate(r)); last = Date.now(); } }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date'], ...Object.keys(days).sort().map(d => [d, days[d].batches])]), 'Daily');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date'], ...Object.keys(dc).sort().map(k => [k, dc[k].done])]), 'By Client');
  await new Promise(r => setImmediate(r));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
(async () => {
  let t = Date.now();
  const raw = makeSyntheticDb(MB, 42);
  const proxied = inc.track('bench', raw);
  const out = {};
  const file = path.join(dir, 'db.json');
  // BEFORE: legacy full stringify (flag off) and incremental sync rebuild (flag on, prod today)
  await settle(); let stop = probe(); t = Date.now(); const json = JSON.stringify(raw); out.legacyStringifyMs = Date.now() - t; await new Promise(r => fs.writeFile(file, json, r)); out.legacyMaxLagMs = stop();
  out.bytesMB = +(json.length / 1048576).toFixed(1); out.auditEntries = raw.auditLog.length;
  await settle(); stop = probe(); t = Date.now(); const s = inc.build('bench', raw, { forceFull: true }); out.syncRebuildBlockMs = Date.now() - t;
  await durableWrite(file, s.parts); out.syncRebuildTotalMs = Date.now() - t; out.syncRebuildMaxLagMs = stop();
  // AFTER: non-blocking rebuild + durable write
  await settle(); stop = probe(); t = Date.now(); const a = await inc.buildAsync('bench', raw, { forceFull: true }); out.asyncRebuildBuildMs = Date.now() - t;
  await durableWrite(file, a.parts); out.asyncRebuildTotalMs = Date.now() - t; out.asyncRebuildMaxLagMs = stop(); out.asyncYields = a.yields;
  out.identical = inc.partsBytes(a.parts) === json.length && JSON.parse(fs.readFileSync(file, 'utf8')).auditLog.length === raw.auditLog.length;
  // daily summary (default 30-day window)
  const from = '2026-09-21', to = '2026-10-20';
  await settle(); stop = probe(); t = Date.now(); dailyOld(proxied, from, to); out.dailyOldMs = Date.now() - t; out.dailyOldMaxLagMs = stop();
  await settle(); stop = probe(); t = Date.now(); await dailyNew(raw, from, to); out.dailyNewColdMs = Date.now() - t; out.dailyNewMaxLagMs = stop();
  console.log(JSON.stringify(out, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
})();
