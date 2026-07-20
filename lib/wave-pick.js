'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Wave picking — "consolidated pick, then sort" (portable core module)
//
// A wave groups 2+ already-uploaded orders so a packer can pick every line's
// TOTAL quantity across the whole wave in one pass (scan SKU-123 x 47 once,
// instead of scanning it separately for 12 orders), then a sort/allocate step
// divides the scanned pile back into each order's required quantity before
// the packer completes each order through the normal single-order flow.
//
// This file has ZERO dependencies on IDEALONE's db shape, Express, or any
// order/state schema — every function takes plain data in and returns plain
// data out. The ONE seam that talks to a host app's real order/state records
// is `applyWaveToOrderStates`, which takes a callback instead of touching any
// host object directly. Copy this file verbatim into another codebase (e.g.
// IDEALOMS) and wire it to that host's own order store the same way.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a consolidated pick list from a set of orders.
 * @param {Array<{order_number:string, items:Array<{sku:string, description?:string, qty:number}>}>} orders
 * @returns {Array<{sku, description, totalQty, scannedQty:0, lines:Array<{order_number, needed, allocated:0}>}>}
 *          sorted by sku ascending.
 */
function buildWavePickList(orders) {
  const bySku = new Map();
  for (const order of orders || []) {
    const orderNumber = order.order_number;
    for (const item of order.items || []) {
      const sku = String(item.sku || '').trim();
      if (!sku) continue;
      const qty = Number(item.qty) || 0;
      if (!bySku.has(sku)) {
        bySku.set(sku, { sku, description: item.description || '', totalQty: 0, scannedQty: 0, lines: [] });
      }
      const entry = bySku.get(sku);
      if (!entry.description && item.description) entry.description = item.description;
      entry.totalQty += qty;
      const existingLine = entry.lines.find(l => l.order_number === orderNumber);
      if (existingLine) existingLine.needed += qty;
      else entry.lines.push({ order_number: orderNumber, needed: qty, allocated: 0 });
    }
  }
  return [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

/**
 * Create a new wave record from a set of orders.
 * @param {{id:string, orderNumbers:string[], orders:Array, createdBy?:string}} opts
 */
function createWave({ id, orderNumbers, orders, createdBy }) {
  return {
    id,
    createdAt: new Date().toISOString(),
    createdBy: createdBy || null,
    orderNumbers: [...orderNumbers],
    status: 'picking', // picking -> sorting -> done | cancelled
    pickList: buildWavePickList(orders),
    pickScanLog: [],
  };
}

function findPickEntry(wave, sku) {
  return (wave.pickList || []).find(e => e.sku === sku) || null;
}

/**
 * Record a consolidated scan against the wave's pick list. Mutates and
 * returns `wave`. Unknown SKUs are rejected (caller should treat null as
 * "not part of this wave").
 * @returns {{wave, entry}|null}
 */
function recordPickScan(wave, sku, qtyScanned, meta = {}) {
  const entry = findPickEntry(wave, sku);
  if (!entry) return null;
  const qty = Number(qtyScanned) || 0;
  entry.scannedQty += qty;
  wave.pickScanLog.push({ sku, qty, at: new Date().toISOString(), by: meta.by || null, eventId: meta.eventId || null });
  return { wave, entry };
}

/**
 * Auto-distribute each SKU's scanned quantity across the orders that need
 * it, in wave order (first order in `orderNumbers` filled first), never
 * over-allocating past what was actually scanned or what an order needs.
 * Deterministic and idempotent — safe to call again after more scans land.
 */
function autoAllocate(wave) {
  for (const entry of wave.pickList || []) {
    let remaining = entry.scannedQty;
    const orderIndex = new Map(wave.orderNumbers.map((n, i) => [n, i]));
    const orderedLines = [...entry.lines].sort((a, b) => (orderIndex.get(a.order_number) ?? 0) - (orderIndex.get(b.order_number) ?? 0));
    for (const line of orderedLines) {
      const take = Math.max(0, Math.min(line.needed, remaining));
      line.allocated = take;
      remaining -= take;
    }
    entry.unallocated = Math.max(0, remaining);
  }
  return wave;
}

/**
 * Manually adjust one SKU's allocation to one order during the sort phase
 * (e.g. a packer's +/- stepper). Clamped to [0, scannedQty for that SKU
 * across all other lines' allocations]. Returns false if the SKU/order pair
 * doesn't exist in the wave.
 */
function adjustAllocation(wave, sku, orderNumber, newQty) {
  const entry = findPickEntry(wave, sku);
  if (!entry) return false;
  const line = entry.lines.find(l => l.order_number === orderNumber);
  if (!line) return false;
  const otherAllocated = entry.lines.filter(l => l.order_number !== orderNumber).reduce((s, l) => s + l.allocated, 0);
  const maxForThisLine = Math.max(0, entry.scannedQty - otherAllocated);
  line.allocated = Math.max(0, Math.min(newQty, maxForThisLine));
  entry.unallocated = Math.max(0, entry.scannedQty - entry.lines.reduce((s, l) => s + l.allocated, 0));
  return true;
}

/** True once every pick-list line has been scanned to at least its total need. */
function isFullyScanned(wave) {
  return (wave.pickList || []).every(e => e.scannedQty >= e.totalQty);
}

/** True once every SKU's scanned pile has been fully divided among its orders. */
function isFullyAllocated(wave) {
  return (wave.pickList || []).every(e => e.lines.reduce((s, l) => s + l.allocated, 0) >= e.scannedQty);
}

/**
 * Per-order rollup for the sort screen / final review: pieces allocated vs
 * needed for each order in the wave, plus whether it's short/over/exact.
 */
function allocationSummary(wave) {
  const perOrder = new Map(wave.orderNumbers.map(n => [n, { order_number: n, needed: 0, allocated: 0, lines: [] }]));
  for (const entry of wave.pickList || []) {
    for (const line of entry.lines) {
      const o = perOrder.get(line.order_number);
      if (!o) continue;
      o.needed += line.needed;
      o.allocated += line.allocated;
      o.lines.push({ sku: entry.sku, description: entry.description, needed: line.needed, allocated: line.allocated });
    }
  }
  return [...perOrder.values()].map(o => ({ ...o, status: o.allocated >= o.needed ? (o.allocated === o.needed ? 'complete' : 'over') : 'short' }));
}

/**
 * The ONLY seam into a host app's real order/state records. For every
 * (order, sku, allocatedQty > 0) triple, calls `applyFn(order_number, sku,
 * qty)` so the host can add it into that order's real scanned state exactly
 * as if it had been scanned individually — no order/state shape is assumed
 * here. Returns the number of (order, sku) lines applied.
 * @param {object} wave
 * @param {(order_number:string, sku:string, qty:number) => void} applyFn
 */
function applyWaveToOrderStates(wave, applyFn) {
  let applied = 0;
  for (const entry of wave.pickList || []) {
    for (const line of entry.lines) {
      if (line.allocated > 0) {
        applyFn(line.order_number, entry.sku, line.allocated);
        applied++;
      }
    }
  }
  return applied;
}

module.exports = {
  buildWavePickList,
  createWave,
  findPickEntry,
  recordPickScan,
  autoAllocate,
  adjustAllocation,
  isFullyScanned,
  isFullyAllocated,
  allocationSummary,
  applyWaveToOrderStates,
};
