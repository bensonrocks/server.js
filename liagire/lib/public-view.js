'use strict';
// What a client sees on their token link. Deliberately NEVER includes vendor
// costs, vendor names, internal notes, or who on our side did what internally
// — that is our own margin and staffing, not theirs. Only facts that are
// genuinely about their own shipment: dates, proof photos, carrier/tracking,
// and their own invoice/payment status.
const { db } = require('./db');
const { STAGE_LABELS, STAGE_ORDER, stageIndex } = require('./stages');

function publicJobView(job) {
  const photos = db.prepare('SELECT id, stage, caption, uploaded_at FROM job_photos WHERE job_id = ? ORDER BY uploaded_at ASC').all(job.id);
  const payments = db.prepare('SELECT amount, at FROM job_payments WHERE job_id = ? ORDER BY at ASC').all(job.id);
  const trackingUpdates = db.prepare(
    "SELECT note, at FROM job_events WHERE job_id = ? AND type = 'tracking_update' ORDER BY at ASC"
  ).all(job.id);

  const timeline = [
    { key: 'quote_requested', label: STAGE_LABELS.quote_requested, at: job.created_at, done: true },
    { key: 'quote_sent', label: STAGE_LABELS.quote_sent, at: job.quote_sent_at,
      done: !!job.quote_sent_at,
      detail: job.quote_amount != null ? `${job.quote_currency || 'SGD'} ${Number(job.quote_amount).toFixed(2)}` : null },
    { key: 'accepted', label: STAGE_LABELS.accepted, at: job.accepted_at, done: !!job.accepted_at,
      detail: job.accepted_by ? `Accepted by ${job.accepted_by}` : null },
    { key: 'collected', label: STAGE_LABELS.collected, at: job.collected_at, done: !!job.collected_at,
      detail: job.pickup_location || null },
    { key: 'in_transit', label: STAGE_LABELS.in_transit, at: job.shipped_at, done: !!job.shipped_at,
      detail: [job.carrier, job.tracking_number].filter(Boolean).join(' · ') || null },
    { key: 'delivered', label: STAGE_LABELS.delivered, at: job.delivered_at, done: !!job.delivered_at,
      detail: job.received_by ? `Received by ${job.received_by}` : null },
    { key: 'invoiced', label: STAGE_LABELS.invoiced, at: job.invoice_sent_at, done: !!job.invoice_sent_at,
      detail: job.invoice_amount != null ? `${job.invoice_currency || 'SGD'} ${Number(job.invoice_amount).toFixed(2)}` : null },
    { key: 'paid', label: STAGE_LABELS.paid, at: job.paid_at, done: job.payment_status === 'paid' },
  ];

  return {
    job_code: job.job_code,
    client_name: job.client_name,
    status: job.status,
    stage_label: STAGE_LABELS[job.status] || job.status,
    stage_index: stageIndex(job.status),
    stage_count: STAGE_ORDER.length,
    cancelled: !!job.cancelled,
    cancelled_at: job.cancelled ? job.cancelled_at : null,
    timeline,
    tracking: {
      carrier: job.carrier,
      tracking_number: job.tracking_number,
      updates: trackingUpdates,
    },
    quote: job.quote_amount != null ? {
      amount: job.quote_amount, currency: job.quote_currency, sent_at: job.quote_sent_at,
      has_document: !!job.quote_doc_path,
    } : null,
    acceptance: job.accepted_at ? {
      at: job.accepted_at, by: job.accepted_by, has_proof: !!job.acceptance_proof_path,
    } : null,
    collection: job.collected_at ? {
      at: job.collected_at, by: job.collected_by, location: job.pickup_location,
      photos: photos.filter(p => p.stage === 'collection'),
    } : null,
    delivery: job.delivered_at ? {
      at: job.delivered_at, received_by: job.received_by,
      photos: photos.filter(p => p.stage === 'delivery'),
    } : null,
    invoice: job.invoice_amount != null ? {
      number: job.invoice_number, amount: job.invoice_amount, currency: job.invoice_currency,
      due_at: job.invoice_due_at, sent_at: job.invoice_sent_at, has_document: !!job.invoice_doc_path,
      payment_status: job.payment_status, paid_amount: job.paid_amount,
      balance: Math.max(0, job.invoice_amount - job.paid_amount),
      paid_at: job.paid_at, payments,
    } : null,
  };
}

module.exports = { publicJobView };
