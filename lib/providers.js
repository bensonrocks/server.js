'use strict';

// NImbustrade's global fulfillment network — the 3PL/4PL partners CirroSys
// transmits client orders to. Each entry is a distribution center capable of
// receiving, processing and shipping orders on the client's behalf.
const PROVIDERS = [
  { id: 'fhu-mx',      name: 'FHU Mexico',        country: 'MX', countryName: 'Mexico',         region: 'LATAM',         dc: 'Guadalajara DC', code: 'GDL1' },
  { id: 'fhu-us',      name: 'FHU USA',            country: 'US', countryName: 'United States',  region: 'North America', dc: 'Dallas DC',       code: 'DFW1' },
  { id: 'fhu-ca',      name: 'FHU Canada',         country: 'CA', countryName: 'Canada',          region: 'North America', dc: 'Toronto DC',      code: 'YYZ1' },
  { id: 'nimbus-eu',   name: 'Nimbus Europe Hub',  country: 'NL', countryName: 'Netherlands',     region: 'Europe',        dc: 'Rotterdam DC',    code: 'RTM1' },
  { id: 'nimbus-uk',   name: 'Nimbus UK Hub',      country: 'GB', countryName: 'United Kingdom',  region: 'Europe',        dc: 'Manchester DC',   code: 'MAN1' },
  { id: 'nimbus-apac', name: 'Nimbus APAC Hub',    country: 'SG', countryName: 'Singapore',       region: 'Asia-Pacific',  dc: 'Singapore DC',    code: 'SIN1' },
  { id: 'nimbus-au',   name: 'Nimbus Oceania Hub', country: 'AU', countryName: 'Australia',       region: 'Oceania',       dc: 'Sydney DC',       code: 'SYD1' },
];

// Countries without a dedicated DC are routed to the nearest regional hub.
const REGION_FALLBACK = {
  default: 'fhu-us',
  LATAM: 'fhu-mx',
  'North America': 'fhu-us',
  Europe: 'nimbus-eu',
  'Asia-Pacific': 'nimbus-apac',
  Oceania: 'nimbus-au',
};

const COUNTRY_REGION = {
  MX: 'LATAM', US: 'North America', CA: 'North America',
  NL: 'Europe', GB: 'Europe', DE: 'Europe', FR: 'Europe', ES: 'Europe', IT: 'Europe',
  SG: 'Asia-Pacific', JP: 'Asia-Pacific', CN: 'Asia-Pacific', IN: 'Asia-Pacific', KR: 'Asia-Pacific',
  AU: 'Oceania', NZ: 'Oceania',
};

function findById(id) {
  return PROVIDERS.find(p => p.id === id) || null;
}

// Assigns the destination country to a DC in the network.
function routeOrder(destinationCountry) {
  const country = String(destinationCountry || '').toUpperCase().trim();
  const direct = PROVIDERS.find(p => p.country === country);
  if (direct) return direct;

  const region = COUNTRY_REGION[country];
  const fallbackId = (region && REGION_FALLBACK[region]) || REGION_FALLBACK.default;
  return findById(fallbackId);
}

module.exports = { PROVIDERS, findById, routeOrder };
