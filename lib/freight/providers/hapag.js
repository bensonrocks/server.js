'use strict';

const { requestJson } = require('../http');
const { buildRate, num } = require('../normalize');

// Hapag-Lloyd API Portal (api-portal.hlag.com) — Quotation & Booking Engine,
// which exposes Quick Quotes and Quick Quotes Spot. The portal runs on IBM API
// Connect, hence the X-IBM-Client-* headers.

const BASE          = process.env.HAPAG_API_BASE   || 'https://api.hlag.com';
const QUOTE_PATH    = process.env.HAPAG_QUOTE_PATH || '/quotation/v1/quotations';
const CLIENT_ID     = process.env.HAPAG_CLIENT_ID;
const CLIENT_SECRET = process.env.HAPAG_CLIENT_SECRET;

const provider = {
  id:   'hapag',
  name: 'Hapag-Lloyd',
  scac: 'HLCU',
  docs: 'https://api-portal.hlag.com/products/portfolio',
  envVars: ['HAPAG_CLIENT_ID', 'HAPAG_CLIENT_SECRET'],
};

Object.defineProperty(provider, 'configured', {
  get: () => Boolean(CLIENT_ID && CLIENT_SECRET),
});

provider.missing = () => {
  const missing = [];
  if (!CLIENT_ID)     missing.push('HAPAG_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('HAPAG_CLIENT_SECRET');
  return missing;
};

function authHeaders() {
  return { 'X-IBM-Client-Id': CLIENT_ID, 'X-IBM-Client-Secret': CLIENT_SECRET };
}

function buildQuery(lane, { equipment, departureDate }) {
  return {
    origin:        lane.origin,
    destination:   lane.destination,
    containerType: equipment,
    quantity:      1,
    departureDate,
  };
}

function parseResponse(json, lane, { equipment }) {
  const quotes = json && (json.quotations || json.quotes || json.data || (Array.isArray(json) ? json : null));
  if (!Array.isArray(quotes)) return [];

  return quotes.map(quote => {
    const charges = quote.charges || quote.chargeItems || [];
    return buildRate(provider, lane, {
      equipment,
      currency:    quote.currency || quote.currencyCode,
      baseRate:    num(quote.baseFreight != null ? quote.baseFreight : quote.freightAmount),
      total:       num(quote.totalAmount != null ? quote.totalAmount : quote.total),
      surcharges:  charges,
      transitDays: quote.transitTime || quote.transitTimeInDays,
      service:     quote.serviceName || quote.productName,
      validFrom:   quote.validFrom,
      validTo:     quote.validTo || quote.expiryDate,
      spot:        /spot/i.test(quote.quotationType || quote.productName || ''),
    });
  });
}

provider.quote = async function quote(lane, opts = {}) {
  const query = new URLSearchParams(
    Object.entries(buildQuery(lane, opts)).filter(([, v]) => v != null && v !== '')
  );
  const json = await requestJson(`${BASE}${QUOTE_PATH}?${query}`, { headers: authHeaders() });
  return parseResponse(json, lane, opts);
};

provider.buildQuery    = buildQuery;
provider.parseResponse = parseResponse;

module.exports = provider;
