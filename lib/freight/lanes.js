'use strict';

// UN/LOCODE reference for the Singapore → South East Asia trades.
// Codes are what the carrier APIs expect; `aliases` let callers pass
// friendly names ("port klang", "hcmc") instead.

const PORTS = {
  SGSIN: { name: 'Singapore',          country: 'SG', aliases: ['singapore', 'psa', 'sin'] },
  MYPKG: { name: 'Port Klang',         country: 'MY', aliases: ['port klang', 'klang', 'westport', 'west port'] },
  MYTPP: { name: 'Tanjung Pelepas',    country: 'MY', aliases: ['tanjung pelepas', 'ptp'] },
  MYPEN: { name: 'Penang',             country: 'MY', aliases: ['penang', 'georgetown'] },
  IDJKT: { name: 'Jakarta',            country: 'ID', aliases: ['jakarta', 'tanjung priok', 'priok'] },
  IDSUB: { name: 'Surabaya',           country: 'ID', aliases: ['surabaya', 'tanjung perak'] },
  VNSGN: { name: 'Ho Chi Minh City',   country: 'VN', aliases: ['ho chi minh', 'hcmc', 'saigon', 'cat lai'] },
  VNHPH: { name: 'Haiphong',           country: 'VN', aliases: ['haiphong', 'hai phong'] },
  THLCH: { name: 'Laem Chabang',       country: 'TH', aliases: ['laem chabang', 'lcb'] },
  THBKK: { name: 'Bangkok',            country: 'TH', aliases: ['bangkok', 'klong toey'] },
  PHMNL: { name: 'Manila',             country: 'PH', aliases: ['manila', 'manila north', 'manila south'] },
  KHSHV: { name: 'Sihanoukville',      country: 'KH', aliases: ['sihanoukville', 'kompong som'] },
  MMRGN: { name: 'Yangon',             country: 'MM', aliases: ['yangon', 'rangoon'] },
  BNMUA: { name: 'Muara',              country: 'BN', aliases: ['muara', 'brunei'] },
};

const ORIGIN = 'SGSIN';

// Every destination we fan out to when the caller asks for "all" SEA lanes.
const SEA_DESTINATIONS = Object.keys(PORTS).filter(code => code !== ORIGIN);

const EQUIPMENT = ['20GP', '40GP', '40HC', '40RF'];

// Build a lookup of alias → code once at load.
const ALIAS_INDEX = {};
for (const [code, port] of Object.entries(PORTS)) {
  ALIAS_INDEX[code.toLowerCase()] = code;
  ALIAS_INDEX[port.name.toLowerCase()] = code;
  for (const alias of port.aliases) ALIAS_INDEX[alias] = code;
}

// Accepts "MYPKG", "Port Klang", "port klang" → "MYPKG". Returns null if unknown.
function resolvePort(input) {
  if (!input) return null;
  return ALIAS_INDEX[String(input).trim().toLowerCase()] || null;
}

function portName(code) {
  return PORTS[code] ? PORTS[code].name : code;
}

function describePort(code) {
  return { code, name: portName(code), country: PORTS[code] ? PORTS[code].country : null };
}

function isValidEquipment(eq) {
  return EQUIPMENT.includes(String(eq || '').toUpperCase());
}

// Expand a request into the concrete lanes to quote.
// `destination` may be a single port, a comma list, or "all"/undefined for every SEA port.
function expandLanes({ origin = ORIGIN, destination } = {}) {
  const from = resolvePort(origin);
  if (!from) throw new Error(`Unknown origin port: ${origin}`);

  let codes;
  if (!destination || String(destination).toLowerCase() === 'all') {
    codes = SEA_DESTINATIONS.slice();
  } else {
    codes = String(destination)
      .split(',')
      .map(d => {
        const code = resolvePort(d);
        if (!code) throw new Error(`Unknown destination port: ${d.trim()}`);
        return code;
      });
  }

  return codes
    .filter(code => code !== from) // a port cannot quote against itself
    .map(code => ({ origin: from, destination: code }));
}

module.exports = { PORTS, ORIGIN, SEA_DESTINATIONS, EQUIPMENT, resolvePort, portName, describePort, isValidEquipment, expandLanes };
