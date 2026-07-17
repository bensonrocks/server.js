'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR    = path.join(__dirname, '..', '..', 'data', 'market-cache');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_CANDLES  = 10;

const SYMBOLS = {
  GOLD:   { avFrom: 'XAU', avTo: 'USD', label: 'XAU/USD (Gold)'   },
  SILVER: { avFrom: 'XAG', avTo: 'USD', label: 'XAG/USD (Silver)' },
};

// Yahoo Finance ticker variants to try in order (futures first — more reliable)
const YAHOO_TICKERS = {
  GOLD:   ['GC=F', 'XAUUSD=X'],
  SILVER: ['SI=F', 'XAGUSD=X'],
};

const STOOQ_SYMBOLS = {
  GOLD:   'xauusd',
  SILVER: 'xagusd',
};

function cachePath(symbolKey) {
  return path.join(CACHE_DIR, `${symbolKey.toLowerCase()}-daily.json`);
}

function readCache(symbolKey) {
  const file = cachePath(symbolKey);
  if (!fs.existsSync(file)) return null;
  if (Date.now() - fs.statSync(file).mtimeMs > CACHE_TTL_MS) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) && data.length >= MIN_CANDLES ? data : null;
  } catch { return null; }
}

function writeCache(symbolKey, candles) {
  if (!candles || candles.length < MIN_CANDLES) return; // never cache empty/bad data
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(symbolKey), JSON.stringify(candles, null, 2));
}

async function _yahooChart(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=120d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    const err = json?.chart?.error;
    throw new Error(`Yahoo no result${err ? ': ' + (err.description || err.code) : ''}`);
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
  if (candles.length < MIN_CANDLES) throw new Error(`Yahoo returned only ${candles.length} candles for ${ticker}`);
  return candles;
}

// Primary: Yahoo Finance (tries futures then spot)
async function _fetchYahoo(symbolKey) {
  const tickers = YAHOO_TICKERS[symbolKey];
  let lastErr;
  for (const ticker of tickers) {
    try { return await _yahooChart(ticker); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Second fallback: Stooq CSV
async function _fetchStooq(symbolKey) {
  const sym = STOOQ_SYMBOLS[symbolKey];
  const url = `https://stooq.com/q/d/l/?s=${sym}&i=d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Stooq ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Stooq returned no data');
  const candles = lines.slice(1)
    .map(line => {
      const [date, open, high, low, close] = line.split(',');
      return { date, open: +open, high: +high, low: +low, close: +close };
    })
    .filter(c => c.date && !isNaN(c.close) && c.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-120);
  if (candles.length < MIN_CANDLES) throw new Error(`Stooq returned only ${candles.length} valid candles`);
  return candles;
}

// Third fallback: Alpha Vantage FX_DAILY
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
  const candles = Object.entries(series)
    .map(([date, o]) => ({
      date,
      open:  parseFloat(o['1. open']),
      high:  parseFloat(o['2. high']),
      low:   parseFloat(o['3. low']),
      close: parseFloat(o['4. close']),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (candles.length < MIN_CANDLES) throw new Error(`Alpha Vantage returned only ${candles.length} candles`);
  return candles;
}

async function fetchDailyCandles(symbolKey, { apiKey, useCache = true } = {}) {
  if (!SYMBOLS[symbolKey]) throw new Error(`Unknown symbol key: ${symbolKey}`);

  if (useCache) {
    const cached = readCache(symbolKey);
    if (cached) return cached;
  }

  let candles;
  const errors = [];

  // 1. Yahoo Finance (GC=F / SI=F then spot pair)
  try {
    candles = await _fetchYahoo(symbolKey);
  } catch (e) {
    errors.push(`Yahoo: ${e.message}`);
    // 2. Stooq CSV
    try {
      candles = await _fetchStooq(symbolKey);
    } catch (e2) {
      errors.push(`Stooq: ${e2.message}`);
      // 3. Alpha Vantage
      if (!apiKey) throw new Error(`Market data unavailable — ${errors.join(' | ')}`);
      try {
        candles = await _fetchAlphaVantage(symbolKey, apiKey);
      } catch (e3) {
        throw new Error(`All sources failed — ${errors.join(' | ')} | AV: ${e3.message}`);
      }
    }
  }

  writeCache(symbolKey, candles);
  return candles;
}

module.exports = { SYMBOLS, fetchDailyCandles };
