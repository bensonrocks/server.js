'use strict';

// In-memory MT4/MT5 bridge state — resets on server restart
const state = {
  connected: false,
  lastSeen:  null,
  terminal:  null,    // { platform, version, broker, account }
  ticks:     {},      // { XAUUSD: { bid, ask, spread, time }, XAGUSD: {...} }
  positions: [],      // open trades pushed by EA
  signals:   [],      // pending signal alerts for EA
  signalSeq: 0,
};

const STALE_MS = 30_000; // 30 s without heartbeat → offline

function heartbeat(terminal) {
  state.connected = true;
  state.lastSeen  = Date.now();
  if (terminal) state.terminal = terminal;
}

function updateTick(symbol, bid, ask) {
  bid = +bid; ask = +ask;
  const spread = +(ask - bid).toFixed(5);
  state.ticks[symbol] = { bid, ask, spread, time: Date.now() };
  state.lastSeen = Date.now();
  state.connected = true;
}

function updatePositions(positions) {
  state.positions = positions;
  state.lastSeen  = Date.now();
}

function pushSignal(instrument, direction, entry, stopLoss, tp1, tp2, tp3) {
  state.signalSeq++;
  state.signals.push({
    id:         state.signalSeq,
    instrument,
    direction,
    entry,
    stopLoss,
    tp1, tp2, tp3,
    acked:      false,
    createdAt:  Date.now(),
  });
  if (state.signals.length > 100) state.signals.shift();
}

function getPendingSignals() {
  return state.signals.filter(s => !s.acked);
}

function ackSignal(id) {
  const sig = state.signals.find(s => s.id === +id);
  if (sig) sig.acked = true;
  return !!sig;
}

function getStatus() {
  const stale = !state.lastSeen || Date.now() - state.lastSeen > STALE_MS;
  return {
    connected:          state.connected && !stale,
    lastSeenMs:         state.lastSeen,
    terminal:           state.terminal,
    ticks:              state.ticks,
    positions:          state.positions,
    pendingSignalCount: getPendingSignals().length,
  };
}

module.exports = { heartbeat, updateTick, updatePositions, pushSignal, getPendingSignals, ackSignal, getStatus };
