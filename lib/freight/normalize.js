'use strict';

const { describePort } = require('./lanes');

// Every provider returns rates in this shape so the aggregator can rank and
// compare them without knowing anything about the upstream carrier's schema.
//
//   { provider, carrier, scac, origin, destination, equipment, currency,
//     baseRate, surcharges[], total, transitDays, service, validFrom,
//     validTo, spot, fetchedAt, raw? }

function num(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

// Surcharges arrive under wildly different key names per carrier; pull whatever
// looks like a code/name/amount and drop anything we cannot price.
function normalizeSurcharges(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(s => ({
      code:     s.code || s.chargeCode || s.chargeTypeCode || s.type || null,
      name:     s.name || s.chargeName || s.description || s.chargeType || null,
      amount:   num(s.amount != null ? s.amount : s.value != null ? s.value : s.price),
      currency: s.currency || s.currencyCode || null,
    }))
    .filter(s => s.amount != null);
}

function buildRate(provider, lane, fields) {
  const surcharges = normalizeSurcharges(fields.surcharges);
  const baseRate   = num(fields.baseRate);

  // Prefer an explicit all-in total; otherwise derive it from base + surcharges.
  let total = num(fields.total);
  if (total == null && baseRate != null) {
    total = surcharges.reduce((sum, s) => sum + s.amount, baseRate);
  }

  return {
    provider:    provider.id,
    carrier:     fields.carrier || provider.name,
    scac:        fields.scac || provider.scac || null,
    origin:      describePort(lane.origin),
    destination: describePort(lane.destination),
    equipment:   fields.equipment || null,
    currency:    fields.currency || 'USD',
    baseRate,
    surcharges,
    total,
    transitDays: num(fields.transitDays),
    service:     fields.service || null,
    validFrom:   isoDate(fields.validFrom),
    validTo:     isoDate(fields.validTo),
    spot:        fields.spot !== false,
    fetchedAt:   new Date().toISOString(),
    ...(fields.raw !== undefined ? { raw: fields.raw } : {}),
  };
}

// A rate is only useful to compare if we know what it costs and in what currency.
function isQuotable(rate) {
  return rate && rate.total != null && rate.total > 0 && !!rate.currency;
}

module.exports = { num, isoDate, normalizeSurcharges, buildRate, isQuotable };
