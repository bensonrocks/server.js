# Freight rates: Singapore → South East Asia

Fetches container rates on the Singapore export lanes from carrier APIs, normalizes
them into one shape, and ranks them cheapest-first.

## Why these providers

No free feed publishes Singapore-origin lane rates as *market* data. Drewry's
Intra-Asia Container Index is North-Asia-origin and the Freightos Baltic Index has
no intra-SEA lane, so neither can price SGSIN → MYPKG. What is free is the carriers'
own quotation APIs — you get your rates rather than the market's, which is what you
need for quoting anyway.

| Provider | What it returns | Cost |
|---|---|---|
| CMA CGM | Bookable quotes (DCSA Quotation API) | Free portal registration |
| Maersk | Offers / Spot | APIs published free; rate endpoints need customer onboarding |
| Hapag-Lloyd | Quick Quotes + Quick Quotes Spot | Free portal registration |
| Freightos | Indicative market price range | No API key; requires visible attribution |

CMA CGM and Maersk run the heaviest intra-Asia feeder networks out of Singapore, so
they give the best coverage on these lanes.

## Configuration

Set whichever you have — unconfigured providers are skipped, never fatal.

```sh
# CMA CGM — https://api-portal.cma-cgm.com/
CMACGM_CLIENT_ID=
CMACGM_CLIENT_SECRET=
CMACGM_KEY_ID=              # optional portal subscription key

# Maersk — https://developer.maersk.com/
MAERSK_CONSUMER_KEY=        # or the OAuth pair below
MAERSK_CLIENT_ID=
MAERSK_CLIENT_SECRET=

# Hapag-Lloyd — https://api-portal.hlag.com/products/portfolio
HAPAG_CLIENT_ID=
HAPAG_CLIENT_SECRET=

# Freightos public calculator — set the endpoint from the developer portal
FREIGHTOS_CALCULATOR_URL=

# Server route guard (required to expose /api/freight/*)
FREIGHT_API_KEY=

# Optional tuning
FREIGHT_CACHE_TTL_MS=900000   # 15 min
FREIGHT_TIMEOUT_MS=12000
FREIGHT_CONCURRENCY=6
```

Every endpoint path is env-overridable (`CMACGM_QUOTE_PATH`, `MAERSK_OFFERS_PATH`,
`HAPAG_QUOTE_PATH`, and the matching `*_API_BASE` / `*_TOKEN_URL`) so a portal
version bump is a config change, not a code change.

## CLI

```sh
npm run freight -- --status                              # what is wired up
npm run freight -- --to "port klang,jakarta"             # specific lanes
npm run freight -- --to all --equipment 40HC             # every SEA destination
npm run freight -- --to VNSGN --date 2026-09-15 --json   # machine-readable
npm run freight -- --refresh                             # bypass the cache
```

Ports resolve from codes, names or aliases: `MYPKG`, `Port Klang`, `westport`,
`hcmc` all work.

## HTTP API

Both routes require `FREIGHT_API_KEY`, passed as an `X-Freight-Key` header or a
`?key=` query param. Key-guarded rather than subscriber-guarded because these calls
burn carrier API quota.

```
GET /api/freight/status
GET /api/freight/rates?destination=MYPKG,IDJKT&equipment=40GP&date=2026-09-15
```

`destination` accepts `all` (default), a single port, or a comma list.
`providers` restricts the fan-out, e.g. `providers=cmacgm,maersk`.

### Response

```jsonc
{
  "ok": true,
  "query":  { "origin": "SGSIN", "destination": "MYPKG", "equipment": "40GP", "departureDate": "2026-09-05" },
  "lanes": [{
    "origin":      { "code": "SGSIN", "name": "Singapore",  "country": "SG" },
    "destination": { "code": "MYPKG", "name": "Port Klang", "country": "MY" },
    "rates": [{
      "provider": "cmacgm", "carrier": "CMA CGM", "scac": "CMDU",
      "equipment": "40GP", "currency": "USD",
      "baseRate": 820,
      "surcharges": [{ "code": null, "name": "Emergency Fuel Surcharge", "amount": 75, "currency": "USD" }],
      "total": 965, "transitDays": 2, "service": "SEA FEEDER",
      "validFrom": "2026-09-01", "validTo": "2026-09-30", "spot": true
    }],
    "cheapest": { "...": "cheapest bookable rate, market estimates excluded" },
    "providers": [{ "id": "cmacgm", "status": "ok", "count": 1, "cached": false }]
  }],
  "providers": { "active": [], "skipped": [] },
  "warnings": []
}
```

`total` is the all-in figure — an explicit carrier total when given, otherwise base
plus surcharges. Rates without a usable price are dropped before ranking.
Freightos rows carry `market: true` and a `priceRange`, and are excluded from
`cheapest` so a market estimate never masquerades as a bookable rate.

## Behaviour worth knowing

- **Failure is per-provider.** One carrier erroring never fails the request; the
  error lands in that lane's `providers[]` entry.
- **Caching** is in-memory, keyed on provider + lane + equipment + date, 15 min
  by default. It resets on restart.
- **Concurrency** is capped at 6 so a 13-lane × 4-provider fan-out does not open
  50 sockets at once.

## Verification status

The normalization, ranking, caching, OAuth token exchange and HTTP plumbing are
covered by `npm test`, including an integration test that runs the full request
path against a local stub carrier.

**The per-carrier request and response field mappings have not been exercised
against live credentials.** Endpoint paths and auth header names follow each
portal's documented conventions but are unverified. Expect to adjust
`buildQuery`/`buildBody` and `parseResponse` in the relevant provider once you
have a key — they are exported specifically so you can assert against a real
payload without touching the rest of the stack.
