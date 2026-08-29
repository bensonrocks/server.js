'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const lanes     = require('../lib/freight/lanes');
const normalize = require('../lib/freight/normalize');
const freight   = require('../lib/freight');

const cmacgm    = require('../lib/freight/providers/cmacgm');
const maersk    = require('../lib/freight/providers/maersk');
const hapag     = require('../lib/freight/providers/hapag');
const freightos = require('../lib/freight/providers/freightos');

const LANE = { origin: 'SGSIN', destination: 'MYPKG' };
const OPTS = { equipment: '40GP', departureDate: '2026-09-05' };

test('resolvePort accepts codes, names and aliases', () => {
  assert.equal(lanes.resolvePort('MYPKG'), 'MYPKG');
  assert.equal(lanes.resolvePort('Port Klang'), 'MYPKG');
  assert.equal(lanes.resolvePort('westport'), 'MYPKG');
  assert.equal(lanes.resolvePort('hcmc'), 'VNSGN');
  assert.equal(lanes.resolvePort('nowhere'), null);
});

test('expandLanes covers all SEA ports and never quotes a port against itself', () => {
  const all = lanes.expandLanes({});
  assert.equal(all.length, lanes.SEA_DESTINATIONS.length);
  assert.ok(all.every(l => l.origin === 'SGSIN' && l.destination !== 'SGSIN'));

  const some = lanes.expandLanes({ destination: 'jakarta, laem chabang' });
  assert.deepEqual(some.map(l => l.destination), ['IDJKT', 'THLCH']);

  assert.deepEqual(lanes.expandLanes({ destination: 'singapore' }), []);
  assert.throws(() => lanes.expandLanes({ destination: 'atlantis' }), /Unknown destination/);
});

test('buildRate derives an all-in total from base plus surcharges', () => {
  const rate = normalize.buildRate({ id: 'x', name: 'X' }, LANE, {
    equipment: '40GP',
    baseRate: 800,
    surcharges: [
      { code: 'EFS', amount: 75, currency: 'USD' },
      { code: 'THC', amount: '120.50', currency: 'USD' },
      { code: 'JUNK' }, // no amount — must be dropped, not counted as zero
    ],
  });

  assert.equal(rate.surcharges.length, 2);
  assert.equal(rate.total, 995.5);
  assert.equal(rate.currency, 'USD');
  assert.equal(rate.origin.name, 'Singapore');
  assert.equal(rate.destination.name, 'Port Klang');
});

test('buildRate prefers an explicit total over a derived one', () => {
  const rate = normalize.buildRate({ id: 'x', name: 'X' }, LANE, {
    baseRate: 800, total: 900, surcharges: [{ code: 'EFS', amount: 75 }],
  });
  assert.equal(rate.total, 900);
});

test('isQuotable rejects rates with no price', () => {
  assert.equal(normalize.isQuotable({ total: 500, currency: 'USD' }), true);
  assert.equal(normalize.isQuotable({ total: null, currency: 'USD' }), false);
  assert.equal(normalize.isQuotable({ total: 0, currency: 'USD' }), false);
});

test('CMA CGM parseResponse splits base freight from surcharges', () => {
  const rates = cmacgm.parseResponse({
    quotations: [{
      currency: 'USD',
      totalAmount: 965,
      transitTime: 3,
      serviceName: 'MALACCA EXPRESS',
      validFrom: '2026-09-01', validTo: '2026-09-30',
      charges: [
        { chargeName: 'Basic Ocean Freight', amount: 820, currency: 'USD' },
        { chargeName: 'Emergency Fuel Surcharge', amount: 75, currency: 'USD' },
        { chargeName: 'Terminal Handling', amount: 70, currency: 'USD' },
      ],
    }],
  }, LANE, OPTS);

  assert.equal(rates.length, 1);
  const [rate] = rates;
  assert.equal(rate.provider, 'cmacgm');
  assert.equal(rate.scac, 'CMDU');
  assert.equal(rate.baseRate, 820);
  assert.equal(rate.total, 965);
  assert.equal(rate.surcharges.length, 2);
  assert.equal(rate.transitDays, 3);
  assert.equal(rate.validTo, '2026-09-30');
});

test('Maersk parseResponse reads the offers envelope', () => {
  const rates = maersk.parseResponse({
    offers: [{
      price: {
        currency: 'USD', basePrice: 780, totalPrice: 910,
        chargeItems: [{ chargeCode: 'BAF', amount: 130, currency: 'USD' }],
      },
      transitTimeInDays: 4,
      productName: 'Maersk Spot',
      validFromDate: '2026-09-01',
    }],
  }, LANE, OPTS);

  assert.equal(rates.length, 1);
  assert.equal(rates[0].carrier, 'Maersk');
  assert.equal(rates[0].baseRate, 780);
  assert.equal(rates[0].total, 910);
  assert.equal(rates[0].transitDays, 4);
  assert.equal(rates[0].service, 'Maersk Spot');
});

test('Hapag parseResponse flags spot products', () => {
  const rates = hapag.parseResponse({
    quotes: [{
      currency: 'USD', baseFreight: 900, totalAmount: 1010,
      quotationType: 'QUICK_QUOTE_SPOT', transitTime: 5,
      charges: [{ code: 'THC', amount: 110, currency: 'USD' }],
    }],
  }, LANE, OPTS);

  assert.equal(rates[0].spot, true);
  assert.equal(rates[0].total, 1010);
  assert.equal(rates[0].scac, 'HLCU');
});

test('Freightos parseResponse midpoints the range and keeps both ends', () => {
  const rates = freightos.parseResponse({
    results: [{ price: { min: 700, max: 1100, currency: 'USD' }, transitTime: 4 }],
  }, LANE, OPTS);

  assert.equal(rates[0].total, 900);
  assert.deepEqual(rates[0].priceRange, { low: 700, high: 1100 });
  assert.equal(rates[0].market, true);
  assert.match(rates[0].attribution, /Freightos/);
});

test('parseResponse tolerates an unexpected payload instead of throwing', () => {
  for (const p of [cmacgm, maersk, hapag, freightos]) {
    assert.deepEqual(p.parseResponse(null, LANE, OPTS), []);
    assert.deepEqual(p.parseResponse({ message: 'no results' }, LANE, OPTS), []);
  }
});

test('rankRates sorts cheapest first, then fastest, nulls last', () => {
  const ranked = freight.rankRates([
    { total: 950, transitDays: 3 },
    { total: null, transitDays: 1 },
    { total: 800, transitDays: 6 },
    { total: 800, transitDays: 2 },
  ]);
  assert.deepEqual(ranked.map(r => [r.total, r.transitDays]), [[800, 2], [800, 6], [950, 3], [null, 1]]);
});

test('getRates fans out over lanes and reports per-provider outcomes', async () => {
  const stub = {
    id: 'stub', name: 'Stub Line', scac: 'STUB', docs: '', configured: true,
    missing: () => [],
    quote: async (lane, opts) => [normalize.buildRate(
      { id: 'stub', name: 'Stub Line', scac: 'STUB' },
      lane,
      { equipment: opts.equipment, currency: 'USD', baseRate: 500, surcharges: [{ code: 'EFS', amount: 75 }] }
    )],
  };
  const failing = {
    id: 'broken', name: 'Broken', configured: true, missing: () => [],
    quote: async () => { throw new Error('upstream 503'); },
  };

  const original = freight.PROVIDERS.splice(0, freight.PROVIDERS.length, stub, failing);
  try {
    freight.clearCache();
    const out = await freight.getRates({ destination: 'MYPKG,IDJKT', equipment: '40gp', departureDate: '2026-09-05' });

    assert.equal(out.lanes.length, 2);
    assert.equal(out.query.equipment, '40GP');
    for (const lane of out.lanes) {
      assert.equal(lane.rates.length, 1);
      assert.equal(lane.cheapest.total, 575);
      const broken = lane.providers.find(p => p.id === 'broken');
      assert.equal(broken.status, 'error');
      assert.match(broken.error, /upstream 503/);
    }

    // Second call must be served from cache.
    const again = await freight.getRates({ destination: 'MYPKG', equipment: '40GP', departureDate: '2026-09-05' });
    assert.equal(again.lanes[0].providers.find(p => p.id === 'stub').cached, true);
  } finally {
    freight.PROVIDERS.splice(0, freight.PROVIDERS.length, ...original);
    freight.clearCache();
  }
});

test('getRates rejects unsupported equipment', async () => {
  await assert.rejects(() => freight.getRates({ equipment: '53FT' }), /Unsupported equipment/);
});

test('getRates warns when nothing is configured', async () => {
  freight.clearCache();
  const out = await freight.getRates({ destination: 'MYPKG' });
  assert.match(out.warnings.join(' '), /No freight providers are configured/);
  assert.ok(out.providers.skipped.length >= 4);
});
