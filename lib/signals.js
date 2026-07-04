'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { pool, hasDb } = require('./db');

const FILE = path.join(__dirname, '../data/signals.json');

function jsonRead() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function jsonWrite(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

// ── Pure helpers (shared by both backends) ─────────────────────────────

/**
 * Check whether a single OHLC candle resolves an open signal.
 * Returns 'win_tp1', 'loss', or null (still open).
 *
 * When both SL and TP1 are hit on the same candle (ambiguous daily bar),
 * we use candle direction as the tiebreaker — the same standard used by
 * professional daily-timeframe backtesting tools.
 */
function resolveOutcome(signal, candle) {
  const { direction, stopLoss, tp1 } = signal;
  const { open, high, low, close } = candle;

  if (direction === 'buy') {
    const slHit = low  <= stopLoss;
    const tpHit = high >= tp1;
    if (slHit && tpHit) return close > open ? 'win_tp1' : 'loss';
    if (slHit) return 'loss';
    if (tpHit) return 'win_tp1';
  } else if (direction === 'sell') {
    const slHit = high >= stopLoss;
    const tpHit = low  <= tp1;
    if (slHit && tpHit) return close < open ? 'win_tp1' : 'loss';
    if (slHit) return 'loss';
    if (tpHit) return 'win_tp1';
  }
  return null;
}

/**
 * Compute trailing performance stats from a signal array.
 * win_tp1 payout = rr1 (e.g. 1.8R); loss cost = 1R.
 */
function calculateStats(signalList) {
  const closed  = signalList.filter(s => s.outcome !== 'open');
  const wins    = closed.filter(s => s.outcome === 'win_tp1');
  const losses  = closed.filter(s => s.outcome === 'loss');
  const open    = signalList.filter(s => s.outcome === 'open').length;

  const winRate = closed.length ? +(wins.length / closed.length * 100).toFixed(1) : null;

  const grossProfit = wins.reduce((sum, w) => sum + (w.rr1 || 1.5), 0);
  const grossLoss   = losses.length; // each loss = 1 R
  const profitFactor = grossLoss > 0
    ? +(grossProfit / grossLoss).toFixed(2)
    : wins.length > 0 ? 99.0 : null;

  // Current consecutive streak
  const sorted = [...closed].sort((a, b) => {
    const da = a.outcomeDate || a.signalDate;
    const db = b.outcomeDate || b.signalDate;
    return da < db ? -1 : da > db ? 1 : 0;
  });
  let streak = 0;
  let streakType = null;
  if (sorted.length) {
    const last = sorted[sorted.length - 1];
    streakType = last.outcome === 'win_tp1' ? 'win' : 'loss';
    for (let i = sorted.length - 1; i >= 0; i--) {
      if ((sorted[i].outcome === 'win_tp1') === (streakType === 'win')) streak++;
      else break;
    }
  }

  return { total: closed.length, wins: wins.length, losses: losses.length, open, winRate, profitFactor, streak, streakType };
}

// ── JSON backend ───────────────────────────────────────────────────────

const json = {
  saveSignal({ instrument, direction, entry, stopLoss, tp1, tp2, tp3, rr1, signalDate }) {
    const list = jsonRead();
    const existing = list.find(s => s.instrument === instrument && s.signalDate === signalDate);
    if (existing) return existing;
    const signal = {
      id: crypto.randomUUID(),
      instrument, direction,
      entry: +entry, stopLoss: +stopLoss, tp1: +tp1,
      tp2: tp2 != null ? +tp2 : null,
      tp3: tp3 != null ? +tp3 : null,
      rr1: rr1 != null ? +rr1 : null,
      signalDate,
      outcome: 'open',
      outcomeDate: null,
      createdAt: new Date().toISOString(),
    };
    list.push(signal);
    jsonWrite(list);
    return signal;
  },

  getOpenSignals(instrument) {
    return jsonRead().filter(s => s.instrument === instrument && s.outcome === 'open');
  },

  updateOutcome(id, outcome, outcomeDate) {
    const list = jsonRead();
    const idx = list.findIndex(s => s.id === id);
    if (idx !== -1) { list[idx].outcome = outcome; list[idx].outcomeDate = outcomeDate; jsonWrite(list); }
  },

  getAll() {
    return jsonRead();
  },

  getRecent(n = 30) {
    return jsonRead().sort((a, b) => (a.signalDate < b.signalDate ? 1 : -1)).slice(0, n);
  },

  resolveOutcome,
  calculateStats,
};

// ── PostgreSQL backend ─────────────────────────────────────────────────

function rowToSignal(r) {
  if (!r) return null;
  const ds = v => {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    if (v instanceof Date)     return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
  };
  return {
    id:          r.id,
    instrument:  r.instrument,
    direction:   r.direction,
    entry:       +r.entry,
    stopLoss:    +r.stop_loss,
    tp1:         +r.tp1,
    tp2:         r.tp2  != null ? +r.tp2  : null,
    tp3:         r.tp3  != null ? +r.tp3  : null,
    rr1:         r.rr1  != null ? +r.rr1  : null,
    signalDate:  ds(r.signal_date),
    outcome:     r.outcome,
    outcomeDate: ds(r.outcome_date),
    createdAt:   r.created_at,
  };
}

const pg = {
  async saveSignal({ instrument, direction, entry, stopLoss, tp1, tp2, tp3, rr1, signalDate }) {
    const { rows: existing } = await pool.query(
      'SELECT * FROM signals WHERE instrument = $1 AND signal_date = $2',
      [instrument, signalDate]
    );
    if (existing[0]) return rowToSignal(existing[0]);

    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO signals (id, instrument, direction, entry, stop_loss, tp1, tp2, tp3, rr1, signal_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (instrument, signal_date) DO NOTHING
       RETURNING *`,
      [id, instrument, direction, entry, stopLoss, tp1, tp2 ?? null, tp3 ?? null, rr1 ?? null, signalDate]
    );
    if (rows[0]) return rowToSignal(rows[0]);
    // Concurrent insert: fetch the winning row
    const { rows: r2 } = await pool.query(
      'SELECT * FROM signals WHERE instrument = $1 AND signal_date = $2',
      [instrument, signalDate]
    );
    return rowToSignal(r2[0]);
  },

  async getOpenSignals(instrument) {
    const { rows } = await pool.query(
      "SELECT * FROM signals WHERE instrument = $1 AND outcome = 'open' ORDER BY signal_date ASC",
      [instrument]
    );
    return rows.map(rowToSignal);
  },

  async updateOutcome(id, outcome, outcomeDate) {
    await pool.query(
      'UPDATE signals SET outcome = $1, outcome_date = $2 WHERE id = $3',
      [outcome, outcomeDate, id]
    );
  },

  async getAll() {
    const { rows } = await pool.query('SELECT * FROM signals ORDER BY signal_date DESC');
    return rows.map(rowToSignal);
  },

  async getRecent(n = 30) {
    const { rows } = await pool.query(
      'SELECT * FROM signals ORDER BY signal_date DESC LIMIT $1', [n]
    );
    return rows.map(rowToSignal);
  },

  resolveOutcome,
  calculateStats,
};

module.exports = hasDb ? pg : json;
