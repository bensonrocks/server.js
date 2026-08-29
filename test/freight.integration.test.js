'use strict';

// Exercises the real HTTP path — OAuth token exchange, request building,
// response parsing, caching — against a local stub standing in for a carrier.
// Nothing here reaches the internet.

const test   = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');

let server, calls;

test.before(async () => {
  calls = { token: 0, quote: 0, lastAuth: null, lastBody: null };

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (req.url.startsWith('/token')) {
        calls.token++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'stub-token-123', expires_in: 3600 }));
      }
      if (req.url.startsWith('/quote')) {
        calls.quote++;
        calls.lastAuth = req.headers.authorization;
        calls.lastBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          quotations: [{
            currency: 'USD', totalAmount: 965, transitTime: 3, serviceName: 'STUB EXPRESS',
            validFrom: '2026-09-01', validTo: '2026-09-30',
            charges: [
              { chargeName: 'Basic Ocean Freight', amount: 820, currency: 'USD' },
              { chargeName: 'Emergency Fuel Surcharge', amount: 75, currency: 'USD' },
              { chargeName: 'Terminal Handling', amount: 70, currency: 'USD' },
            ],
          }],
        }));
      }
      res.writeHead(404).end();
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  process.env.CMACGM_API_BASE      = base;
  process.env.CMACGM_TOKEN_URL     = `${base}/token`;
  process.env.CMACGM_QUOTE_PATH    = '/quote';
  process.env.CMACGM_CLIENT_ID     = 'stub-id';
  process.env.CMACGM_CLIENT_SECRET = 'stub-secret';
});

test.after(() => server && server.close());

test('end-to-end: token exchange, quote, normalize, cache', async () => {
  // Required after the env is set, so the provider picks up the stub endpoints.
  const freight = require('../lib/freight');
  freight.clearCache();
  require('../lib/freight/oauth').clearTokens();

  const out = await freight.getRates({
    destination: 'MYPKG', equipment: '40GP', departureDate: '2026-09-05', providers: 'cmacgm',
  });

  assert.equal(calls.token, 1, 'should fetch exactly one token');
  assert.equal(calls.quote, 1);
  assert.equal(calls.lastAuth, 'Bearer stub-token-123');

  // The request body must carry the resolved UN/LOCODEs and equipment.
  assert.equal(calls.lastBody.placeOfReceipt.unLocationCode, 'SGSIN');
  assert.equal(calls.lastBody.placeOfDelivery.unLocationCode, 'MYPKG');
  assert.equal(calls.lastBody.containers[0].isoSizeType, '40GP');
  assert.equal(calls.lastBody.departureDate, '2026-09-05');

  const lane = out.lanes[0];
  assert.equal(lane.destination.name, 'Port Klang');
  assert.equal(lane.rates.length, 1);
  assert.equal(lane.cheapest.total, 965);
  assert.equal(lane.cheapest.baseRate, 820);
  assert.equal(lane.cheapest.surcharges.length, 2);
  assert.equal(lane.cheapest.carrier, 'CMA CGM');
  assert.equal(lane.providers[0].status, 'ok');

  // Repeat call is cached, and the cached token is reused.
  const again = await freight.getRates({
    destination: 'MYPKG', equipment: '40GP', departureDate: '2026-09-05', providers: 'cmacgm',
  });
  assert.equal(calls.quote, 1, 'second call must not hit the network');
  assert.equal(again.lanes[0].providers[0].cached, true);

  // --refresh bypasses the cache but still reuses the unexpired token.
  await freight.getRates({
    destination: 'MYPKG', equipment: '40GP', departureDate: '2026-09-05', providers: 'cmacgm', refresh: true,
  });
  assert.equal(calls.quote, 2);
  assert.equal(calls.token, 1, 'token should still be cached');

  freight.clearCache();
});

test('upstream failure is reported per provider, not thrown', async () => {
  // Point the provider at a port nothing is listening on, then re-require it so
  // the module-level endpoint constants pick up the dead address.
  const deadBase = 'http://127.0.0.1:1';
  process.env.CMACGM_API_BASE   = deadBase;
  process.env.CMACGM_TOKEN_URL  = `${deadBase}/token`;
  delete require.cache[require.resolve('../lib/freight/providers/cmacgm')];
  delete require.cache[require.resolve('../lib/freight')];

  const freight = require('../lib/freight');
  freight.clearCache();
  require('../lib/freight/oauth').clearTokens();

  const out = await freight.getRates({
    destination: 'IDJKT', equipment: '40GP', departureDate: '2026-09-05', providers: 'cmacgm',
  });

  const [entry] = out.lanes;
  assert.equal(entry.rates.length, 0);
  assert.equal(entry.cheapest, null);

  const status = entry.providers.find(p => p.id === 'cmacgm');
  assert.equal(status.status, 'error');
  assert.ok(status.error, 'the upstream error message should be surfaced');

  freight.clearCache();
});
