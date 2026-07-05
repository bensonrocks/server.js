'use strict';

const { routeOrder } = require('./providers');

const BASE_FEE       = 8.50;   // per order handling fee
const PER_KG_RATE     = 2.25;   // per kg shipping rate
const EXTRA_ITEM_FEE  = 0.60;   // per item beyond the first
const EXPRESS_MULT    = 1.6;    // express service multiplier
const ZONE_SURCHARGE  = {       // cross-border zone surcharge (USD)
  'North America': 0,
  LATAM: 3.00,
  Europe: 6.00,
  'Asia-Pacific': 8.50,
  Oceania: 9.00,
};

function totalWeightKg(items) {
  return items.reduce((sum, it) => sum + (Number(it.weightKg) || 0) * (Number(it.qty) || 1), 0);
}

function totalItemCount(items) {
  return items.reduce((sum, it) => sum + (Number(it.qty) || 1), 0);
}

// Computes the price breakdown for an order. Returns { breakdown[], subtotal, total, currency }.
function computePrice({ destinationCountry, items, serviceLevel }) {
  const provider = routeOrder(destinationCountry);
  const weightKg = totalWeightKg(items);
  const itemCount = totalItemCount(items);
  const zoneSurcharge = ZONE_SURCHARGE[provider?.region] ?? ZONE_SURCHARGE['North America'];

  const breakdown = [
    { label: 'Base handling fee', amount: BASE_FEE },
    { label: `Freight (${weightKg.toFixed(2)} kg × $${PER_KG_RATE.toFixed(2)}/kg)`, amount: weightKg * PER_KG_RATE },
  ];
  if (itemCount > 1) {
    breakdown.push({ label: `Additional items (${itemCount - 1} × $${EXTRA_ITEM_FEE.toFixed(2)})`, amount: (itemCount - 1) * EXTRA_ITEM_FEE });
  }
  if (zoneSurcharge > 0) {
    breakdown.push({ label: `Cross-border zone surcharge (${provider?.region || 'N/A'})`, amount: zoneSurcharge });
  }

  const subtotal = breakdown.reduce((sum, b) => sum + b.amount, 0);
  const isExpress = serviceLevel === 'express';
  let total = subtotal;
  if (isExpress) {
    const expressFee = subtotal * (EXPRESS_MULT - 1);
    breakdown.push({ label: 'Express service uplift (60%)', amount: expressFee });
    total = subtotal + expressFee;
  }

  return {
    breakdown: breakdown.map(b => ({ label: b.label, amount: Math.round(b.amount * 100) / 100 })),
    subtotal: Math.round(subtotal * 100) / 100,
    total: Math.round(total * 100) / 100,
    currency: 'USD',
  };
}

module.exports = { computePrice };
