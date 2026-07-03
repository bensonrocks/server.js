#!/usr/bin/env node
// CLI: fetches daily gold (XAU/USD) and silver (XAG/USD) candles and prints a
// smart-money style technical analysis report (structure, order blocks, FVG/IFVG,
// trendline, fib zone, buy/sell zone, entry/exit, TP1-3, 80-pip stop loss).
//
// Usage:
//   ALPHA_VANTAGE_API_KEY=xxxx node scripts/analyze-gold-silver.js
'use strict';

const fs = require('fs');
const path = require('path');
const { SYMBOLS, fetchDailyCandles } = require('../lib/trading/marketData');
const { analyze } = require('../lib/trading/ictAnalysis');

function fmt(n, decimals = 2) {
  return typeof n === 'number' ? n.toFixed(decimals) : n;
}

function printReport(result) {
  const label = SYMBOLS[result.instrument].label;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label} — as of ${result.asOf} (close ${fmt(result.currentPrice)})`);
  console.log('='.repeat(60));
  console.log(`Trend: ${result.trend.toUpperCase()}`);

  console.log('\nMarket structure (recent swings):');
  result.structure.slice(-8).forEach((s) => {
    console.log(`  ${s.date}  ${s.type.padEnd(4)}  ${fmt(s.price)}  [${s.label}]`);
  });

  if (result.trendline) {
    console.log(`\nTrendline (${result.trendline.type}):`);
    console.log(`  touches: ${result.trendline.touchPoints.map((p) => `${p.date}@${fmt(p.price)}`).join(', ')}`);
    console.log(`  projected current level: ${fmt(result.trendline.projectedPrice)}`);
  }

  console.log('\nOrder blocks (last 3 each):');
  console.log('  Bullish:', result.orderBlocks.bullish.slice(-3).map((o) => `${o.date} [${fmt(o.low)}-${fmt(o.high)}]`).join(' | ') || 'none found');
  console.log('  Bearish:', result.orderBlocks.bearish.slice(-3).map((o) => `${o.date} [${fmt(o.low)}-${fmt(o.high)}]`).join(' | ') || 'none found');

  console.log(`\nFair Value Gaps: ${result.fvgs.length} total, ${result.unfilledFVGs.length} unfilled`);
  result.unfilledFVGs.slice(-3).forEach((g) => {
    console.log(`  ${g.date} ${g.type} FVG [${fmt(g.bottom)}-${fmt(g.top)}]`);
  });

  console.log(`\nInverse FVGs (IFVG): ${result.ifvgs.length}`);
  result.ifvgs.slice(-3).forEach((g) => {
    console.log(`  ${g.date} -> inverted ${g.invertedDate} (now acts ${g.invertedRole}) [${fmt(g.bottom)}-${fmt(g.top)}]`);
  });

  if (result.fibZone) {
    console.log(`\nFibonacci zone (from ${result.fibZone.anchorFrom.date}@${fmt(result.fibZone.anchorFrom.price)} to ${result.fibZone.anchorTo.date}@${fmt(result.fibZone.anchorTo.price)}):`);
    console.log(`  golden pocket: ${fmt(result.fibZone.goldenPocket[0])} - ${fmt(result.fibZone.goldenPocket[1])}`);
    console.log(`  extension 1.618: ${fmt(result.fibZone.extensions['1.618'])}`);
  }

  if (result.zone && result.tradePlan) {
    console.log(`\n${result.tradePlan.direction.toUpperCase()} ZONE: ${fmt(result.zone.low)} - ${fmt(result.zone.high)} (${fmt(result.zone.widthPips, 1)} pips wide)`);
    console.log('\nTrade plan:');
    console.log(`  Entry:     ${fmt(result.tradePlan.entry)}`);
    console.log(`  Stop loss: ${fmt(result.tradePlan.stopLoss)}  (${result.tradePlan.stopLossPips} pips)`);
    result.tradePlan.takeProfits.forEach((tp) => {
      console.log(`  ${tp.label}:      ${fmt(tp.price)}  (R:R ${fmt(tp.riskReward, 2)})`);
    });
  } else {
    console.log('\nNo clear directional bias — market structure is ranging. No trade plan generated.');
  }
}

async function main() {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  const reports = {};

  for (const key of Object.keys(SYMBOLS)) {
    const candles = await fetchDailyCandles(key, { apiKey });
    const result = analyze(candles, key);
    printReport(result);
    reports[key] = result;
  }

  const outDir = path.join(__dirname, '..', 'data', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `gold-silver-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(reports, null, 2));
  console.log(`\nFull report saved to ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
