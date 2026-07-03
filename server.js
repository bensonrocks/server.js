'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { analyze }          = require('./lib/trading/ictAnalysis');
const { fetchDailyCandles, SYMBOLS } = require('./lib/trading/marketData');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Run analysis and return JSON — used by the dashboard
app.get('/api/analysis', async (req, res) => {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  const results = {};
  try {
    for (const key of Object.keys(SYMBOLS)) {
      const candles = await fetchDailyCandles(key, { apiKey });
      results[key] = analyze(candles, key);
    }
    res.json({ ok: true, data: results, live: !!apiKey });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Demo endpoint — synthetic data, no API key needed
app.get('/api/demo', (req, res) => {
  const { generateCandles } = require('./lib/trading/demoData');
  const results = {
    GOLD:   analyze(generateCandles(2330, 0.1,  100, 'bull'), 'GOLD'),
    SILVER: analyze(generateCandles(32.5, 0.01, 100, 'bull'), 'SILVER'),
  };
  res.json({ ok: true, data: results, live: false });
});

app.listen(PORT, () => {
  console.log(`AndrewTrade running on port ${PORT}`);
  console.log(`Live data: ${process.env.ALPHA_VANTAGE_API_KEY ? 'YES (Alpha Vantage key set)' : 'NO — using demo mode'}`);
});
