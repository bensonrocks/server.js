// In-session demo: runs the full ICT analysis engine on realistic synthetic
// price data for gold and silver, then prints the full report with AI interpretation.
// Swap generateCandles() for real Alpha Vantage data on your local machine.
'use strict';

const { analyze } = require('../lib/trading/ictAnalysis');

// Generates realistic trending OHLC data with impulse legs + pullbacks.
function generateCandles(startPrice, pipSize, days = 100, bias = 'bull') {
  const candles = [];
  let price = startPrice;
  const base = new Date('2026-01-02');

  for (let i = 0; i < days; i++) {
    const date = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
    const phase = Math.floor(i / 8) % 3; // 0=impulse, 1=pullback, 2=consolidation
    const trendDrift = bias === 'bull'
      ? (phase === 0 ? 1.8 : phase === 1 ? -0.7 : 0.1)
      : (phase === 0 ? -1.8 : phase === 1 ? 0.7 : -0.1);

    const noise = (Math.sin(i * 1.7) + Math.cos(i * 0.9)) * 0.4;
    const open = price;
    const close = open + trendDrift * pipSize * 3 + noise * pipSize;
    const range = Math.abs(close - open) + Math.random() * pipSize * 2;
    const high = Math.max(open, close) + range * 0.4;
    const low  = Math.min(open, close) - range * 0.4;

    candles.push({ date, open, high, low, close });
    price = close;
  }
  return candles;
}

function round(n, d = 2) { return typeof n === 'number' ? n.toFixed(d) : n; }

function aiInterpret(result, label) {
  const { trend, structure, orderBlocks, unfilledFVGs, ifvgs, fibZone, zone, tradePlan } = result;

  const recentStructure = structure.slice(-6);
  const hhCount = recentStructure.filter(s => s.label === 'HH').length;
  const hlCount = recentStructure.filter(s => s.label === 'HL').length;
  const lhCount = recentStructure.filter(s => s.label === 'LH').length;
  const llCount = recentStructure.filter(s => s.label === 'LL').length;

  const bias = trend === 'uptrend' ? 'BULLISH' : trend === 'downtrend' ? 'BEARISH' : 'NEUTRAL/RANGING';
  const conviction =
    (hhCount >= 2 && hlCount >= 1) || (llCount >= 2 && lhCount >= 1) ? 'HIGH' : 'MODERATE';

  const bullishOBCount = orderBlocks.bullish.length;
  const bearishOBCount = orderBlocks.bearish.length;
  const obBias = bullishOBCount > bearishOBCount ? 'more demand than supply zones' : bullishOBCount < bearishOBCount ? 'more supply than demand zones' : 'balanced institutional interest';

  const unfilledBullFVGs = unfilledFVGs.filter(g => g.type === 'bullish').length;
  const unfilledBearFVGs = unfilledFVGs.filter(g => g.type === 'bearish').length;
  const ifvgWarn = ifvgs.length > 3 ? `High IFVG count (${ifvgs.length}) signals repeated liquidity sweeps — market is actively re-pricing.` : '';

  const fibComment = fibZone
    ? `Fib golden pocket sits at ${round(fibZone.goldenPocket[0])} – ${round(fibZone.goldenPocket[1])}, confluence target for pullback entries.`
    : '';

  const tradeComment = tradePlan
    ? `Preferred setup: ${tradePlan.direction.toUpperCase()} limit at ${round(tradePlan.entry)}, SL ${round(tradePlan.stopLoss)} (${tradePlan.stopLossPips} pips), TP1 ${round(tradePlan.takeProfits[0].price)} (${round(tradePlan.takeProfits[0].riskReward)}R), TP2 ${round(tradePlan.takeProfits[1].price)} (${round(tradePlan.takeProfits[1].riskReward)}R), TP3 ${round(tradePlan.takeProfits[2].price)} (${round(tradePlan.takeProfits[2].riskReward)}R).`
    : 'No clear trade setup — wait for structure to resolve.';

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  AI INTERPRETATION — ${label.padEnd(34)}║
╚══════════════════════════════════════════════════════════╝

  Directional Bias:  ${bias}  (conviction: ${conviction})
  Current Price:     ${round(result.currentPrice)}  (as of ${result.asOf})
  Pip Size:          $${result.pipSize}/pip

  Structure Read:
    Recent swing sequence shows ${hhCount}×HH, ${hlCount}×HL, ${lhCount}×LH, ${llCount}×LL.
    ${trend === 'uptrend' ? 'Higher highs and higher lows confirm a clear upward structure. Price is making sustained progress against sellers.' : trend === 'downtrend' ? 'Lower highs and lower lows confirm a clear downtrend. Sellers remain in control of price delivery.' : 'Mixed structure — market is consolidating or in a transition phase. No clear bias yet.'}

  Institutional Footprint:
    Order blocks: ${bullishOBCount} bullish (demand), ${bearishOBCount} bearish (supply) — ${obBias}.
    Unfilled FVGs: ${unfilledBullFVGs} bullish, ${unfilledBearFVGs} bearish imbalances outstanding.
    ${ifvgWarn}

  Fibonacci Context:
    ${fibComment || 'Insufficient swing data for fib projection.'}

  Trade Plan:
    ${tradeComment}

  Key Risk Factors:
    - Always confirm on your live chart before executing.
    - Daily candles; allow 1-5 sessions for price to reach zone.
    - Invalidation: SL hit at ${tradePlan ? round(tradePlan.stopLoss) : 'N/A'} signals structure shift.
`);
}

function fullReport(result, label) {
  const { pipSize, currentPrice, asOf, trend, structure, orderBlocks,
          unfilledFVGs, ifvgs, trendline, fibZone, zone, tradePlan } = result;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${label}  |  ${asOf}  |  close: ${round(currentPrice)}`);
  console.log('═'.repeat(60));
  console.log(`  Trend: ${trend.toUpperCase()}`);

  console.log('\n  Market Structure (last 8 swings):');
  structure.slice(-8).forEach(s => {
    console.log(`    ${s.date}  ${s.type === 'high' ? '▲' : '▼'} ${round(s.price, 2).padStart(10)}  [${s.label}]`);
  });

  if (trendline) {
    console.log(`\n  Trendline (${trendline.type}):`);
    console.log(`    Touch points: ${trendline.touchPoints.map(p => `${p.date}@${round(p.price)}`).join('  →  ')}`);
    console.log(`    Projected now: ${round(trendline.projectedPrice)}`);
  }

  console.log('\n  Order Blocks:');
  console.log(`    Bullish (demand):`);
  (orderBlocks.bullish.slice(-3).length ? orderBlocks.bullish.slice(-3) : []).forEach(o =>
    console.log(`      ${o.date}  [${round(o.low)} – ${round(o.high)}]`));
  if (!orderBlocks.bullish.length) console.log('      (none detected)');
  console.log(`    Bearish (supply):`);
  (orderBlocks.bearish.slice(-3).length ? orderBlocks.bearish.slice(-3) : []).forEach(o =>
    console.log(`      ${o.date}  [${round(o.low)} – ${round(o.high)}]`));
  if (!orderBlocks.bearish.length) console.log('      (none detected)');

  console.log(`\n  Fair Value Gaps: ${unfilledFVGs.length} unfilled`);
  unfilledFVGs.slice(-4).forEach(g =>
    console.log(`    ${g.date}  ${g.type.padEnd(7)}  [${round(g.bottom)} – ${round(g.top)}]`));

  console.log(`\n  Inverse FVGs (IFVG): ${ifvgs.length}`);
  ifvgs.slice(-3).forEach(g =>
    console.log(`    formed ${g.date} → inverted ${g.invertedDate} (now ${g.invertedRole} resistance/support)  [${round(g.bottom)} – ${round(g.top)}]`));

  if (fibZone) {
    console.log(`\n  Fibonacci Zone (${fibZone.anchorFrom.date} @ ${round(fibZone.anchorFrom.price)} → ${fibZone.anchorTo.date} @ ${round(fibZone.anchorTo.price)}):`);
    Object.entries(fibZone.levels).forEach(([pct, price]) =>
      console.log(`    ${pct.padEnd(6)}  ${round(price)}`));
    console.log(`    ★ Golden pocket:  ${round(fibZone.goldenPocket[0])} – ${round(fibZone.goldenPocket[1])}`);
    console.log(`    Extension 1.618:  ${round(fibZone.extensions['1.618'])}`);
  }

  if (zone && tradePlan) {
    console.log(`\n  ${tradePlan.direction.toUpperCase()} ZONE: ${round(zone.low)} – ${round(zone.high)}  (${round(zone.widthPips, 1)} pips wide, min 50 pips enforced)`);
    console.log('\n  Trade Plan:');
    console.log(`    Entry:      ${round(tradePlan.entry)}`);
    console.log(`    Stop Loss:  ${round(tradePlan.stopLoss)}  (${tradePlan.stopLossPips} pips)`);
    tradePlan.takeProfits.forEach(tp =>
      console.log(`    ${tp.label}:        ${round(tp.price).padEnd(12)}  R:R ${round(tp.riskReward, 2)}`)
    );
  } else {
    console.log('\n  No clear directional setup — market is ranging.');
  }

  aiInterpret(result, label);
}

// ── Run ──────────────────────────────────────────────────────────────────────

const goldCandles   = generateCandles(2330, 0.1,  100, 'bull');
const silverCandles = generateCandles(32.5, 0.01, 100, 'bull');

const goldResult   = analyze(goldCandles,   'GOLD');
const silverResult = analyze(silverCandles, 'SILVER');

console.log('\n\nGOLD & SILVER — ICT SMART MONEY ANALYSIS');
console.log('(Demo run with synthetic data — swap in Alpha Vantage on your machine for live prices)\n');

fullReport(goldResult,   'XAU/USD  GOLD');
fullReport(silverResult, 'XAG/USD  SILVER');
