'use strict';

// The real negotiated fee schedule issued to BWL Online, exactly as supplied
// by NimbusTrade's account team — never invented, never demo data. Kept
// separate from seed.js (which generates fictional order/inventory history)
// so real business figures are never mixed with synthetic data in one file.

const db = require('./db');
const store = require('./store');

const CLIENT_ID = 'bwl';

const BWL_RATE_CARD = {
  scope: 'Multi-market omnichannel fulfilment programme covering the United States, Canada, Mexico, United Arab Emirates and United Kingdom.',
  billingNote: 'All rates quoted in United States Dollars. Charges apply per market and are billed monthly in arrears against verified activity from the warehouse management system. Rates below cover order fulfilment, handling and domestic delivery only; international freight, customs entry and import duties are quoted and invoiced separately.',
  sections: [
    {
      title: 'Order fulfilment',
      note: 'Tier determined by orders despatched per market per calendar month. Tier is assessed monthly and applied retrospectively to the whole month once a threshold is met.',
      columns: ['Service', 'Volume tier (orders/month)', 'Rate (USD)'],
      rows: [
        ['Order fulfilment — first item', '0 – 500', '7.13 per order'],
        ['Order fulfilment — first item', '501 – 1,000', '6.00 per order'],
        ['Order fulfilment — first item', '1,001 – 5,000', '4.75 per order'],
        ['Order fulfilment — first item', '5,001 – 10,000', '4.25 per order'],
        ['Additional item pick', '0 – 500', '1.75 per item'],
        ['Additional item pick', '501 – 1,000', '1.13 per item'],
        ['Additional item pick', '1,001 – 5,000', '0.88 per item'],
        ['Compliance labelling', 'All volumes', '1.25 per label'],
        ['Marketing insert handling', 'All volumes', '0.63 per insert'],
        ['B2B carton pick & despatch', 'All volumes', '7.13 per carton'],
      ],
    },
    {
      title: 'Domestic delivery',
      note: 'Managed domestic carrier service including carrier selection, rate management, insurance, tracking and claims handling. Banded on despatch weight of the packed order.',
      columns: ['Service', 'Despatch weight band', 'Rate (USD)'],
      rows: [
        ['Domestic delivery — standard', 'Up to 2.00 kg', '15.00 per order'],
        ['Domestic delivery — standard', '2.01 – 5.00 kg', '18.50 per order'],
        ['Domestic delivery — standard', '5.01 – 10.00 kg', '24.00 per order'],
        ['Domestic delivery — standard', '10.01 – 20.00 kg', '32.00 per order'],
        ['Domestic delivery — remote area', 'All bands', '+ 8.50 per order'],
        ['Redelivery / address amendment', 'Post-despatch', '12.00 per order'],
      ],
    },
    {
      title: 'Inbound handling & storage',
      columns: ['Service', 'Basis', 'Rate (USD)'],
      rows: [
        ['Inbound receiving', 'Per purchase order / ASN', '27.50'],
        ['Pallet receiving & allocation', 'Per pallet', '16.25'],
        ['Container devanning — 20 ft', 'Per container', '725.00'],
        ['Container devanning — 40 ft', 'Per container', '975.00'],
        ['Pallet storage — standard', 'Per pallet per month, 0 – 100', '86.25'],
        ['Pallet storage — standard', 'Per pallet per month, 101 – 250', '67.50'],
        ['Pallet storage — oversize', 'Per pallet per month', '103.50'],
        ['Warehouse management system', 'Per market per month', '247.50'],
      ],
    },
    {
      title: 'Returns & value-added services',
      columns: ['Service', 'Basis', 'Rate (USD)'],
      rows: [
        ['Return processing', 'Per order received', '10.00'],
        ['Return inspection & restock', 'Per item', '4.63'],
        ['Repacking & kitting', 'Per labour hour', '110.00'],
        ['Urgent / out-of-cycle project', 'Per labour hour', '137.50'],
        ['Stock count — cycle', 'Per count, scheduled', 'Included'],
        ['Stock count — full physical', 'Per count', 'Quoted on request'],
      ],
    },
  ],
  indicative: {
    title: 'Indicative monthly value at current volumes',
    note: 'Order fulfilment and domestic delivery only. Excludes storage, warehouse management system, inbound handling, international freight and duties.',
    columns: ['Market', 'Orders per month', 'Indicative monthly (USD)'],
    rows: [
      ['United States', '150', '3,769.50'],
      ['Canada', '592', '13,840.96'],
      ['Mexico', '80', '2,010.40'],
      ['United Arab Emirates', '50', '1,256.50'],
      ['United Kingdom', '50', '1,256.50'],
    ],
    total: ['Total', '922', '22,133.86'],
    footnote: 'Modelled on an average order of two items, one compliance label and a despatch weight of 1.80 kg. Canada priced at the 501 – 1,000 tier; all other markets at the 0 – 500 tier.',
  },
  terms: [
    'Rates are held firm for twelve months from commencement, subject to a review should despatch volumes vary by more than thirty per cent from the indicative figures above.',
    'Volume tiers are assessed per market. Aggregate volume across markets is reviewed quarterly and the benefit of any network-level tier improvement is passed through.',
    'International freight, customs brokerage, import duties and regulatory filing fees are quoted separately and invoiced at cost, itemised.',
    'Storage is charged on pallet positions occupied at month end. Partial months are pro-rated daily.',
    'All rates are exclusive of applicable local taxes. NimbusTrade Solutions Pte Ltd is not GST-registered; supplies to overseas clients are zero-rated.',
    'Invoicing is monthly in arrears. Payment terms thirty days from invoice date.',
    'Fulfilment is executed through an appointed warehouse network under contract to NimbusTrade Solutions. Network composition is commercially confidential.',
  ],
};

// Idempotent — only inserts if BWL has no rate card yet, so re-running this
// (e.g. on every boot of a real deployment) never clobbers a rate card staff
// have since edited via the admin flow.
function seedBWLRateCard() {
  const existing = db.prepare('SELECT id FROM nt_rate_cards WHERE client_id = ?').get(CLIENT_ID);
  if (existing) return { alreadySeeded: true };

  store.upsertRateCard(CLIENT_ID, {
    currency: 'USD',
    preparedBy: 'Benson Xu',
    preparedTitle: 'Principal Consultant · NimbusTrade Solutions Pte Ltd',
    issuedDate: '2026-07-30',
    data: BWL_RATE_CARD,
  });
  return { alreadySeeded: false };
}

// Same figures as the "Order fulfilment" table above, structured for
// calculation instead of display, so a live estimate can be run against the
// exact tiers in the printed schedule.
const ORDER_FULFILMENT_TIERS = [
  { min: 0, max: 500, firstItemRate: 7.13, additionalItemRate: 1.75 },
  { min: 501, max: 1000, firstItemRate: 6.00, additionalItemRate: 1.13 },
  { min: 1001, max: 5000, firstItemRate: 4.75, additionalItemRate: 0.88 },
  { min: 5001, max: 10000, firstItemRate: 4.25, additionalItemRate: null },
];
// Domestic delivery — standard, up to 2.00 kg: the same despatch-weight
// assumption the printed indicative table's own footnote already uses.
const DOMESTIC_DELIVERY_STANDARD_RATE = 15.00;

function tierFor(orderCount) {
  return ORDER_FULFILMENT_TIERS.find((t) => orderCount >= t.min && orderCount <= t.max)
    || ORDER_FULFILMENT_TIERS[ORDER_FULFILMENT_TIERS.length - 1];
}

// A live counterpart to the static "indicative monthly value" table — built
// from the client's actual order data for the current running month (real
// order counts and real item quantities), run through the real tiered
// schedule above. The static table models assumed volumes; this shows what
// the schedule actually works out to at what's really happening right now.
function computeLiveIndicative(clientId) {
  const months = store.getMonthlyBreakdown(clientId);
  if (!months.length) return null;
  const month = months[months.length - 1].month;

  const rows = db.prepare(`
    SELECT country_name AS countryName, COUNT(*) AS orders, SUM(qty) AS qty,
           SUM(CASE WHEN status != 'dropped' THEN 1 ELSE 0 END) AS despatched
    FROM nt_orders WHERE client_id = ? AND substr(order_date, 1, 7) = ?
    GROUP BY country, country_name
    ORDER BY country_name
  `).all(clientId, month);

  let totalOrders = 0;
  let totalFee = 0;
  const markets = rows.map((r) => {
    const tier = tierFor(r.orders);
    const additionalItems = Math.max(0, r.qty - r.orders);
    const fulfilmentFee = r.orders * tier.firstItemRate + additionalItems * (tier.additionalItemRate || 0);
    const deliveryFee = r.despatched * DOMESTIC_DELIVERY_STANDARD_RATE;
    const total = fulfilmentFee + deliveryFee;
    totalOrders += r.orders;
    totalFee += total;
    return {
      countryName: r.countryName,
      orders: r.orders,
      qty: r.qty,
      avgItemsPerOrder: r.orders ? r.qty / r.orders : 0,
      tierLabel: `${tier.min.toLocaleString()} – ${tier.max.toLocaleString()}`,
      total,
    };
  });

  return { month, markets, totalOrders, totalFee };
}

module.exports = { seedBWLRateCard, computeLiveIndicative, CLIENT_ID };
