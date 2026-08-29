'use strict';

const { requestJson } = require('../http');
const { clientCredentialsToken } = require('../oauth');
const { buildRate, num } = require('../normalize');

// Maersk Developer Portal (developer.maersk.com). Maersk publish these APIs at
// no charge, but rate/offer endpoints require onboarding against a customer
// account. Two auth styles are in the wild — a Consumer-Key header on the older
// portal, OAuth2 client-credentials on the newer one — so we support both.
//
// Endpoint paths are env-overridable because the portal versions them and we
// cannot pin a path we have not exercised against a live key.

const BASE         = process.env.MAERSK_API_BASE   || 'https://api.maersk.com';
const OFFERS_PATH  = process.env.MAERSK_OFFERS_PATH || '/offers/v1/offers';
const TOKEN_URL    = process.env.MAERSK_TOKEN_URL  || `${BASE}/oauth2/access_token`;
const CONSUMER_KEY = process.env.MAERSK_CONSUMER_KEY;
const CLIENT_ID    = process.env.MAERSK_CLIENT_ID;
const CLIENT_SECRET= process.env.MAERSK_CLIENT_SECRET;

const provider = {
  id:    'maersk',
  name:  'Maersk',
  scac:  'MAEU',
  docs:  'https://developer.maersk.com/',
  envVars: ['MAERSK_CONSUMER_KEY', 'or MAERSK_CLIENT_ID + MAERSK_CLIENT_SECRET'],
};

Object.defineProperty(provider, 'configured', {
  get: () => Boolean(CONSUMER_KEY || (CLIENT_ID && CLIENT_SECRET)),
});

provider.missing = () =>
  provider.configured ? [] : ['MAERSK_CONSUMER_KEY (or MAERSK_CLIENT_ID + MAERSK_CLIENT_SECRET)'];

async function authHeaders() {
  if (CLIENT_ID && CLIENT_SECRET) {
    const token = await clientCredentialsToken({
      cacheKey: 'maersk', tokenUrl: TOKEN_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    });
    return { Authorization: `Bearer ${token}` };
  }
  return { 'Consumer-Key': CONSUMER_KEY };
}

// Exported so the request shape can be asserted without a live credential.
function buildQuery(lane, { equipment, departureDate }) {
  return {
    collectionOriginCountryCode:      lane.origin.slice(0, 2),
    collectionOriginUNLocationCode:   lane.origin,
    deliveryDestinationCountryCode:   lane.destination.slice(0, 2),
    deliveryDestinationUNLocationCode: lane.destination,
    cargoReadyDate:                   departureDate,
    equipmentType:                    equipment,
    numberOfContainers:               1,
    priceOwner:                       'MAEU',
  };
}

// Maersk nest offers under `offers[]`, each with a price breakdown. Anything we
// cannot find is left null rather than guessed — the aggregator filters those out.
function parseResponse(json, lane, { equipment }) {
  const offers = json && (json.offers || json.data || (Array.isArray(json) ? json : null));
  if (!Array.isArray(offers)) return [];

  return offers.map(offer => {
    const price   = offer.price || offer.pricing || {};
    const charges = price.chargeItems || price.charges || offer.charges || [];
    const transit = offer.transitTime || offer.transitTimeInDays ||
                    (offer.transportSchedule && offer.transportSchedule.transitTime);

    return buildRate(provider, lane, {
      equipment,
      currency:    price.currency || price.currencyCode,
      baseRate:    num(price.basePrice != null ? price.basePrice : price.amount),
      total:       num(price.totalPrice != null ? price.totalPrice : price.total),
      surcharges:  charges,
      transitDays: transit,
      service:     offer.serviceName || offer.productName || (offer.product && offer.product.name),
      validFrom:   offer.validFromDate || price.validFrom,
      validTo:     offer.validToDate   || price.validTo,
      spot:        true,
    });
  });
}

provider.quote = async function quote(lane, opts = {}) {
  const query = new URLSearchParams(
    Object.entries(buildQuery(lane, opts)).filter(([, v]) => v != null && v !== '')
  );
  const url  = `${BASE}${OFFERS_PATH}?${query}`;
  const json = await requestJson(url, { headers: await authHeaders() });
  return parseResponse(json, lane, opts);
};

provider.buildQuery    = buildQuery;
provider.parseResponse = parseResponse;

module.exports = provider;
