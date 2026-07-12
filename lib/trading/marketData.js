// Fetches daily OHLC candles for metals (quoted as FX pairs against USD) from Alpha Vantage.
// Requires ALPHA_VANTAGE_API_KEY in the environment — get a free key at
// https://www.alphavantage.co/support/#api-key
'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'market-cache');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — avoid burning free-tier rate limits

const ALPHA_VANTAGE_BASE = 'https://www.alphavantage.co/query';

// Alpha Vantage's FX endpoints treat XAU/XAG as currency codes against USD.
const SYMBOLS = {
  GOLD:   { from: 'XAU', to: 'USD', label: 'XAU/USD (Gold)' },
  SILVER: { from: 'XAG', to: 'USD', label: 'XAG/USD (Silver)' },
};

function cachePath(symbolKey) {
  return path.join(CACHE_DIR, `${symbolKey.toLowerCase()}-daily.json`);
}

// maxAgeMs: Infinity reads the cache regardless of age — used as a last-resort
// fallback when the live data source is down (better a stale chart than none).
function readCachedCandles(symbolKey, { maxAgeMs = Infinity } = {}) {
  const file = cachePath(symbolKey);
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readCache(symbolKey) {
  return readCachedCandles(symbolKey, { maxAgeMs: CACHE_TTL_MS });
}

function writeCache(symbolKey, candles) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(symbolKey), JSON.stringify(candles, null, 2));
}

async function fetchDailyCandles(symbolKey, { apiKey, useCache = true } = {}) {
  const symbol = SYMBOLS[symbolKey];
  if (!symbol) throw new Error(`Unknown symbol key: ${symbolKey}`);

  if (useCache) {
    const cached = readCache(symbolKey);
    if (cached) return cached;
  }

  if (!apiKey) {
    throw new Error(
      'Missing Alpha Vantage API key. Set ALPHA_VANTAGE_API_KEY in your environment ' +
      '(free key: https://www.alphavantage.co/support/#api-key).'
    );
  }

  const url = `${ALPHA_VANTAGE_BASE}?function=FX_DAILY&from_symbol=${symbol.from}&to_symbol=${symbol.to}&outputsize=compact&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Alpha Vantage request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();

  if (json['Note']) throw new Error(`Alpha Vantage rate limit: ${json['Note']}`);
  if (json['Error Message']) throw new Error(`Alpha Vantage error: ${json['Error Message']}`);
  if (json['Information']) throw new Error(`Alpha Vantage info: ${json['Information']}`);

  const series = json['Time Series FX (Daily)'];
  if (!series) throw new Error(`Unexpected Alpha Vantage response shape for ${symbolKey}`);

  const candles = Object.entries(series)
    .map(([date, ohlc]) => ({
      date,
      open: parseFloat(ohlc['1. open']),
      high: parseFloat(ohlc['2. high']),
      low: parseFloat(ohlc['3. low']),
      close: parseFloat(ohlc['4. close']),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  writeCache(symbolKey, candles);
  return candles;
}

module.exports = { SYMBOLS, fetchDailyCandles, readCachedCandles };
