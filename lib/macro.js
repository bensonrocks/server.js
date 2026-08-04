'use strict';

const https = require('https');

// ── In-memory cache ────────────────────────────────────────────────────────
const _cache = {
  cot:      { data: null, ts: 0 },
  macro:    { data: null, ts: 0 },
};
const COT_TTL   = 6 * 60 * 60 * 1000;   // 6 hours (weekly data)
const MACRO_TTL = 60 * 60 * 1000;        // 1 hour

// ── Utility ────────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── COT (Commitments of Traders — CFTC Socrata API) ───────────────────────
// Futures-only report. Gold: COMEX 088691, Silver: COMEX 084691
const COT_ENDPOINT = 'https://publicreporting.cftc.gov/resource/jun7-fc8e.json';

async function fetchCOT() {
  if (Date.now() - _cache.cot.ts < COT_TTL && _cache.cot.data)
    return _cache.cot.data;

  const query = encodeURIComponent('GOLD - COMMODITY EXCHANGE INC.');
  const qSilver = encodeURIComponent('SILVER - COMMODITY EXCHANGE INC.');

  try {
    const [goldRows, silverRows] = await Promise.all([
      get(`${COT_ENDPOINT}?market_and_exchange_names=${query}&$limit=2&$order=report_date_as_yyyy_mm_dd%20DESC`),
      get(`${COT_ENDPOINT}?market_and_exchange_names=${qSilver}&$limit=2&$order=report_date_as_yyyy_mm_dd%20DESC`),
    ]);

    function parseCOT(rows, label) {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const cur = rows[0];
      const prev = rows[1] || null;

      const specLong  = parseInt(cur.noncomm_positions_long_all  || 0, 10);
      const specShort = parseInt(cur.noncomm_positions_short_all || 0, 10);
      const specNet   = specLong - specShort;

      const prevNet = prev
        ? parseInt(prev.noncomm_positions_long_all  || 0, 10) -
          parseInt(prev.noncomm_positions_short_all || 0, 10)
        : null;

      const oi = parseInt(cur.open_interest_all || 0, 10);
      const netPct = oi > 0 ? Math.round((specNet / oi) * 100) : null;

      const change = prevNet !== null ? specNet - prevNet : null;
      const trend  = change === null ? 'flat'
                   : change > 2000  ? 'up'
                   : change < -2000 ? 'down'
                   : 'flat';

      return {
        label,
        date: cur.report_date_as_yyyy_mm_dd?.slice(0, 10) || null,
        specNet,
        specNetK: Math.round(specNet / 1000),
        netPct,
        change,
        changeK: change !== null ? Math.round(change / 1000) : null,
        trend,
        bias: specNet > 0 ? 'long' : 'short',
      };
    }

    const result = {
      gold:   parseCOT(goldRows, 'GOLD'),
      silver: parseCOT(silverRows, 'SILVER'),
    };

    _cache.cot = { data: result, ts: Date.now() };
    return result;
  } catch {
    return _cache.cot.data || null;
  }
}

// ── DXY + Real Yield ───────────────────────────────────────────────────────
// DXY via Yahoo Finance (already in the stack), real yields via FRED if key set

async function fetchDXY() {
  // Yahoo Finance v8 chart endpoint — no key needed
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1d&range=5d';
  try {
    const data = await get(url);
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes) || closes.length < 2) return null;
    const valid = closes.filter(v => v != null);
    const last  = valid[valid.length - 1];
    const prev  = valid[valid.length - 2];
    return {
      value:  Math.round(last * 100) / 100,
      change: Math.round((last - prev) * 100) / 100,
      trend:  last > prev ? 'up' : last < prev ? 'down' : 'flat',
    };
  } catch {
    return null;
  }
}

async function fetchRealYield() {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  // DFII10 = 10-Year Treasury Inflation-Indexed Security (real yield)
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DFII10&api_key=${key}&limit=5&sort_order=desc&file_type=json`;
  try {
    const data = await get(url);
    const obs  = data?.observations?.filter(o => o.value !== '.');
    if (!obs || obs.length < 2) return null;
    const last  = parseFloat(obs[0].value);
    const prev  = parseFloat(obs[1].value);
    return {
      value:  last,
      change: Math.round((last - prev) * 100) / 100,
      trend:  last > prev ? 'up' : last < prev ? 'down' : 'flat',
      date:   obs[0].date,
    };
  } catch {
    return null;
  }
}

async function fetchMacro() {
  if (Date.now() - _cache.macro.ts < MACRO_TTL && _cache.macro.data)
    return _cache.macro.data;

  const [dxy, realYield] = await Promise.all([fetchDXY(), fetchRealYield()]);
  const result = { dxy, realYield };
  _cache.macro = { data: result, ts: Date.now() };
  return result;
}

// ── Economic Calendar ──────────────────────────────────────────────────────
// Hardcoded Fed/BLS/NFP schedule for 2025–2026 (published annually)
// Dates: FOMC from federalreserve.gov, CPI from bls.gov, NFP from bls.gov

const CALENDAR = [
  // FOMC 2025
  { date: '2025-01-29', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2025-03-19', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2025-05-07', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2025-06-18', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2025-07-30', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2025-09-17', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2025-10-29', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2025-12-10', type: 'FOMC', label: 'Fed Rate Decision' },
  // FOMC 2026
  { date: '2026-01-28', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2026-03-18', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2026-04-29', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2026-06-17', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2026-07-29', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2026-09-16', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2026-10-28', type: 'FOMC', label: 'Fed Rate Decision' },
  { date: '2026-12-09', type: 'FOMC', label: 'Fed Rate Decision' },

  // CPI 2025 (BLS release dates)
  { date: '2025-01-15', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-02-12', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-03-12', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-04-10', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-05-13', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-06-11', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-07-15', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-08-12', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-09-10', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-10-15', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-11-12', type: 'CPI',  label: 'US CPI Release' },
  { date: '2025-12-10', type: 'CPI',  label: 'US CPI Release' },
  // CPI 2026
  { date: '2026-01-14', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-02-11', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-03-11', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-04-14', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-05-13', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-06-10', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-07-14', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-08-12', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-09-09', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-10-14', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-11-12', type: 'CPI',  label: 'US CPI Release' },
  { date: '2026-12-09', type: 'CPI',  label: 'US CPI Release' },

  // NFP 2025 (BLS first-Friday schedule)
  { date: '2025-01-10', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-02-07', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-03-07', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-04-04', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-05-02', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-06-06', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-07-03', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-08-01', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-09-05', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-10-03', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-11-07', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2025-12-05', type: 'NFP',  label: 'Non-Farm Payrolls' },
  // NFP 2026
  { date: '2026-01-09', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-02-06', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-03-06', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-04-03', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-05-08', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-06-05', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-07-09', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-08-07', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-09-04', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-10-02', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-11-06', type: 'NFP',  label: 'Non-Farm Payrolls' },
  { date: '2026-12-04', type: 'NFP',  label: 'Non-Farm Payrolls' },
].sort((a, b) => a.date.localeCompare(b.date));

function getUpcomingEvents(windowDays = 21) {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  // yesterday-inclusive so same-day events show as "TODAY"
  const start = new Date(now);
  start.setDate(start.getDate() - 1);
  const startStr = start.toISOString().slice(0, 10);

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + windowDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return CALENDAR
    .filter(e => e.date >= today && e.date <= cutoffStr)
    .slice(0, 6)
    .map(e => {
      const diff = Math.round(
        (new Date(e.date) - new Date(today)) / (1000 * 60 * 60 * 24)
      );
      return {
        ...e,
        daysAway: diff,
        tag: diff === 0 ? 'TODAY' : diff === 1 ? 'TOMORROW' : `${diff}D`,
        urgent: diff <= 1,
      };
    });
}

// ── Public API ─────────────────────────────────────────────────────────────
async function getMacroContext() {
  const [cot, macro] = await Promise.all([fetchCOT(), fetchMacro()]);
  return {
    cot,
    dxy:       macro.dxy,
    realYield: macro.realYield,
    calendar:  getUpcomingEvents(),
  };
}

module.exports = { getMacroContext };
