#!/usr/bin/env node
'use strict';

// CLI for the Singapore → South East Asia freight rate fetcher.
//
//   node scripts/fetch-freight-rates.js --status
//   node scripts/fetch-freight-rates.js --to "port klang,jakarta" --equipment 40GP
//   node scripts/fetch-freight-rates.js --json > rates.json

const freight = require('../lib/freight');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; }
    else { args[key] = next; i++; }
  }
  return args;
}

function money(rate) {
  if (rate.total == null) return '—';
  const amount = `${rate.currency} ${rate.total.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return rate.priceRange
    ? `${amount} (${rate.priceRange.low.toLocaleString()}–${rate.priceRange.high.toLocaleString()})`
    : amount;
}

function printStatus() {
  const s = freight.status();
  console.log('\nFreight providers\n');
  for (const p of s.providers) {
    const mark = p.configured ? 'ready  ' : 'not set';
    const tail = p.configured
      ? (p.market ? 'market estimate' : 'bookable carrier rates')
      : `needs ${p.missing.join(', ')}`;
    console.log(`  [${mark}] ${p.name.padEnd(12)} ${tail}`);
    if (!p.configured) console.log(`              ${p.docs}`);
  }
  console.log(`\n  Lanes: ${s.ports.length - 1} SEA destinations from Singapore`);
  console.log(`  Equipment: ${s.equipment.join(', ')}`);
  console.log(`  Cache TTL: ${Math.round(s.cache.ttlMs / 60000)} min\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Usage: node scripts/fetch-freight-rates.js [options]

  --status              show which providers are configured and exit
  --to <ports>          destination port(s), comma separated, or "all" (default: all)
  --from <port>         origin port (default: SGSIN Singapore)
  --equipment <type>    20GP | 40GP | 40HC | 40RF   (default: 40GP)
  --date <YYYY-MM-DD>   cargo ready / departure date (default: today + 7 days)
  --providers <ids>     restrict to specific providers, e.g. cmacgm,maersk
  --refresh             bypass the cache
  --json                emit raw JSON instead of a table
`);
    return;
  }

  if (args.status) { printStatus(); return; }

  const result = await freight.getRates({
    origin:        args.from || undefined,
    destination:   args.to || undefined,
    equipment:     args.equipment || '40GP',
    departureDate: args.date || undefined,
    providers:     args.providers || undefined,
    refresh:       Boolean(args.refresh),
  });

  if (args.json) { console.log(JSON.stringify(result, null, 2)); return; }

  const { query } = result;
  console.log(`\n${query.origin} → ${query.destination}  |  ${query.equipment}  |  departing ${query.departureDate}\n`);

  for (const warning of result.warnings) console.log(`  ! ${warning}`);
  if (result.providers.skipped.length) {
    console.log(`  · skipped: ${result.providers.skipped.map(p => p.name).join(', ')} (no credentials)`);
  }
  if (result.warnings.length || result.providers.skipped.length) console.log('');

  let printed = 0;
  for (const lane of result.lanes) {
    if (!lane.rates.length) continue;
    printed++;
    console.log(`  ${lane.destination.name} (${lane.destination.code})`);
    for (const rate of lane.rates) {
      const transit = rate.transitDays != null ? `${rate.transitDays}d` : '—';
      const tag     = rate.market ? ' [market est.]' : '';
      console.log(`     ${rate.carrier.padEnd(14)} ${money(rate).padEnd(24)} ${transit.padEnd(5)} ${rate.service || ''}${tag}`);
    }
    console.log('');
  }

  if (!printed) {
    console.log('  No rates returned. Run with --status to check provider configuration.\n');
  }

  const errors = result.lanes
    .flatMap(l => l.providers.filter(p => p.status === 'error').map(p => `${l.destination.code}/${p.id}: ${p.error}`));
  if (errors.length) {
    console.log('  Upstream errors:');
    for (const e of [...new Set(errors)]) console.log(`     ${e}`);
    console.log('');
  }
}

main().catch(err => { console.error(`\nfetch-freight-rates failed: ${err.message}\n`); process.exit(1); });
