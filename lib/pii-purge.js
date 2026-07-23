'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Marketplace (Lazada / ZORT) data-retention purge — PURE, unit-testable core.
//
//  Lazada ISV requirement (Q8e): personal data from a COMPLETED marketplace
//  order may be retained for at most three months, after which it must be
//  permanently deleted. We satisfy this by REDACTING the personal fields
//  (customer name, delivery address, phone/email, tracking number) from
//  completed marketplace-sourced orders — and their order_completed audit
//  events — once their completion time is older than the retention window.
//
//  Non-personal business records (order number, SKU/qty, timestamps, client
//  label, piece counts) are preserved so inventory and throughput history stay
//  intact — it's the PERSONAL DATA that must go, and only that.
//
//  This module is pure (operates on plain arrays, no fs / no db) so it can be
//  unit-tested directly. server.js wires it to live db.json, the on-disk
//  archive files, a daily schedule, and a manual master route.
// ─────────────────────────────────────────────────────────────────────────────

const PII_MARK = '[purged]';

// Personal fields on an order record and on an order_completed audit event.
const ORDER_PII = ['customer_name', 'delivery_address', 'tel', 'phone', 'customer_phone', 'customer_email', 'email', 'recipient', 'waybill_number'];
const AUDIT_PII = ['customer', 'waybill', 'customer_name', 'delivery_address', 'tel', 'phone', 'email', 'recipient'];

// A marketplace order is one that entered via the ZORT pull (Lazada/Shopee/etc.
// sales channels): the batch was uploaded by 'zort-sync' and/or the order still
// carries its zort linkage.
function isMarketplaceOrder(batch, ord) {
  return !!(ord && (ord.zort_store_id || ord.zort_id)) || (batch && batch.uploaded_by === 'zort-sync');
}

function redactFields(obj, fields) {
  let changed = false;
  for (const f of fields) if (obj[f] && obj[f] !== PII_MARK) { obj[f] = PII_MARK; changed = true; }
  return changed;
}

// Completion time of an order within its batch (empty string if not done).
function orderCompletedAt(batch, ord) {
  const st = (batch.orderStates || {})[ord.order_number];
  if (!st || st.status !== 'done') return '';
  return st.endTime || st.updated_at || '';
}

// Redact PII on completed marketplace orders whose completion is strictly
// OLDER than cutoffIso. If `keys` is supplied, every marketplace order seen
// (regardless of age) is recorded as `batchId|order_number` so audit events can
// be matched even after their batch has been archived. Returns redaction count.
function purgeBatches(batches, cutoffIso, keys) {
  let hits = 0;
  for (const b of batches || []) {
    for (const o of b.orders || []) {
      if (!isMarketplaceOrder(b, o)) continue;
      if (keys) keys.add(b.id + '|' + o.order_number);
      if (o.pii_purged) continue;
      const endT = orderCompletedAt(b, o);
      if (endT && endT < cutoffIso && redactFields(o, ORDER_PII)) { o.pii_purged = true; hits++; }
    }
  }
  return hits;
}

// Redact PII on order_completed audit events older than cutoffIso that belong
// to a marketplace order (self-identified via `source: 'zort'`, or matched
// against the `keys` set built from the batches). Returns redaction count.
function purgeAudit(events, cutoffIso, keys) {
  let hits = 0;
  for (const e of events || []) {
    if (e.type !== 'order_completed') continue;
    if ((e.endTime || e.at || '') >= cutoffIso) continue;
    const isMkt = e.source === 'zort' || (keys && keys.has((e.batchId || '') + '|' + (e.order || '')));
    if (isMkt && redactFields(e, AUDIT_PII)) { e.pii_purged = true; hits++; }
  }
  return hits;
}

module.exports = {
  PII_MARK, ORDER_PII, AUDIT_PII,
  isMarketplaceOrder, redactFields, orderCompletedAt, purgeBatches, purgeAudit,
};
