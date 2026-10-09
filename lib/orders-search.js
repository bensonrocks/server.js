// Office order search for GET /api/orders?q=…
//
// Without this, `q` was ignored and range=all returned the whole enriched
// catalog (~15 MB / thousands of rows). Match the Completed-tab fields the UI
// already filters on, plus SKU and Transport TR- ids, before enrichment.
// Cap the hit list so only those rows are enriched / returned.

'use strict';

const DEFAULT_CAP = 60;
const MAX_CAP = 200;

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_]/g, '');
}

function parseCap(raw, fallback = DEFAULT_CAP) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_CAP, n);
}

function fieldHit(needle, needleNorm, value) {
  const s = String(value || '');
  if (!s) return false;
  const low = s.toLowerCase();
  if (low.includes(needle)) return true;
  const n = norm(s);
  return !!(needleNorm && n && n.includes(needleNorm));
}

/** Order numbers from transport jobs whose TR- id matches the query. */
function transportOrderHits(db, needle, needleNorm) {
  const out = new Set();
  for (const j of db.transport || []) {
    if (!fieldHit(needle, needleNorm, j.id)) continue;
    for (const n of [j.referenceId, j.clientId]) {
      const s = String(n || '').trim();
      if (s) out.add(s);
    }
  }
  return out;
}

/**
 * Walk hot batches cheaply and return matching order_number values (capped).
 * Does not enrich; does not read cold archive (caller / archived route covers that).
 */
function findMatchingOrderNumbers(db, q, cap = DEFAULT_CAP) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const needleNorm = norm(q);
  const limit = parseCap(cap, DEFAULT_CAP);
  const trHits = transportOrderHits(db, needle, needleNorm);
  const out = [];
  const seen = new Set();

  for (const batch of db.batches || []) {
    const client = batch.client_name || '';
    const job = batch.idealscan_code || '';
    for (const o of batch.orders || []) {
      const num = String(o.order_number || '');
      if (!num || seen.has(num)) continue;
      let hit = trHits.has(num);
      if (!hit) {
        hit = [
          o.order_number, o.waybill_number, o.issue_no, o.pick_ticket, o.po_number,
          o.customer_name, client, job,
        ].some(v => fieldHit(needle, needleNorm, v));
      }
      if (!hit && needleNorm.length >= 2) {
        hit = (o.lines || []).some(l =>
          fieldHit(needle, needleNorm, l.sku) || fieldHit(needle, needleNorm, l.barcode));
      }
      if (!hit) continue;
      seen.add(num);
      out.push(num);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Lean list row: keep what the Orders table / pick-list need, drop live stock
 * chips and other enrichment bulk that search results do not display.
 */
function leanOrderForList(o) {
  if (!o || typeof o !== 'object') return o;
  const slimLines = (o.lines || o.items || []).map(l => ({
    sku: l.sku,
    description: l.description,
    qty: l.qty,
    uom: l.uom,
    barcode: l.barcode,
    from_bundle: l.from_bundle,
    pick_locations: l.pick_locations,
    source_description: l.source_description,
  }));
  return {
    order_number: o.order_number,
    customer_name: o.customer_name,
    tel: o.tel,
    delivery_address: o.delivery_address,
    carrier: o.carrier,
    waybill_number: o.waybill_number,
    waybills: o.waybills,
    issue_no: o.issue_no,
    pick_ticket: o.pick_ticket,
    po_number: o.po_number,
    platform: o.platform,
    shop_name: o.shop_name,
    date: o.date,
    total_qty: o.total_qty,
    lines: slimLines,
    items: slimLines,
    client_name: o.client_name,
    batchId: o.batchId,
    uploadedAt: o.uploadedAt,
    idealscan_code: o.idealscan_code,
    scan_status: o.scan_status,
    scanned: o.scanned,
    startTime: o.startTime,
    endTime: o.endTime,
    operator: o.operator,
    keyfields_closed: o.keyfields_closed,
    claimed_by: o.claimed_by,
    reference_only: o.reference_only,
    reference_twin: o.reference_twin,
    api_source: o.api_source,
    has_waybill_pdf: o.has_waybill_pdf,
    has_order_label: o.has_order_label,
    label_pages: o.label_pages,
    transport_id: o.transport_id,
    fulfilment: o.fulfilment,
    has_bundle: o.has_bundle,
    bundle_skus: o.bundle_skus,
    pending_deletion: o.pending_deletion,
    archived: o.archived,
    placed_at: o.placed_at,
    unprocessed_at: o.unprocessed_at,
    unprocessed_reason: o.unprocessed_reason,
    auto_cancelled: o.auto_cancelled,
    auto_cancelled_why: o.auto_cancelled_why,
    auto_cancelled_short: o.auto_cancelled_short,
    hub_exception: o.hub_exception,
    platform_cancelled: o.platform_cancelled,
    client_cancelled: o.client_cancelled,
    zort_push: o.zort_push,
    zort_label: o.zort_label,
    alert_email_sent: o.alert_email_sent,
    alert_email_error: o.alert_email_error,
    attribution_hint: o.attribution_hint,
    mismatches: o.mismatches,
  };
}

function wantLean(query) {
  const v = String(query.lean == null ? '' : query.lean).trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  // Default ON when searching — the list does not need stock chips.
  return !!String(query.q || '').trim();
}

module.exports = {
  DEFAULT_CAP,
  MAX_CAP,
  norm,
  parseCap,
  findMatchingOrderNumbers,
  leanOrderForList,
  wantLean,
};
