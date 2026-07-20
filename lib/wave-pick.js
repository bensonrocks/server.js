'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Wave picking — "consolidated pick, then sort" (portable core module)
//
// A wave groups 2+ already-uploaded orders so a packer can pick every line's
// TOTAL quantity across the whole wave in one pass (SKU-123 x 47 for the
// whole wave, instead of picking it separately for 12 orders), then a
// sort/allocate step divides the pile back into each order's required
// quantity before the packer completes each order through the normal
// single-order flow.
//
// PICKING IS PAPER-DRIVEN, NOT SCAN-DRIVEN: the pick list defaults every
// line's picked quantity to its full needed amount the moment the wave is
// created — a packer takes the printed pick list onto the floor and only
// needs to come back to the screen to correct a line DOWN if something was
// actually short. There's no "scan each SKU to build up a running total"
// step; `setPickQty` sets a line's picked quantity directly (an editable
// number, not an accumulator).
//
// This file has ZERO dependencies on IDEALONE's db shape, Express, or any
// order/state schema — every function takes plain data in and returns plain
// data out. The ONE seam that talks to a host app's real order/state records
// is `applyWaveToOrderStates`, which takes a callback instead of touching any
// host object directly. Copy this file verbatim into another codebase (e.g.
// IDEALOMS) and wire it to that host's own order store the same way.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a consolidated pick list from a set of orders, grouped by BIN
 * LOCATION first, then SKU — a packer physically stands at one location and
 * picks everything needed from it before moving on, so the same SKU stored
 * in two different bins must stay two separate pick-list entries (each with
 * its own needed-per-order breakdown), never silently summed together.
 * Orders/items with no location (host has no location data, or a legacy
 * upload) fall back to grouping by SKU alone — fully backward compatible.
 * @param {Array<{order_number:string, items:Array<{sku:string, description?:string, qty:number, location?:string}>}>} orders
 * @returns {Array<{sku, location, description, totalQty, scannedQty:0, lines:Array<{order_number, needed, allocated:0}>}>}
 *          sorted by location, then sku.
 */
function buildWavePickList(orders) {
  const byKey = new Map();
  for (const order of orders || []) {
    const orderNumber = order.order_number;
    for (const item of order.items || []) {
      const sku = String(item.sku || '').trim();
      if (!sku) continue;
      const qty = Number(item.qty) || 0;
      const location = item.location ? String(item.location).trim() : '';
      const key = `${location}::${sku}`;
      if (!byKey.has(key)) {
        byKey.set(key, { sku, location: location || null, description: item.description || '', totalQty: 0, scannedQty: 0, lines: [] });
      }
      const entry = byKey.get(key);
      if (!entry.description && item.description) entry.description = item.description;
      entry.totalQty += qty;
      const existingLine = entry.lines.find(l => l.order_number === orderNumber);
      if (existingLine) existingLine.needed += qty;
      else entry.lines.push({ order_number: orderNumber, needed: qty, allocated: 0 });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const locCmp = (a.location || '').localeCompare(b.location || '');
    return locCmp !== 0 ? locCmp : a.sku.localeCompare(b.sku);
  });
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

/**
 * All pick-list entries matching a SKU, optionally narrowed to one location.
 * A SKU stocked at only one location returns a single-item array either way
 * — location only needs to be supplied when the SKU exists at 2+ locations
 * in this wave and the caller must disambiguate which one was scanned.
 */
function findPickEntries(wave, sku, location) {
  const matches = (wave.pickList || []).filter(e => e.sku === sku);
  if (!location) return matches;
  return matches.filter(e => (e.location || '') === String(location).trim());
}

// Back-compat single-entry lookup (used by adjustAllocation below) — same
// location-aware matching, just unwrapped to the first/only result.
function findPickEntry(wave, sku, location) {
  const matches = findPickEntries(wave, sku, location);
  return matches.length === 1 ? matches[0] : (matches[0] || null);
}

/**
 * Set one pick-list line's picked quantity directly (not an accumulator —
 * a packer reviewing the printed list types the actual count, or the host
 * pre-fills it to the full needed amount at wave creation). Mutates `wave`.
 * @param {object} meta - `location` disambiguates a SKU stocked at 2+
 *   locations in this wave; omit it when the SKU only has one.
 * @returns {{ok:true, wave, entry} | {ok:false, reason:'not_found'} |
 *           {ok:false, reason:'ambiguous_location', options:Array<{location, needed}>}}
 */
function setPickQty(wave, sku, qty, meta = {}) {
  const matches = findPickEntries(wave, sku, meta.location);
  if (matches.length === 0) return { ok: false, reason: 'not_found' };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_location',
      options: matches.map(e => ({ location: e.location, needed: e.totalQty, scanned: e.scannedQty })),
    };
  }
  const entry = matches[0];
  entry.scannedQty = Math.max(0, Number(qty) || 0);
  wave.pickScanLog.push({ sku, location: entry.location, qty: entry.scannedQty, at: new Date().toISOString(), by: meta.by || null });
  return { ok: true, wave, entry };
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
 * across all other lines' allocations]. `location` disambiguates a SKU
 * stocked at 2+ locations in this wave. Returns false if the SKU/location/
 * order combination doesn't exist in the wave.
 */
function adjustAllocation(wave, sku, orderNumber, newQty, location) {
  const entry = findPickEntry(wave, sku, location);
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
      o.lines.push({ sku: entry.sku, location: entry.location, description: entry.description, needed: line.needed, allocated: line.allocated });
    }
  }
  return [...perOrder.values()].map(o => ({ ...o, status: o.allocated >= o.needed ? (o.allocated === o.needed ? 'complete' : 'over') : 'short' }));
}

/**
 * The ONLY seam into a host app's real order/state records. For every
 * (order, sku, allocatedQty > 0) triple, calls `applyFn(order_number, sku,
 * qty, location)` so the host can add it into that order's real scanned
 * state exactly as if it had been scanned individually — no order/state
 * shape is assumed here (the 4th arg is purely informational for a host
 * that wants to log which bin it came from; a 3-arg callback still works
 * fine, JS ignores the extra argument). Returns the number of lines applied
 * — note this may be MORE than the number of distinct SKUs, since one SKU
 * split across locations produces one line per location per order.
 * @param {object} wave
 * @param {(order_number:string, sku:string, qty:number, location:?string) => void} applyFn
 */
function applyWaveToOrderStates(wave, applyFn) {
  let applied = 0;
  for (const entry of wave.pickList || []) {
    for (const line of entry.lines) {
      if (line.allocated > 0) {
        applyFn(line.order_number, entry.sku, line.allocated, entry.location);
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
  findPickEntries,
  setPickQty,
  autoAllocate,
  adjustAllocation,
  isFullyScanned,
  isFullyAllocated,
  allocationSummary,
  applyWaveToOrderStates,
};
