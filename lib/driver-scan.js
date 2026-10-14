'use strict';
// DRIVER SCAN-TO-CLOSE. The driver, while on a job (a route, or a single
// unrouted stop), scans the label on an order. If the code belongs to an
// order on THAT job the delivery is closed; anything else is refused and
// nothing changes. Pure functions: server.js supplies the transport jobs and
// an order lookup, and persists. Touches transport (delivery) status only,
// never warehouse/pick-pack scan state.

const norm = s => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');

// Every code printed on paperwork for this delivery: the order number
// (system label falls back to it), the carrier waybill (system label barcode
// when present), and the DO number (DO-<GI no | order no>).
function codesForJob(job, order) {
  const out = new Set();
  const add = v => { const n = norm(v); if (n) out.add(n); };
  add(job.referenceId); add(job.clientId);
  if (order) {
    add(order.order_number); add(order.waybill_number); add(order.issue_no);
    add('DO-' + String(order.issue_no || order.order_number || '').replace(/[^A-Za-z0-9-]/g, ''));
  } else if (job.referenceId) {
    add('DO-' + String(job.referenceId).replace(/[^A-Za-z0-9-]/g, ''));
  }
  return out;
}

function scopeOf(job) {
  return job.routeNum != null ? { kind: 'route', routeNum: job.routeNum } : { kind: 'job', jobId: job.id };
}
function inScope(scope, job) {
  return scope.kind === 'route' ? job.routeNum === scope.routeNum : job.id === scope.jobId;
}
function where(job) {
  return job.routeNum != null ? `Route ${job.routeNum}, Stop ${job.stopSeq ?? '?'}` : `job ${job.id}`;
}
function progress(jobs, scope) {
  const list = jobs.filter(j => inScope(scope, j) && j.status !== 'cancelled');
  const closed = list.filter(j => j.status === 'delivered').length;
  return { closed, total: list.length, complete: list.length > 0 && closed === list.length };
}

// transport: all jobs; driverId: who is scanning; anchorJobId: the job the
// driver has open (defines the scope); orderFor(job) -> order|null.
// Returns { ok, status, result, message, job?, progress }. On ok the caller
// must persist (the matched job object has been mutated).
function scanClose({ transport, driverId, anchorJobId, code, orderFor, now = new Date(), gps }) {
  const c = norm(code);
  const mine = (transport || []).filter(t => t.assignedDriver === driverId && t.status !== 'cancelled');
  const anchor = mine.find(t => t.id === anchorJobId);
  if (!anchor) return { ok: false, status: 404, result: 'no_job', message: 'Open one of your jobs before scanning.' };
  const scope = scopeOf(anchor);
  const prog = () => progress(mine, scope);
  if (!c || c.length < 3) return { ok: false, status: 400, result: 'bad_code', message: 'Nothing readable was scanned. Try again.', progress: prog() };

  const hits = (transport || []).filter(t => t.status !== 'cancelled' && codesForJob(t, orderFor(t)).has(c));
  if (!hits.length) return { ok: false, status: 404, result: 'unknown', message: `"${String(code).trim()}" doesn't match any order. Nothing was changed.`, progress: prog() };
  const onThis = hits.filter(t => t.assignedDriver === driverId && inScope(scope, t));
  if (!onThis.length) {
    const h = hits[0];
    const msg = h.assignedDriver === driverId
      ? `This order (${h.referenceId || h.id}) belongs to ${where(h)}, not this job. Nothing was changed.`
      : `This order (${h.referenceId || h.id}) is not on your job. Nothing was changed.`;
    return { ok: false, status: 409, result: 'wrong_job', message: msg, progress: prog() };
  }
  if (onThis.length > 1) return { ok: false, status: 409, result: 'ambiguous', message: 'This code matches more than one stop on this job. Close it from the stop instead.', progress: prog() };
  const job = onThis[0];
  if (job.status === 'delivered') return { ok: false, status: 409, result: 'already_closed', message: `Order ${job.referenceId || job.id} was already closed${job.deliveredAt ? ' at ' + new Date(job.deliveredAt).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' }) : ''}.`, job, progress: prog() };
  if (job.status !== 'in-transit') return { ok: false, status: 409, result: 'not_picked_up', message: `Order ${job.referenceId || job.id} hasn't been picked up yet. Accept it and tap Picked Up first.`, job, progress: prog() };

  const at = now.toISOString();
  job.status = 'delivered';
  job.deliveredAt = at;
  job.updatedAt = at;
  job.deliveredBy = driverId;
  job.closedBy = 'driver-scan';
  job.closedScanCode = String(code).trim().slice(0, 120);
  if (gps && Number.isFinite(Number(gps.lat)) && Number.isFinite(Number(gps.lng))) {
    job.podLocation = { lat: Number(gps.lat), lng: Number(gps.lng), accuracy: Number(gps.accuracy) || null, capturedAt: at };
  }
  return { ok: true, status: 200, result: 'closed', message: `Order ${job.referenceId || job.id} closed.`, job, progress: prog() };
}

module.exports = { norm, codesForJob, scanClose, progress, scopeOf };
