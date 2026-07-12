// Daily learning cycle for IDEAL models.
//
// Grades every open recorded signal against the candles that formed after it
// (entry fill, stop-out, take-profit hits), aggregates lifetime stats, nudges
// the model's tunable parameters within the bounds defined in engine.js, and
// appends a journal entry so every adjustment is auditable.
'use strict';

const store  = require('./store');
const engine = require('./engine');

const ENTRY_EXPIRY_DAYS = 10;   // trading days for an entry to fill before the signal expires
const MIN_SAMPLE        = 5;    // decided outcomes required before parameters may move

// Grade one signal against candles that formed after it. Returns null while
// the signal is still open (entry pending or trade running without resolution).
function gradeSignal(signal, candles) {
  const after = candles.filter((c) => c.date > signal.signalDate);
  if (!after.length) return null;

  const dir = signal.direction;
  const [tp1, tp2, tp3] = signal.takeProfits;
  let filled = false;
  let best = null; // best take-profit locked in on a PREVIOUS day
  let daysWaiting = 0;

  for (const c of after) {
    if (!filled) {
      daysWaiting++;
      if (c.low <= signal.entry && c.high >= signal.entry) {
        filled = true;
      } else if (daysWaiting >= ENTRY_EXPIRY_DAYS) {
        return { outcome: 'expired', outcomeDate: c.date };
      } else {
        continue;
      }
    }

    const hitStop  = dir === 'buy' ? c.low <= signal.stopLoss : c.high >= signal.stopLoss;
    const hitLevel = (p) => p != null && (dir === 'buy' ? c.high >= p : c.low <= p);

    // Daily candles cannot show intraday ordering: when stop and target sit in
    // the same candle, count it as a stop-out unless a target was already
    // reached on an earlier day — the conservative reading.
    if (hitStop) return { outcome: best || 'stopped', outcomeDate: c.date };
    if (hitLevel(tp3)) return { outcome: 'tp3', outcomeDate: c.date };
    if (hitLevel(tp2)) best = 'tp2';
    else if (hitLevel(tp1) && !best) best = 'tp1';
  }
  return null; // still running
}

async function evaluateModel(model, candles) {
  const signals = (await store.load(`signals:${model}`)) || [];
  let closedThisCycle = 0;

  for (const s of signals) {
    if (s.outcome !== 'open') continue;
    const graded = gradeSignal(s, candles);
    if (graded) {
      s.outcome = graded.outcome;
      s.outcomeDate = graded.outcomeDate;
      closedThisCycle++;
    }
  }
  if (closedThisCycle) await store.save(`signals:${model}`, signals);

  const done    = signals.filter((s) => ['tp1', 'tp2', 'tp3', 'stopped', 'expired'].includes(s.outcome));
  const wins    = done.filter((s) => s.outcome.startsWith('tp')).length;
  const stopped = done.filter((s) => s.outcome === 'stopped').length;
  const expired = done.filter((s) => s.outcome === 'expired').length;
  const decided = wins + stopped;

  return {
    totalSignals: signals.length,
    open: signals.filter((s) => s.outcome === 'open').length,
    closedThisCycle,
    lifetime: {
      wins,
      stopped,
      expired,
      winRate:  decided     ? +(wins / decided).toFixed(3) : null,
      fillRate: done.length ? +((done.length - expired) / done.length).toFixed(3) : null,
    },
  };
}

// Bounded, explainable parameter adjustments — never more than one step per
// day per parameter, always clamped to PARAM_BOUNDS.
function adaptParams(params, stats) {
  const next = { ...params };
  const adjustments = [];
  const { wins, stopped, expired, winRate, fillRate } = stats.lifetime;

  if (wins + stopped >= MIN_SAMPLE && winRate !== null) {
    if (winRate < 0.4) {
      next.stopLossPips = params.stopLossPips + 10;
      adjustments.push({
        param: 'stopLossPips', from: params.stopLossPips, to: next.stopLossPips,
        reason: `win rate ${Math.round(winRate * 100)}% — widening stop so normal daily range stops fewer trades out`,
      });
    } else if (winRate > 0.65) {
      next.stopLossPips = params.stopLossPips - 5;
      adjustments.push({
        param: 'stopLossPips', from: params.stopLossPips, to: next.stopLossPips,
        reason: `win rate ${Math.round(winRate * 100)}% — tightening stop to improve risk/reward`,
      });
    }
  }

  if (wins + stopped + expired >= MIN_SAMPLE && fillRate !== null && fillRate < 0.5) {
    next.minZonePips = params.minZonePips + 10;
    adjustments.push({
      param: 'minZonePips', from: params.minZonePips, to: next.minZonePips,
      reason: `only ${Math.round(fillRate * 100)}% of signals filled — widening entry zone so price reaches it more often`,
    });
  }

  const clamped = engine.clampParams(next);
  for (const adj of adjustments) adj.to = clamped[adj.param];
  return { params: clamped, adjustments: adjustments.filter((a) => a.from !== a.to) };
}

// Runs at most once per UTC day unless forced. Safe to call from an hourly
// timer — the date guard makes extra calls no-ops.
async function runDailyLearning({ apiKey, force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const meta = (await store.load('learning-meta')) || { lastRunDate: null };
  if (meta.lastRunDate === today && !force) {
    return { ran: false, lastRunDate: meta.lastRunDate };
  }

  const entries = [];
  let anySucceeded = false;

  for (const model of engine.MODELS) {
    try {
      const state = await engine.getModelState(model);
      const { candles, source } = await engine.getCandles(model, { apiKey });

      if (source === 'demo') {
        entries.push({
          date: today, model, dataSource: source, stats: null, adjustments: [],
          params: state.params,
          notes: ['No real market data available — learning paused so synthetic candles cannot skew the stats.'],
        });
        anySucceeded = true;
        continue;
      }

      const stats = await evaluateModel(model, candles);
      const { params, adjustments } = adaptParams(state.params, stats);
      state.params = params;
      await engine.saveModelState(model, state);

      entries.push({
        date: today, model, dataSource: source, stats, adjustments, params,
        notes: adjustments.length
          ? adjustments.map((a) => `${a.param}: ${a.from} → ${a.to} (${a.reason})`)
          : ['No parameter changes — performance within target bands.'],
      });
      anySucceeded = true;
    } catch (err) {
      entries.push({
        date: today, model, error: err.message,
        notes: ['Learning cycle failed for this model; parameters left unchanged. Will retry next cycle.'],
      });
    }
  }

  const journal = (await store.load('journal')) || [];
  journal.push(...entries);
  await store.save('journal', journal.slice(-1000));

  // Only stamp the date when something succeeded, so an all-failed cycle is
  // retried on the next hourly tick instead of waiting a full day.
  if (anySucceeded) {
    await store.save('learning-meta', { lastRunDate: today, lastRunAt: new Date().toISOString() });
  }

  return { ran: true, date: today, entries };
}

async function getJournal({ model, limit = 30 } = {}) {
  const journal = (await store.load('journal')) || [];
  const filtered = model ? journal.filter((e) => e.model === model) : journal;
  return filtered.slice(-limit).reverse(); // newest first
}

module.exports = { gradeSignal, evaluateModel, adaptParams, runDailyLearning, getJournal };
