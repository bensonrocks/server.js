'use strict';
const { db, uuid, nowIso, nextJobCode } = require('./db');
const { newClientToken } = require('./auth');
const { STAGE_ORDER, STAGE_LABELS, stageIndex } = require('./stages');

function logEvent(jobId, type, note, actor) {
  db.prepare(
    'INSERT INTO job_events (id, job_id, type, note, actor, at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(uuid(), jobId, type, note || null, actor || null, nowIso());
}

function touch(jobId) {
  db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(nowIso(), jobId);
}

// A job may only move FORWARD through STAGE_ORDER; a stage action never
// regresses a job that has already moved further along (e.g. re-sending a
// quote on an already-accepted job must not un-accept it). advanceTo() is
// the one place that decides this, so every action goes through it instead
// of writing `status` directly.
function advanceTo(jobId, targetStatus) {
  const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw httpError(404, 'Job not found');
  const cur = stageIndex(job.status);
  const target = stageIndex(targetStatus);
  if (target > cur) {
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(targetStatus, jobId);
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function requireJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) throw httpError(404, 'Job not found');
  return job;
}

function createJob({ client_name, client_contact, description }, actor) {
  if (!client_name || !String(client_name).trim()) {
    throw httpError(400, 'client_name is required');
  }
  const id = uuid();
  const at = nowIso();
  const job_code = nextJobCode();
  const client_token = newClientToken();
  db.prepare(
    `INSERT INTO jobs (id, job_code, client_name, client_contact, description, status,
       client_token, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'quote_requested', ?, ?, ?, ?)`
  ).run(id, job_code, String(client_name).trim(), client_contact || null, description || null,
    client_token, actor || null, at, at);
  logEvent(id, 'quote_requested', 'Quote request logged', actor);
  return requireJob(id);
}

function sendQuote(jobId, { amount, currency, notes, doc_path }, actor) {
  const job = requireJob(jobId);
  if (job.cancelled) throw httpError(409, 'This job is cancelled');
  if (amount === undefined || amount === null || amount === '' || isNaN(Number(amount))) {
    throw httpError(400, 'A quote amount is required');
  }
  db.prepare(
    `UPDATE jobs SET quote_amount = ?, quote_currency = ?, quote_notes = ?,
       quote_doc_path = COALESCE(?, quote_doc_path), quote_sent_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(Number(amount), currency || 'SGD', notes || null, doc_path || null, nowIso(), nowIso(), jobId);
  advanceTo(jobId, 'quote_sent');
  logEvent(jobId, 'quote_sent', `Quote sent: ${currency || 'SGD'} ${Number(amount).toFixed(2)}`, actor);
  return requireJob(jobId);
}

function recordAcceptance(jobId, { accepted_by, notes, proof_path }, actor) {
  const job = requireJob(jobId);
  if (job.cancelled) throw httpError(409, 'This job is cancelled');
  if (!job.quote_sent_at) throw httpError(409, 'Send the quote before recording acceptance');
  if (!proof_path && !job.acceptance_proof_path) {
    throw httpError(400, 'Upload proof of quote acceptance (PO, signed quote, confirmation email, etc.)');
  }
  db.prepare(
    `UPDATE jobs SET accepted_at = ?, accepted_by = ?, acceptance_notes = ?,
       acceptance_proof_path = COALESCE(?, acceptance_proof_path), updated_at = ?
     WHERE id = ?`
  ).run(nowIso(), accepted_by || null, notes || null, proof_path || null, nowIso(), jobId);
  advanceTo(jobId, 'accepted');
  logEvent(jobId, 'accepted', accepted_by ? `Accepted by ${accepted_by}` : 'Quote accepted', actor);
  return requireJob(jobId);
}

function recordCollection(jobId, { collected_by, pickup_location, notes }, actor, photoCount) {
  const job = requireJob(jobId);
  if (job.cancelled) throw httpError(409, 'This job is cancelled');
  if (stageIndex(job.status) < stageIndex('accepted')) {
    throw httpError(409, 'The quote must be accepted before recording collection');
  }
  const hasPhoto = photoCount > 0 || db.prepare(
    "SELECT COUNT(*) c FROM job_photos WHERE job_id = ? AND stage = 'collection'"
  ).get(jobId).c > 0;
  if (!hasPhoto) throw httpError(400, 'Upload at least one photo as proof of collection');
  db.prepare(
    `UPDATE jobs SET collected_at = COALESCE(collected_at, ?), collected_by = ?,
       pickup_location = ?, collection_notes = ?, updated_at = ?
     WHERE id = ?`
  ).run(nowIso(), collected_by || null, pickup_location || null, notes || null, nowIso(), jobId);
  advanceTo(jobId, 'collected');
  logEvent(jobId, 'collected', collected_by ? `Collected by ${collected_by}` : 'Collection recorded', actor);
  return requireJob(jobId);
}

function recordShipment(jobId, { carrier, tracking_number, notes }, actor) {
  const job = requireJob(jobId);
  if (job.cancelled) throw httpError(409, 'This job is cancelled');
  if (stageIndex(job.status) < stageIndex('collected')) {
    throw httpError(409, 'Record collection before starting shipment tracking');
  }
  if (!carrier && !tracking_number) {
    throw httpError(400, 'Carrier or tracking number is required');
  }
  db.prepare(
    `UPDATE jobs SET carrier = ?, tracking_number = ?, tracking_notes = ?,
       shipped_at = COALESCE(shipped_at, ?), updated_at = ?
     WHERE id = ?`
  ).run(carrier || null, tracking_number || null, notes || null, nowIso(), nowIso(), jobId);
  advanceTo(jobId, 'in_transit');
  logEvent(jobId, 'in_transit',
    [carrier, tracking_number].filter(Boolean).join(' / ') || 'Shipment tracking started', actor);
  return requireJob(jobId);
}

function addTrackingUpdate(jobId, { note }, actor) {
  const job = requireJob(jobId);
  if (job.cancelled) throw httpError(409, 'This job is cancelled');
  if (!note || !String(note).trim()) throw httpError(400, 'A tracking note is required');
  logEvent(jobId, 'tracking_update', String(note).trim(), actor);
  touch(jobId);
  return requireJob(jobId);
}

function recordDelivery(jobId, { received_by, notes }, actor, photoCount) {
  const job = requireJob(jobId);
  if (job.cancelled) throw httpError(409, 'This job is cancelled');
  if (stageIndex(job.status) < stageIndex('in_transit')) {
    throw httpError(409, 'Start shipment tracking before recording delivery');
  }
  const hasPhoto = photoCount > 0 || db.prepare(
    "SELECT COUNT(*) c FROM job_photos WHERE job_id = ? AND stage = 'delivery'"
  ).get(jobId).c > 0;
  if (!hasPhoto) throw httpError(400, 'Upload at least one photo as proof of delivery');
  db.prepare(
    `UPDATE jobs SET delivered_at = COALESCE(delivered_at, ?), received_by = ?,
       delivery_notes = ?, updated_at = ?
     WHERE id = ?`
  ).run(nowIso(), received_by || null, notes || null, nowIso(), jobId);
  advanceTo(jobId, 'delivered');
  logEvent(jobId, 'delivered', received_by ? `Received by ${received_by}` : 'Delivery recorded', actor);
  return requireJob(jobId);
}

function issueInvoice(jobId, { invoice_number, amount, currency, due_at, doc_path }, actor) {
  const job = requireJob(jobId);
  if (job.cancelled) throw httpError(409, 'This job is cancelled');
  if (amount === undefined || amount === null || amount === '' || isNaN(Number(amount))) {
    throw httpError(400, 'An invoice amount is required');
  }
  db.prepare(
    `UPDATE jobs SET invoice_number = ?, invoice_amount = ?, invoice_currency = ?,
       invoice_due_at = ?, invoice_sent_at = ?,
       invoice_doc_path = COALESCE(?, invoice_doc_path), updated_at = ?
     WHERE id = ?`
  ).run(invoice_number || null, Number(amount), currency || job.quote_currency || 'SGD',
    due_at || null, nowIso(), doc_path || null, nowIso(), jobId);
  advanceTo(jobId, 'invoiced');
  logEvent(jobId, 'invoiced',
    `Invoice ${invoice_number || ''} issued: ${currency || job.quote_currency || 'SGD'} ${Number(amount).toFixed(2)}`.trim(),
    actor);
  return requireJob(jobId);
}

// Payments are recorded as a ledger (job_payments) and paid_amount/status are
// DERIVED from the sum of that ledger every time — never incremented by hand
// — so a correction (recording the same receipt twice, or the wrong amount)
// can be fixed by deleting a payment row and the totals heal on their own.
function recalcPayment(jobId) {
  const job = requireJob(jobId);
  const sum = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM job_payments WHERE job_id = ?')
    .get(jobId).s;
  let status = 'unpaid';
  if (job.invoice_amount && sum >= job.invoice_amount - 0.005) status = 'paid';
  else if (sum > 0) status = 'partial';
  const paid_at = status === 'paid'
    ? (job.paid_at || nowIso())
    : null;
  db.prepare('UPDATE jobs SET paid_amount = ?, payment_status = ?, paid_at = ?, updated_at = ? WHERE id = ?')
    .run(sum, status, paid_at, nowIso(), jobId);
  if (status === 'paid') advanceTo(jobId, 'paid');
}

function recordPayment(jobId, { amount, note, proof_path }, actor) {
  const job = requireJob(jobId);
  if (job.cancelled) throw httpError(409, 'This job is cancelled');
  if (stageIndex(job.status) < stageIndex('invoiced')) {
    throw httpError(409, 'Issue the invoice before recording a payment');
  }
  if (amount === undefined || amount === null || amount === '' || isNaN(Number(amount)) || Number(amount) <= 0) {
    throw httpError(400, 'A positive payment amount is required');
  }
  db.prepare(
    'INSERT INTO job_payments (id, job_id, amount, note, proof_path, recorded_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(uuid(), jobId, Number(amount), note || null, proof_path || null, actor || null, nowIso());
  recalcPayment(jobId);
  const fresh = requireJob(jobId);
  logEvent(jobId, 'payment',
    `Payment received: ${fresh.invoice_currency || 'SGD'} ${Number(amount).toFixed(2)} (${fresh.payment_status})`,
    actor);
  return fresh;
}

function deletePayment(jobId, paymentId, actor) {
  const row = db.prepare('SELECT * FROM job_payments WHERE id = ? AND job_id = ?').get(paymentId, jobId);
  if (!row) throw httpError(404, 'Payment not found');
  db.prepare('DELETE FROM job_payments WHERE id = ?').run(paymentId);
  recalcPayment(jobId);
  logEvent(jobId, 'payment_removed', `Payment entry removed (was ${row.amount})`, actor);
  return requireJob(jobId);
}

function cancelJob(jobId, { reason }, actor) {
  const job = requireJob(jobId);
  if (job.cancelled) throw httpError(409, 'Already cancelled');
  if (!reason || String(reason).trim().length < 4) {
    throw httpError(400, 'A reason of at least 4 characters is required');
  }
  db.prepare(
    'UPDATE jobs SET cancelled = 1, cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?'
  ).run(nowIso(), actor || null, String(reason).trim(), nowIso(), jobId);
  logEvent(jobId, 'cancelled', String(reason).trim(), actor);
  return requireJob(jobId);
}

function reactivateJob(jobId, actor) {
  const job = requireJob(jobId);
  if (!job.cancelled) throw httpError(409, 'Job is not cancelled');
  db.prepare(
    'UPDATE jobs SET cancelled = 0, cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, updated_at = ? WHERE id = ?'
  ).run(nowIso(), jobId);
  logEvent(jobId, 'reactivated', 'Job reactivated', actor);
  return requireJob(jobId);
}

function addPhoto(jobId, { stage, file_path, caption }, actor) {
  requireJob(jobId);
  const id = uuid();
  db.prepare(
    'INSERT INTO job_photos (id, job_id, stage, file_path, caption, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, jobId, stage, file_path, caption || null, actor || null, nowIso());
  touch(jobId);
  return id;
}

function addVendorCost(jobId, { vendor_name, description, invoice_number, invoice_amount, currency, due_at, doc_path }, actor) {
  requireJob(jobId);
  if (!vendor_name || !String(vendor_name).trim()) throw httpError(400, 'vendor_name is required');
  if (invoice_amount === undefined || invoice_amount === null || invoice_amount === '' || isNaN(Number(invoice_amount))) {
    throw httpError(400, 'invoice_amount is required');
  }
  const id = uuid();
  const at = nowIso();
  db.prepare(
    `INSERT INTO vendor_costs (id, job_id, vendor_name, description, invoice_number, invoice_amount,
       currency, invoice_doc_path, due_at, status, paid_amount, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 0, ?, ?, ?)`
  ).run(id, jobId, String(vendor_name).trim(), description || null, invoice_number || null,
    Number(invoice_amount), currency || 'SGD', doc_path || null, due_at || null, actor || null, at, at);
  logEvent(jobId, 'vendor_cost_added',
    `Vendor cost added: ${vendor_name} ${currency || 'SGD'} ${Number(invoice_amount).toFixed(2)}`, actor);
  return db.prepare('SELECT * FROM vendor_costs WHERE id = ?').get(id);
}

function recalcVendorCost(vcId) {
  const vc = db.prepare('SELECT * FROM vendor_costs WHERE id = ?').get(vcId);
  if (!vc) return;
  const sum = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM vendor_cost_payments WHERE vendor_cost_id = ?')
    .get(vcId).s;
  let status = 'unpaid';
  if (sum >= vc.invoice_amount - 0.005) status = 'paid';
  else if (sum > 0) status = 'partial';
  const paid_at = status === 'paid' ? (vc.paid_at || nowIso()) : null;
  db.prepare('UPDATE vendor_costs SET paid_amount = ?, status = ?, paid_at = ?, updated_at = ? WHERE id = ?')
    .run(sum, status, paid_at, nowIso(), vcId);
}

function recordVendorPayment(vcId, { amount, note, proof_path }, actor) {
  const vc = db.prepare('SELECT * FROM vendor_costs WHERE id = ?').get(vcId);
  if (!vc) throw httpError(404, 'Vendor cost not found');
  if (amount === undefined || amount === null || amount === '' || isNaN(Number(amount)) || Number(amount) <= 0) {
    throw httpError(400, 'A positive payment amount is required');
  }
  db.prepare(
    'INSERT INTO vendor_cost_payments (id, vendor_cost_id, amount, note, proof_path, recorded_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(uuid(), vcId, Number(amount), note || null, proof_path || null, actor || null, nowIso());
  recalcVendorCost(vcId);
  const fresh = db.prepare('SELECT * FROM vendor_costs WHERE id = ?').get(vcId);
  logEvent(vc.job_id, 'vendor_payment',
    `Paid ${vc.vendor_name}: ${vc.currency || 'SGD'} ${Number(amount).toFixed(2)} (${fresh.status})`, actor);
  return fresh;
}

function deleteVendorCost(vcId, actor) {
  const vc = db.prepare('SELECT * FROM vendor_costs WHERE id = ?').get(vcId);
  if (!vc) throw httpError(404, 'Vendor cost not found');
  if (vc.paid_amount > 0) throw httpError(409, 'Cannot delete a vendor cost that already has payments recorded — remove the payments first');
  db.prepare('DELETE FROM vendor_costs WHERE id = ?').run(vcId);
  logEvent(vc.job_id, 'vendor_cost_removed', `Vendor cost removed: ${vc.vendor_name}`, actor);
}

function jobDetail(jobId) {
  const job = requireJob(jobId);
  const photos = db.prepare('SELECT * FROM job_photos WHERE job_id = ? ORDER BY uploaded_at ASC').all(jobId);
  const events = db.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY at ASC').all(jobId);
  const vendor_costs = db.prepare('SELECT * FROM vendor_costs WHERE job_id = ? ORDER BY created_at ASC').all(jobId);
  const payments = db.prepare('SELECT * FROM job_payments WHERE job_id = ? ORDER BY at ASC').all(jobId);
  const vendor_cost_payments = {};
  for (const vc of vendor_costs) {
    vendor_cost_payments[vc.id] = db.prepare(
      'SELECT * FROM vendor_cost_payments WHERE vendor_cost_id = ? ORDER BY at ASC'
    ).all(vc.id);
  }
  const totalVendorCost = vendor_costs.reduce((s, v) => s + v.invoice_amount, 0);
  const totalVendorPaid = vendor_costs.reduce((s, v) => s + v.paid_amount, 0);
  const margin = job.invoice_amount != null ? job.invoice_amount - totalVendorCost
    : (job.quote_amount != null ? job.quote_amount - totalVendorCost : null);
  return {
    ...job,
    stage_label: STAGE_LABELS[job.status] || job.status,
    stage_index: stageIndex(job.status),
    stage_count: STAGE_ORDER.length,
    photos,
    events,
    vendor_costs,
    vendor_cost_payments,
    payments,
    totals: {
      vendor_cost: totalVendorCost,
      vendor_paid: totalVendorPaid,
      vendor_outstanding: totalVendorCost - totalVendorPaid,
      margin,
    },
    client_url_path: `/client.html?t=${job.client_token}`,
  };
}

function isOverdueInvoice(job) {
  if (!job.invoice_due_at || job.payment_status === 'paid' || job.cancelled) return false;
  return new Date(job.invoice_due_at).getTime() < Date.now();
}

function listJobs({ status, q, client, cancelled } = {}) {
  let rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  if (cancelled === 'only') rows = rows.filter(j => j.cancelled);
  else if (!cancelled) rows = rows.filter(j => !j.cancelled);
  if (status) rows = rows.filter(j => j.status === status);
  if (client) rows = rows.filter(j => j.client_name.toLowerCase().includes(String(client).toLowerCase()));
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(j =>
      j.job_code.toLowerCase().includes(needle) ||
      j.client_name.toLowerCase().includes(needle) ||
      (j.tracking_number || '').toLowerCase().includes(needle) ||
      (j.invoice_number || '').toLowerCase().includes(needle)
    );
  }
  return rows.map(j => {
    const vcSum = db.prepare('SELECT COALESCE(SUM(invoice_amount),0) s FROM vendor_costs WHERE job_id = ?').get(j.id).s;
    return {
      ...j,
      stage_label: STAGE_LABELS[j.status] || j.status,
      stage_index: stageIndex(j.status),
      stage_count: STAGE_ORDER.length,
      vendor_cost_total: vcSum,
      overdue: isOverdueInvoice(j),
    };
  });
}

function stats() {
  const jobs = db.prepare('SELECT * FROM jobs WHERE cancelled = 0').all();
  const byStage = {};
  for (const s of STAGE_ORDER) byStage[s] = 0;
  let overdueInvoices = 0;
  let totalQuoted = 0;
  let totalOutstanding = 0;
  for (const j of jobs) {
    byStage[j.status] = (byStage[j.status] || 0) + 1;
    if (j.quote_amount) totalQuoted += j.quote_amount;
    if (isOverdueInvoice(j)) overdueInvoices++;
    if (j.invoice_amount) totalOutstanding += Math.max(0, j.invoice_amount - j.paid_amount);
  }
  const cancelledCount = db.prepare('SELECT COUNT(*) c FROM jobs WHERE cancelled = 1').get().c;
  return {
    total_active: jobs.length,
    by_stage: byStage,
    overdue_invoices: overdueInvoices,
    total_quoted: totalQuoted,
    total_outstanding: totalOutstanding,
    cancelled: cancelledCount,
  };
}

module.exports = {
  createJob, sendQuote, recordAcceptance, recordCollection, recordShipment,
  addTrackingUpdate, recordDelivery, issueInvoice, recordPayment, deletePayment,
  cancelJob, reactivateJob, addPhoto, addVendorCost, recordVendorPayment,
  deleteVendorCost, jobDetail, listJobs, stats, requireJob, httpError,
  isOverdueInvoice,
};
