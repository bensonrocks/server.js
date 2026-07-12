// IDEAL engine — wraps the ICT analysis models (GOLD, SILVER) with:
//
//   self-healing:  live fetch is retried once, then falls back to the on-disk
//                  candle cache regardless of age, then to deterministic demo
//                  data; every run updates a per-model health record.
//   self-learning: each day's trade plan is recorded as a signal snapshot;
//                  learning.js later grades those snapshots against realized
//                  price action and tunes the model parameters within bounds.
//
// Signals are only recorded from real market data (live or cached) — demo
// candles are synthetic, so learning from them would corrupt the stats.
'use strict';

const crypto = require('crypto');
const { analyze }                                        = require('../trading/ictAnalysis');
const { fetchDailyCandles, readCachedCandles, SYMBOLS }  = require('../trading/marketData');
const { generateCandles }                                = require('../trading/demoData');
const store                                              = require('./store');

const MODELS = Object.keys(SYMBOLS); // GOLD, SILVER

const DEFAULT_PARAMS = { minZonePips: 50, stopLossPips: 80 };
const PARAM_BOUNDS   = { minZonePips: [30, 100], stopLossPips: [50, 150] };

const DEMO_SEED = { GOLD: [2330, 0.1], SILVER: [32.5, 0.01] };

const MAX_SIGNAL_HISTORY = 400;

function defaultState() {
  return {
    params: { ...DEFAULT_PARAMS },
    health: {
      status: 'unknown',
      lastRun: null,
      lastSuccess: null,
      lastError: null,
      consecutiveFailures: 0,
      dataSource: null,
    },
  };
}

// Out-of-bounds values (corrupt state, over-eager learning) are clamped back
// into the safe range so a bad adjustment can never runaway-degrade a model.
function clampParams(params) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_PARAMS)) {
    const [lo, hi] = PARAM_BOUNDS[key];
    const v = Number.isFinite(params?.[key]) ? params[key] : def;
    out[key] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

async function getModelState(model) {
  const state = (await store.load(`state:${model}`)) || defaultState();
  state.params = clampParams(state.params);
  return state;
}

async function saveModelState(model, state) {
  await store.save(`state:${model}`, state);
}

// Self-healing candle acquisition: live fetch, one retry, stale cache, demo.
async function getCandles(model, { apiKey } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const candles = await fetchDailyCandles(model, { apiKey });
      return { candles, source: 'live', healed: attempt > 1, lastError };
    } catch (err) {
      lastError = err.message;
      if (!apiKey) break; // no key — retrying can't help
    }
  }

  const stale = readCachedCandles(model);
  if (stale) return { candles: stale, source: 'stale-cache', healed: true, lastError };

  const [startPrice, pipSize] = DEMO_SEED[model];
  return {
    candles: generateCandles(startPrice, pipSize, 100, 'bull'),
    source: 'demo',
    healed: true,
    lastError,
  };
}

async function recordSignal(model, analysis, params) {
  const signals = (await store.load(`signals:${model}`)) || [];
  if (signals.some((s) => s.signalDate === analysis.asOf)) return; // one per candle day

  const plan = analysis.tradePlan;
  signals.push({
    id: crypto.randomUUID(),
    model,
    signalDate: analysis.asOf,
    trend: analysis.trend,
    direction: plan ? plan.direction : null,
    entry: plan ? plan.entry : null,
    stopLoss: plan ? plan.stopLoss : null,
    takeProfits: plan ? plan.takeProfits.map((t) => t.price) : [],
    params,
    outcome: plan ? 'open' : 'no_trade',
    outcomeDate: null,
    createdAt: new Date().toISOString(),
  });
  await store.save(`signals:${model}`, signals.slice(-MAX_SIGNAL_HISTORY));
}

async function runModel(model, { apiKey } = {}) {
  const state = await getModelState(model);
  const now = new Date().toISOString();
  state.health.lastRun = now;

  try {
    const { candles, source, healed, lastError } = await getCandles(model, { apiKey });
    const analysis = analyze(candles, model, state.params);

    if (source !== 'demo') await recordSignal(model, analysis, state.params);

    state.health = {
      ...state.health,
      status: source === 'live' && !healed ? 'healthy'
            : source === 'live'            ? 'recovered'
            : 'degraded',
      lastSuccess: now,
      lastError: lastError || null,
      consecutiveFailures: 0,
      dataSource: source,
    };
    await saveModelState(model, state);
    return { ok: true, model, analysis, live: source === 'live', health: state.health, params: state.params };
  } catch (err) {
    state.health = {
      ...state.health,
      status: 'failing',
      lastError: err.message,
      consecutiveFailures: state.health.consecutiveFailures + 1,
      dataSource: null,
    };
    await saveModelState(model, state);
    return { ok: false, model, error: err.message, health: state.health, params: state.params };
  }
}

async function runAll({ apiKey } = {}) {
  const results = {};
  for (const model of MODELS) {
    results[model] = await runModel(model, { apiKey });
  }
  return results;
}

async function getHealth() {
  const out = {};
  for (const model of MODELS) {
    const state = await getModelState(model);
    out[model] = { health: state.health, params: state.params };
  }
  return out;
}

module.exports = {
  MODELS,
  DEFAULT_PARAMS,
  PARAM_BOUNDS,
  clampParams,
  getModelState,
  saveModelState,
  getCandles,
  runModel,
  runAll,
  getHealth,
};
