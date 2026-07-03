'use strict';

function generateCandles(startPrice, pipSize, days = 100, bias = 'bull') {
  const candles = [];
  let price = startPrice;
  const base = new Date('2026-01-02');
  for (let i = 0; i < days; i++) {
    const date = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
    const phase = Math.floor(i / 8) % 3;
    const drift = bias === 'bull'
      ? (phase === 0 ? 1.8 : phase === 1 ? -0.7 : 0.1)
      : (phase === 0 ? -1.8 : phase === 1 ? 0.7 : -0.1);
    const noise = (Math.sin(i * 1.7) + Math.cos(i * 0.9)) * 0.4;
    const open  = price;
    const close = open + drift * pipSize * 3 + noise * pipSize;
    const range = Math.abs(close - open) + Math.random() * pipSize * 2;
    const high  = Math.max(open, close) + range * 0.4;
    const low   = Math.min(open, close) - range * 0.4;
    candles.push({ date, open, high, low, close });
    price = close;
  }
  return candles;
}

module.exports = { generateCandles };
