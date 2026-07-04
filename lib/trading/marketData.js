'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR    = path.join(__dirname, '..', '..', 'data', 'market-cache');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const SYMBOLS = {
  GOLD:   { yahoo: 'XAUUSD=X', avFrom: 'XAU', avTo: 'USD', label: 'XAU/USD (Gold)'   },
  SILVER: { yahoo: 'XAGUSD=X', avFrom: 'XAG', avTo: 'USD', label: 'XAG/USD (Silver)' },
};

function cachePath(symbolKey) {
  return path.join(CACHE_DIR, `${symbolKey.toLowerCase()}-daily.json`);
}

function readCache(symbolKey) {
  const file = cachePath(symbolKey);
  if (!fs.existsSync(file)) return null;
  if (Date.now() - fs.statSync(file).mtimeMs > CACHE_TTL_MS) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeCache(symbolKey, candles) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(symbolKey), JSON.stringify(candles, null, 2));
}

// Primary: Yahoo Finance spot price (no API key needed)
async function _fetchYahoo(symbolKey) {
  const sym = SYMBOLS[symbolKey];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym.yahoo}?interval=1d&range=120d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('Unexpected Yahoo Finance response shape');
  const ts    = result.timestamp;
  const quote = result.indicators.quote[0];
  return ts
    .map((t, i) => ({
      date:  new Date(t * 1000).toISOString().split('T')[0],
      open:  quote.open[i],
      high:  quote.high[i],
      low:   quote.low[i],
      close: quote.close[i],
    }))
    .filter(c => c.open != null && c.high != null && c.low != null && c.close != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Fallback: Alpha Vantage FX_DAILY (requires API key, premium plan for XAU/XAG)
async function _fetchAlphaVantage(symbolKey, apiKey) {
  const sym = SYMBOLS[symbolKey];
  const url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${sym.avFrom}&to_symbol=${sym.avTo}&outputsize=compact&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Alpha Vantage ${res.status}`);
  const json = await res.json();
  if (json['Note'])          throw new Error(`Alpha Vantage rate limit: ${json['Note']}`);
  if (json['Error Message']) throw new Error(`Alpha Vantage error: ${json['Error Message']}`);
  if (json['Information'])   throw new Error(`Alpha Vantage info: ${json['Information']}`);
  const series = json['Time Series FX (Daily)'];
  if (!series) throw new Error(`Unexpected Alpha Vantage response for ${symbolKey}`);
  return Object.entries(series)
    .map(([date, o]) => ({
      date,
      open:  parseFloat(o['1. open']),
      high:  parseFloat(o['2. high']),
      low:   parseFloat(o['3. low']),
      close: parseFloat(o['4. close']),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchDailyCandles(symbolKey, { apiKey, useCache = true } = {}) {
  if (!SYMBOLS[symbolKey]) throw new Error(`Unknown symbol key: ${symbolKey}`);

  if (useCache) {
    const cached = readCache(symbolKey);
    if (cached) return cached;
  }

  let candles;

  // Try Yahoo Finance first (free, no key required, real spot prices)
  try {
    candles = await _fetchYahoo(symbolKey);
  } catch (yahooErr) {
    // Fall back to Alpha Vantage if we have a key
    if (!apiKey) throw new Error(`Market data unavailable: ${yahooErr.message}`);
    candles = await _fetchAlphaVantage(symbolKey, apiKey);
  }

  writeCache(symbolKey, candles);
  return candles;
}

module.exports = { SYMBOLS, fetchDailyCandles };
