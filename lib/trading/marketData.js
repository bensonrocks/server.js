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
  // encodeURIComponent handles the '=' in symbols like XAUUSD=X
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.yahoo)}?interval=1d&range=120d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    const err = json?.chart?.error;
    throw new Error(`Yahoo Finance no data${err ? ': ' + (err.description || JSON.stringify(err)) : ''}`);
  }
  const ts    = result.timestamp;
  const quote = result.indicators.quote[0];
  const candles = ts
    .map((t, i) => ({
      date:  new Date(t * 1000).toISOString().split('T')[0],
      open:  quote.open[i],
      high:  quote.high[i],
      low:   quote.low[i],
      close: quote.close[i],
    }))
    .filter(c => c.open != null && c.high != null && c.low != null && c.close != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!candles.length) throw new Error('Yahoo Finance returned no valid OHLC candles');
  return candles;
}

// Second fallback: Stooq (no key, returns CSV)
async function _fetchStooq(symbolKey) {
  const stooqSymbols = { GOLD: 'xauusd', SILVER: 'xagusd' };
  const sym = stooqSymbols[symbolKey];
  const url = `https://stooq.com/q/d/l/?s=${sym}&i=d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Stooq ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Stooq returned no data');
  // header: Date,Open,High,Low,Close,Volume
  return lines.slice(1)
    .map(line => {
      const [date, open, high, low, close] = line.split(',');
      return { date, open: +open, high: +high, low: +low, close: +close };
    })
    .filter(c => c.date && !isNaN(c.close))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-120); // keep last 120 days to match Yahoo range
}

// Third fallback: Alpha Vantage FX_DAILY (requires API key, premium plan for XAU/XAG)
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

  // 1. Yahoo Finance — free, no key, real spot prices
  try {
    candles = await _fetchYahoo(symbolKey);
  } catch (yahooErr) {
    // 2. Stooq — free, no key, CSV
    try {
      candles = await _fetchStooq(symbolKey);
    } catch (stooqErr) {
      // 3. Alpha Vantage — requires key
      if (!apiKey) throw new Error(`Market data unavailable. Yahoo: ${yahooErr.message} | Stooq: ${stooqErr.message}`);
      candles = await _fetchAlphaVantage(symbolKey, apiKey);
    }
  }

  writeCache(symbolKey, candles);
  return candles;
}

module.exports = { SYMBOLS, fetchDailyCandles };
