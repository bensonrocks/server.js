// Smart-money / ICT-style technical analysis engine for OHLC candle data.
//
// Produces: swing structure (HH/HL/LH/LL), order blocks, fair value gaps (FVG),
// inverse fair value gaps (IFVG), trendlines, fibonacci zones, buy/sell zones
// (minimum width enforced), and a trade plan (entry, stop loss, TP1-3).
//
// Pip-size convention (documented because it is not standardized across brokers):
//   Gold (XAU/USD):   1 pip = $0.10   (e.g. 2350.00 -> 2351.00 = 10 pips)
//   Silver (XAG/USD):  1 pip = $0.01   (e.g. 29.00 -> 29.10 = 10 pips)
'use strict';

const PIP_SIZE = {
  GOLD: 0.1,
  SILVER: 0.01,
};

const MIN_ZONE_PIPS = 50;
const STOP_LOSS_PIPS = 80;

const isBullish = (c) => c.close > c.open;
const isBearish = (c) => c.close < c.open;

// ---------- Swing structure ----------

function findSwings(candles, lookback = 2) {
  const raw = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const highs = window.map((c) => c.high);
    const lows = window.map((c) => c.low);
    if (candles[i].high === Math.max(...highs)) {
      raw.push({ index: i, date: candles[i].date, price: candles[i].high, type: 'high' });
    }
    if (candles[i].low === Math.min(...lows)) {
      raw.push({ index: i, date: candles[i].date, price: candles[i].low, type: 'low' });
    }
  }
  raw.sort((a, b) => a.index - b.index);

  // Collapse consecutive same-type swings, keeping the most extreme.
  const merged = [];
  for (const swing of raw) {
    const last = merged[merged.length - 1];
    if (last && last.type === swing.type) {
      const moreExtreme =
        swing.type === 'high' ? swing.price > last.price : swing.price < last.price;
      if (moreExtreme) merged[merged.length - 1] = swing;
    } else {
      merged.push(swing);
    }
  }
  return merged;
}

function labelStructure(swings) {
  let lastHigh = null;
  let lastLow = null;
  return swings.map((swing) => {
    let label;
    if (swing.type === 'high') {
      label = lastHigh === null ? 'swing high' : swing.price > lastHigh ? 'HH' : 'LH';
      lastHigh = swing.price;
    } else {
      label = lastLow === null ? 'swing low' : swing.price > lastLow ? 'HL' : 'LL';
      lastLow = swing.price;
    }
    return { ...swing, label };
  });
}

function detectTrend(labeledSwings) {
  const highs = labeledSwings.filter((s) => s.type === 'high');
  const lows = labeledSwings.filter((s) => s.type === 'low');
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const bullish = ['HH', 'HL'];
  const bearish = ['LH', 'LL'];

  if (lastHigh && lastLow) {
    if (bullish.includes(lastHigh.label) && bullish.includes(lastLow.label)) return 'uptrend';
    if (bearish.includes(lastHigh.label) && bearish.includes(lastLow.label)) return 'downtrend';
  }
  // Mixed signal — use whichever swing point formed most recently (possible CHoCH).
  const mostRecent = [lastHigh, lastLow].filter(Boolean).sort((a, b) => b.index - a.index)[0];
  if (!mostRecent) return 'ranging';
  return bullish.includes(mostRecent.label) ? 'uptrend' : bearish.includes(mostRecent.label) ? 'downtrend' : 'ranging';
}

// ---------- Order blocks ----------

function detectOrderBlocks(candles, labeledSwings) {
  const swingHighs = labeledSwings.filter((s) => s.type === 'high');
  const swingLows = labeledSwings.filter((s) => s.type === 'low');
  const bullishOBs = [];
  const bearishOBs = [];

  let priorHighIdx = 0;
  let priorLowIdx = 0;

  for (let i = 1; i < candles.length; i++) {
    while (priorHighIdx < swingHighs.length - 1 && swingHighs[priorHighIdx].index < i - 1) {
      if (swingHighs[priorHighIdx + 1].index >= i) break;
      priorHighIdx++;
    }
    while (priorLowIdx < swingLows.length - 1 && swingLows[priorLowIdx].index < i - 1) {
      if (swingLows[priorLowIdx + 1].index >= i) break;
      priorLowIdx++;
    }
    const refHigh = swingHighs.find((s) => s.index < i);
    const refLow = swingLows.find((s) => s.index < i);
    const lastSwingHigh = [...swingHighs].reverse().find((s) => s.index < i);
    const lastSwingLow = [...swingLows].reverse().find((s) => s.index < i);

    // Bullish BOS: bullish candle closes above the last swing high, preceded by a bearish candle.
    if (lastSwingHigh && isBullish(candles[i]) && candles[i].close > lastSwingHigh.price && isBearish(candles[i - 1])) {
      bullishOBs.push({
        index: i - 1,
        date: candles[i - 1].date,
        low: candles[i - 1].low,
        high: candles[i - 1].high,
        bosIndex: i,
        bosDate: candles[i].date,
      });
    }
    // Bearish BOS: bearish candle closes below the last swing low, preceded by a bullish candle.
    if (lastSwingLow && isBearish(candles[i]) && candles[i].close < lastSwingLow.price && isBullish(candles[i - 1])) {
      bearishOBs.push({
        index: i - 1,
        date: candles[i - 1].date,
        low: candles[i - 1].low,
        high: candles[i - 1].high,
        bosIndex: i,
        bosDate: candles[i].date,
      });
    }
  }
  return { bullishOBs, bearishOBs };
}

// ---------- Fair value gaps ----------

function detectFVGs(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const left = candles[i - 1];
    const right = candles[i + 1];
    if (left.high < right.low) {
      fvgs.push({ type: 'bullish', formedIndex: i + 1, date: candles[i + 1].date, bottom: left.high, top: right.low });
    } else if (left.low > right.high) {
      fvgs.push({ type: 'bearish', formedIndex: i + 1, date: candles[i + 1].date, bottom: right.high, top: left.low });
    }
  }

  // Mark whether price has since fully traded through (filled) each gap, and
  // whether it inverted polarity (closed through the far edge -> IFVG).
  for (const gap of fvgs) {
    gap.filled = false;
    gap.inverted = false;
    for (let j = gap.formedIndex + 1; j < candles.length; j++) {
      const c = candles[j];
      if (c.low <= gap.bottom && c.high >= gap.top) {
        gap.filled = true;
      }
      const closedThroughFar =
        gap.type === 'bullish' ? c.close < gap.bottom : c.close > gap.top;
      if (closedThroughFar) {
        gap.inverted = true;
        gap.invertedIndex = j;
        gap.invertedDate = c.date;
        gap.invertedRole = gap.type === 'bullish' ? 'bearish' : 'bullish';
        break;
      }
    }
  }
  return fvgs;
}

// ---------- Trendline (least-squares regression over recent swing points) ----------

function linearRegression(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function computeTrendline(labeledSwings, trend, lastIndex, count = 3) {
  const type = trend === 'uptrend' ? 'low' : 'high';
  const pts = labeledSwings.filter((s) => s.type === type).slice(-count);
  if (pts.length < 2) return null;
  const { slope, intercept } = linearRegression(pts.map((p) => ({ x: p.index, y: p.price })));
  return {
    type: type === 'low' ? 'ascending support' : 'descending resistance',
    touchPoints: pts.map((p) => ({ date: p.date, price: p.price })),
    slope,
    projectedPrice: slope * lastIndex + intercept,
  };
}

// ---------- Fibonacci zone ----------

function computeFibZone(swingStart, swingEnd) {
  const [lo, hi] = [Math.min(swingStart.price, swingEnd.price), Math.max(swingStart.price, swingEnd.price)];
  const range = hi - lo;
  const direction = swingEnd.price > swingStart.price ? 'up' : 'down';
  const level = (pct) => (direction === 'up' ? hi - range * pct : lo + range * pct);
  return {
    anchorFrom: { date: swingStart.date, price: swingStart.price },
    anchorTo: { date: swingEnd.date, price: swingEnd.price },
    direction,
    levels: {
      '0.382': level(0.382),
      '0.5': level(0.5),
      '0.618': level(0.618),
      '0.65': level(0.65),
      '0.786': level(0.786),
    },
    goldenPocket: [level(0.618), level(0.786)].sort((a, b) => a - b),
    extensions: {
      '1.272': direction === 'up' ? hi - range * -0.272 : lo + range * -0.272,
      '1.618': direction === 'up' ? hi - range * -0.618 : lo + range * -0.618,
    },
  };
}

// ---------- Buy/sell zone (min width enforced) ----------

function buildZone(low, high, pipSize, minPips = MIN_ZONE_PIPS) {
  const minWidth = minPips * pipSize;
  let zoneLow = low;
  let zoneHigh = high;
  if (zoneHigh - zoneLow < minWidth) {
    const mid = (zoneLow + zoneHigh) / 2;
    zoneLow = mid - minWidth / 2;
    zoneHigh = mid + minWidth / 2;
  }
  return { low: zoneLow, high: zoneHigh, widthPips: (zoneHigh - zoneLow) / pipSize };
}

// ---------- Trade plan ----------

function buildTradePlan({ direction, zone, pipSize, swingTargets, fibZone }) {
  const entry = (zone.low + zone.high) / 2;
  const slPips = STOP_LOSS_PIPS;
  const sl = direction === 'buy' ? entry - slPips * pipSize : entry + slPips * pipSize;

  const candidates = swingTargets
    .filter((s) => (direction === 'buy' ? s.price > entry : s.price < entry))
    .sort((a, b) => (direction === 'buy' ? a.price - b.price : b.price - a.price));

  const riskPips = slPips;
  const fallback = (mult) => (direction === 'buy' ? entry + mult * riskPips * pipSize : entry - mult * riskPips * pipSize);

  const tp1 = candidates[0] ? candidates[0].price : fallback(1.5);
  const tp2 = candidates[1] ? candidates[1].price : fallback(2.5);
  const fibExt = fibZone ? fibZone.extensions['1.618'] : null;
  const tp3 = fibExt && (direction === 'buy' ? fibExt > tp2 : fibExt < tp2) ? fibExt : fallback(4);

  const rr = (tp) => Math.abs(tp - entry) / (slPips * pipSize);

  return {
    direction,
    entry,
    stopLoss: sl,
    stopLossPips: slPips,
    takeProfits: [
      { label: 'TP1', price: tp1, riskReward: rr(tp1) },
      { label: 'TP2', price: tp2, riskReward: rr(tp2) },
      { label: 'TP3', price: tp3, riskReward: rr(tp3) },
    ],
  };
}

// ---------- Top-level orchestration ----------

function analyze(candles, instrumentKey) {
  const pipSize = PIP_SIZE[instrumentKey];
  if (!pipSize) throw new Error(`No pip size configured for ${instrumentKey}`);

  const swings = findSwings(candles, 2);
  const labeledSwings = labelStructure(swings);
  const trend = detectTrend(labeledSwings);
  const { bullishOBs, bearishOBs } = detectOrderBlocks(candles, labeledSwings);
  const fvgs = detectFVGs(candles);
  const unfilledFVGs = fvgs.filter((g) => !g.filled);
  const ifvgs = fvgs.filter((g) => g.inverted);

  const lastIndex = candles.length - 1;
  const currentPrice = candles[lastIndex].close;
  const trendline = computeTrendline(labeledSwings, trend, lastIndex);

  const swingHighs = labeledSwings.filter((s) => s.type === 'high');
  const swingLows = labeledSwings.filter((s) => s.type === 'low');
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];
  const fibZone =
    lastSwingHigh && lastSwingLow
      ? lastSwingHigh.index > lastSwingLow.index
        ? computeFibZone(lastSwingLow, lastSwingHigh)
        : computeFibZone(lastSwingHigh, lastSwingLow)
      : null;

  const direction = trend === 'uptrend' ? 'buy' : trend === 'downtrend' ? 'sell' : null;

  let zone = null;
  let tradePlan = null;
  if (direction === 'buy') {
    const ob = [...bullishOBs].reverse().find((o) => o.high <= currentPrice) || bullishOBs[bullishOBs.length - 1];
    const fvg = [...unfilledFVGs].reverse().find((g) => g.type === 'bullish' && g.top <= currentPrice);
    const candidates = [ob, fvg].filter(Boolean);
    const low = candidates.length ? Math.min(...candidates.map((c) => c.low ?? c.bottom)) : currentPrice - MIN_ZONE_PIPS * pipSize;
    const high = candidates.length ? Math.max(...candidates.map((c) => c.high ?? c.top)) : currentPrice;
    zone = buildZone(low, high, pipSize);
    tradePlan = buildTradePlan({
      direction: 'buy',
      zone,
      pipSize,
      swingTargets: swingHighs,
      fibZone,
    });
  } else if (direction === 'sell') {
    const ob = [...bearishOBs].reverse().find((o) => o.low >= currentPrice) || bearishOBs[bearishOBs.length - 1];
    const fvg = [...unfilledFVGs].reverse().find((g) => g.type === 'bearish' && g.bottom >= currentPrice);
    const candidates = [ob, fvg].filter(Boolean);
    const low = candidates.length ? Math.min(...candidates.map((c) => c.low ?? c.bottom)) : currentPrice;
    const high = candidates.length ? Math.max(...candidates.map((c) => c.high ?? c.top)) : currentPrice + MIN_ZONE_PIPS * pipSize;
    zone = buildZone(low, high, pipSize);
    tradePlan = buildTradePlan({
      direction: 'sell',
      zone,
      pipSize,
      swingTargets: swingLows,
      fibZone,
    });
  }

  return {
    instrument: instrumentKey,
    pipSize,
    currentPrice,
    asOf: candles[lastIndex].date,
    trend,
    structure: labeledSwings,
    orderBlocks: { bullish: bullishOBs, bearish: bearishOBs },
    fvgs,
    unfilledFVGs,
    ifvgs,
    trendline,
    fibZone,
    zone,
    tradePlan,
  };
}

module.exports = {
  PIP_SIZE,
  MIN_ZONE_PIPS,
  STOP_LOSS_PIPS,
  findSwings,
  labelStructure,
  detectTrend,
  detectOrderBlocks,
  detectFVGs,
  computeTrendline,
  computeFibZone,
  buildZone,
  buildTradePlan,
  analyze,
};
