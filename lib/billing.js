'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  3PL client billing — rate cards + invoice computation (PURE, unit-testable).
//
//  A 3PL charges each client for the work done on their behalf. This module
//  turns a client's RATE CARD (which fees apply + the rate) plus a set of
//  metered METRICS for a period into an invoice (line items + total). It's
//  pure — no db, no fs — so server.js gathers the metrics from the audit log /
//  inbound records / stock snapshots and this file just does the arithmetic.
//
//  Rate card shape (stored in db.rateCards[]):
//    { client, currency, charges: [ { id, type, rate, label? } ] }
//
//  Charge types and the metric each one bills on:
//    per_order            → metrics.orders        (completed orders)
//    per_line             → metrics.lines         (order line-items, unique SKU)
//    per_unit             → metrics.units         (pieces shipped)
//    per_carton           → metrics.cartons       (cartons shipped)
//    inbound_per_unit     → metrics.inboundUnits  (units received)
//    storage_per_unit_day → metrics.storageUnitDays (Σ on-hand units × days)
//    monthly_flat         → metrics.months        (whole months in the period)
// ─────────────────────────────────────────────────────────────────────────────

const CHARGE_TYPES = {
  per_order:            { metric: 'orders',         label: 'Order handling',   unit: 'order' },
  per_line:             { metric: 'lines',          label: 'Order lines',      unit: 'line' },
  per_unit:             { metric: 'units',          label: 'Units picked',     unit: 'unit' },
  per_carton:           { metric: 'cartons',        label: 'Cartons packed',   unit: 'carton' },
  inbound_per_unit:     { metric: 'inboundUnits',   label: 'Inbound receiving', unit: 'unit' },
  storage_per_unit_day: { metric: 'storageUnitDays', label: 'Storage',         unit: 'unit-day' },
  monthly_flat:         { metric: 'months',         label: 'Monthly fee',      unit: 'month' },
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Compute an invoice from a rate card + already-gathered metrics.
// metrics: { orders, lines, units, cartons, inboundUnits, storageUnitDays, months }
function computeInvoice(rateCard, metrics = {}) {
  const currency = (rateCard && rateCard.currency) || 'SGD';
  const charges = (rateCard && Array.isArray(rateCard.charges)) ? rateCard.charges : [];
  const lines = [];
  for (const ch of charges) {
    const def = CHARGE_TYPES[ch.type];
    if (!def) continue;                       // unknown charge type — skip
    const rate = Number(ch.rate) || 0;
    const qty = Number(metrics[def.metric]) || 0;
    if (qty === 0 && rate === 0) continue;    // nothing to bill
    const amount = round2(qty * rate);
    lines.push({
      type: ch.type,
      label: ch.label || def.label,
      unit: def.unit,
      qty: round2(qty),
      rate: round2(rate),
      amount,
    });
  }
  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  return { currency, lines, total };
}

// Validate + normalise a rate card coming from the UI/API.
function normalizeRateCard(input = {}) {
  const client = String(input.client || '').trim();
  if (!client) throw new Error('client is required');
  const currency = String(input.currency || 'SGD').trim().toUpperCase().slice(0, 8) || 'SGD';
  const charges = (Array.isArray(input.charges) ? input.charges : [])
    .filter(c => CHARGE_TYPES[c.type])
    .map(c => ({
      id: String(c.id || (c.type + '_' + Math.abs(hashStr(c.type + (c.label || ''))))).slice(0, 40),
      type: c.type,
      rate: round2(c.rate),
      label: String(c.label || CHARGE_TYPES[c.type].label).slice(0, 60),
    }));
  return { client, currency, charges };
}

// Tiny deterministic hash (no Math.random — keeps ids stable/testable).
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}

module.exports = { CHARGE_TYPES, computeInvoice, normalizeRateCard, round2 };
