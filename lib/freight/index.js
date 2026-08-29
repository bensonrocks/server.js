'use strict';

const lanes = require('./lanes');
const { isQuotable } = require('./normalize');

const PROVIDERS = [
  require('./providers/cmacgm'),
  require('./providers/maersk'),
  require('./providers/hapag'),
  require('./providers/freightos'),
];

const CACHE_TTL_MS  = parseInt(process.env.FREIGHT_CACHE_TTL_MS || String(15 * 60 * 1000), 10);
const CONCURRENCY   = parseInt(process.env.FREIGHT_CONCURRENCY || '6', 10);
const DEFAULT_LEAD_DAYS = 7;

const cache = new Map(); // key → { expiresAt, rates }

function cacheKey(providerId, lane, equipment, departureDate) {
  return `${providerId}|${lane.origin}|${lane.destination}|${equipment}|${departureDate}`;
}

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { cache.delete(key); return null; }
  return hit.rates;
}

function writeCache(key, rates) {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, rates });
}

function clearCache() {
  cache.clear();
}

function defaultDepartureDate() {
  const d = new Date();
  d.setDate(d.getDate() + DEFAULT_LEAD_DAYS);
  return d.toISOString().split('T')[0];
}

// Run tasks with a bounded number in flight so a 13-lane fan-out does not open
// 50-odd sockets against the carriers at once.
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

function selectProviders(requested) {
  if (!requested) return PROVIDERS.filter(p => p.configured);
  const wanted = String(requested).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return PROVIDERS.filter(p => wanted.includes(p.id));
}

// Cheapest first, then fastest; rates missing a total sink to the bottom.
function rankRates(rates) {
  return rates.slice().sort((a, b) => {
    if (a.total == null && b.total == null) return 0;
    if (a.total == null) return 1;
    if (b.total == null) return -1;
    if (a.total !== b.total) return a.total - b.total;
    return (a.transitDays ?? Infinity) - (b.transitDays ?? Infinity);
  });
}

async function getRates(options = {}) {
  const {
    origin = lanes.ORIGIN,
    destination,
    equipment = '40GP',
    departureDate = defaultDepartureDate(),
    providers: requestedProviders,
    refresh = false,
    includeRaw = false,
  } = options;

  const equip = String(equipment).toUpperCase();
  if (!lanes.isValidEquipment(equip)) {
    throw new Error(`Unsupported equipment "${equipment}". Expected one of: ${lanes.EQUIPMENT.join(', ')}`);
  }

  const laneList = lanes.expandLanes({ origin, destination });
  const active   = selectProviders(requestedProviders);
  const skipped  = PROVIDERS
    .filter(p => !active.includes(p) && !p.configured)
    .map(p => ({ id: p.id, name: p.name, missing: p.missing(), docs: p.docs }));

  const warnings = [];
  if (!active.length) {
    warnings.push('No freight providers are configured — set carrier API credentials to get live rates.');
  }

  // One task per lane × provider.
  const jobs = [];
  for (const lane of laneList) {
    for (const provider of active) {
      jobs.push({ lane, provider });
    }
  }

  const outcomes = await pool(
    jobs.map(job => async () => {
      const key = cacheKey(job.provider.id, job.lane, equip, departureDate);
      if (!refresh) {
        const cached = readCache(key);
        if (cached) return { ...job, rates: cached, cached: true };
      }
      try {
        const rates = await job.provider.quote(job.lane, {
          equipment: equip, departureDate, includeRaw,
        });
        const usable = rates.filter(isQuotable);
        writeCache(key, usable);
        return { ...job, rates: usable, cached: false };
      } catch (err) {
        return { ...job, rates: [], cached: false, error: err.message };
      }
    }),
    CONCURRENCY
  );

  // Regroup flat outcomes back into one entry per lane.
  const byLane = new Map();
  for (const lane of laneList) {
    byLane.set(`${lane.origin}|${lane.destination}`, {
      origin:      lanes.describePort(lane.origin),
      destination: lanes.describePort(lane.destination),
      rates:       [],
      providers:   [],
    });
  }

  for (const outcome of outcomes) {
    const entry = byLane.get(`${outcome.lane.origin}|${outcome.lane.destination}`);
    entry.rates.push(...outcome.rates);
    entry.providers.push({
      id:     outcome.provider.id,
      status: outcome.error ? 'error' : outcome.rates.length ? 'ok' : 'empty',
      count:  outcome.rates.length,
      cached: outcome.cached,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  const laneResults = [...byLane.values()].map(entry => {
    const ranked   = rankRates(entry.rates);
    const bookable = ranked.filter(r => !r.market);
    return { ...entry, rates: ranked, cheapest: bookable[0] || ranked[0] || null };
  });

  return {
    query: { origin: lanes.resolvePort(origin), destination: destination || 'all', equipment: equip, departureDate },
    fetchedAt: new Date().toISOString(),
    lanes: laneResults,
    providers: {
      active:  active.map(p => ({ id: p.id, name: p.name, market: Boolean(p.market) })),
      skipped,
    },
    warnings,
  };
}

// Configuration report — what is wired up and what is missing, without calling out.
function status() {
  return {
    providers: PROVIDERS.map(p => ({
      id:         p.id,
      name:       p.name,
      scac:       p.scac,
      configured: p.configured,
      missing:    p.missing(),
      market:     Boolean(p.market),
      docs:       p.docs,
    })),
    ports:     Object.keys(lanes.PORTS),
    equipment: lanes.EQUIPMENT,
    cache:     { entries: cache.size, ttlMs: CACHE_TTL_MS },
  };
}

module.exports = { getRates, status, clearCache, rankRates, PROVIDERS, lanes };
