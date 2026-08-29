'use strict';

const { requestJson } = require('../http');
const { clientCredentialsToken } = require('../oauth');
const { buildRate, num } = require('../normalize');

// CMA CGM API Portal (api-portal.cma-cgm.com). DCSA-aligned REST surface with a
// Quotation API; registration is free but quotes resolve against your own
// account's pricing. CMA CGM carry the heaviest intra-Asia feeder network out of
// Singapore, so this is usually the most complete provider on these lanes.

const BASE          = process.env.CMACGM_API_BASE  || 'https://apis.cma-cgm.net';
const QUOTE_PATH    = process.env.CMACGM_QUOTE_PATH || '/quotation/v1/quotations';
const TOKEN_URL     = process.env.CMACGM_TOKEN_URL || `${BASE}/auth/oauth/v2/token`;
const CLIENT_ID     = process.env.CMACGM_CLIENT_ID;
const CLIENT_SECRET = process.env.CMACGM_CLIENT_SECRET;
const KEY_ID        = process.env.CMACGM_KEY_ID; // portal subscription key

const provider = {
  id:   'cmacgm',
  name: 'CMA CGM',
  scac: 'CMDU',
  docs: 'https://api-portal.cma-cgm.com/',
  envVars: ['CMACGM_CLIENT_ID', 'CMACGM_CLIENT_SECRET', 'CMACGM_KEY_ID (optional)'],
};

Object.defineProperty(provider, 'configured', {
  get: () => Boolean(CLIENT_ID && CLIENT_SECRET),
});

provider.missing = () => {
  const missing = [];
  if (!CLIENT_ID)     missing.push('CMACGM_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('CMACGM_CLIENT_SECRET');
  return missing;
};

async function authHeaders() {
  const token = await clientCredentialsToken({
    cacheKey: 'cmacgm', tokenUrl: TOKEN_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
  });
  return { Authorization: `Bearer ${token}`, ...(KEY_ID ? { KeyId: KEY_ID } : {}) };
}

function buildBody(lane, { equipment, departureDate }) {
  return {
    placeOfReceipt:  { unLocationCode: lane.origin },
    placeOfDelivery: { unLocationCode: lane.destination },
    departureDate,
    shippingMode: 'FCL',
    containers: [{ isoSizeType: equipment, quantity: 1 }],
  };
}

// DCSA-style payloads nest the money under `charges[]` with one line flagged as
// the base freight; everything else is treated as a surcharge.
function parseResponse(json, lane, { equipment }) {
  const quotes = json && (json.quotations || json.quotes || json.data || (Array.isArray(json) ? json : null));
  if (!Array.isArray(quotes)) return [];

  return quotes.map(quote => {
    const charges = quote.charges || quote.chargeItems || [];
    const base    = charges.find(c =>
      /basic ocean|base freight|ocean freight|bas/i.test(c.chargeName || c.chargeType || c.name || '')
    );
    const others  = base ? charges.filter(c => c !== base) : charges;

    return buildRate(provider, lane, {
      equipment,
      currency:    quote.currency || quote.currencyCode || (base && base.currency),
      baseRate:    base ? num(base.amount != null ? base.amount : base.value) : null,
      total:       num(quote.totalAmount != null ? quote.totalAmount : quote.total),
      surcharges:  others,
      transitDays: quote.transitTime || quote.transitTimeInDays,
      service:     quote.serviceName || quote.routingName,
      validFrom:   quote.validFrom || quote.validityStartDate,
      validTo:     quote.validTo   || quote.validityEndDate,
      spot:        true,
    });
  });
}

provider.quote = async function quote(lane, opts = {}) {
  const json = await requestJson(`${BASE}${QUOTE_PATH}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: buildBody(lane, opts),
  });
  return parseResponse(json, lane, opts);
};

provider.buildBody     = buildBody;
provider.parseResponse = parseResponse;

module.exports = provider;
