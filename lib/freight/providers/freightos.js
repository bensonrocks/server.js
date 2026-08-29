'use strict';

const { requestJson } = require('../http');
const { buildRate, num } = require('../normalize');

// Freightos public marketplace calculator — indicative price ranges and transit
// times, no API key, subject to Freightos' terms (visible attribution and a link
// back to freightos.com wherever the numbers are shown).
//
// Deliberately opt-in via FREIGHTOS_CALCULATOR_URL: the public endpoint path is
// not something we have verified against the live service, and a hard-coded
// guess would fail silently on every call. Set the URL from the Freightos
// developer portal and this provider activates itself.

const CALCULATOR_URL = process.env.FREIGHTOS_CALCULATOR_URL;

const provider = {
  id:   'freightos',
  name: 'Freightos',
  scac: null,
  docs: 'https://developer.freightos.com/apis',
  market: true, // indicative market range, not a bookable carrier quote
  attribution: 'Rates via Freightos — https://www.freightos.com',
  envVars: ['FREIGHTOS_CALCULATOR_URL'],
};

Object.defineProperty(provider, 'configured', { get: () => Boolean(CALCULATOR_URL) });

provider.missing = () => (CALCULATOR_URL ? [] : ['FREIGHTOS_CALCULATOR_URL']);

function buildQuery(lane, { equipment, departureDate }) {
  return {
    origin:      lane.origin,
    destination: lane.destination,
    loadType:    'container',
    quantity:    1,
    containerType: equipment,
    date:        departureDate,
  };
}

// The calculator returns a band rather than a single price. We surface the
// midpoint as `total` for ranking and keep both ends in `priceRange`.
function parseResponse(json, lane, { equipment }) {
  const results = json && (json.results || json.estimates || json.data || (Array.isArray(json) ? json : null));
  if (!Array.isArray(results)) return [];

  return results.map(result => {
    const price = result.price || result.priceEstimate || result;
    const low   = num(price.min != null ? price.min : price.low);
    const high  = num(price.max != null ? price.max : price.high);
    const mid   = low != null && high != null ? (low + high) / 2 : num(price.amount);

    const rate = buildRate(provider, lane, {
      equipment,
      carrier:     'Market range',
      currency:    price.currency || price.currencyCode,
      total:       mid,
      transitDays: result.transitTime || result.transitTimeInDays ||
                   (result.transitTimeRange && result.transitTimeRange.max),
      service:     'Freightos marketplace estimate',
      spot:        true,
    });

    rate.market      = true;
    rate.priceRange  = low != null && high != null ? { low, high } : null;
    rate.attribution = provider.attribution;
    return rate;
  });
}

provider.quote = async function quote(lane, opts = {}) {
  const query = new URLSearchParams(
    Object.entries(buildQuery(lane, opts)).filter(([, v]) => v != null && v !== '')
  );
  const json = await requestJson(`${CALCULATOR_URL}?${query}`);
  return parseResponse(json, lane, opts);
};

provider.buildQuery    = buildQuery;
provider.parseResponse = parseResponse;

module.exports = provider;
