#!/usr/bin/env node
'use strict';
// Runs the end-to-end and browser suites in test/legacy against the REAL
// server, one at a time, and reports which passed.
//
// WHY A RUNNER AND NOT `node --test`: every one of these suites boots its own
// server on its own port with its own DATA_DIR, drives real endpoints (and,
// for the br-* ones, a real Chromium), and prints its own PASS/FAIL lines.
// They are integration suites, not unit tests — node:test would add nothing
// and would hide their output. They already exit 0 on pass and non-zero on
// failure, which is the whole contract this runner needs.
//
// SEQUENTIAL ON PURPOSE. Two suites booting servers at once compete for CPU
// and, worse, for the inventory SQLite file; a flaky suite is worse than a
// slow one.
//
//   node test/run-suites.js --tier ci        # what CI runs on every push
//   node test/run-suites.js --tier api       # every non-browser suite
//   node test/run-suites.js --tier browser   # every Chromium suite
//   node test/run-suites.js --tier all
//   node test/run-suites.js abort-e2e perf-e2e     # named suites
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LEGACY = path.join(__dirname, 'legacy');
const MANIFEST = path.join(__dirname, 'suites.json');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch (e) { console.error(`Cannot read ${MANIFEST}: ${e.message}`); process.exit(2); }
}

function pick(manifest, argv) {
  const tierAt = argv.indexOf('--tier');
  const tier = tierAt >= 0 ? argv[tierAt + 1] : null;
  // The tier's VALUE is not a suite name — without this, `--tier api` looked
  // for a suite called "api" and refused to run anything.
  const named = argv.filter((a, i) => !a.startsWith('--') && !(tierAt >= 0 && i === tierAt + 1));
  if (!tier && !named.length) return manifest.suites.filter(s => s.tier === 'ci');
  const all = manifest.suites;
  if (named.length) {
    return named.map(n => {
      const hit = all.find(s => s.file === n || s.file === `${n}.js`);
      if (!hit) { console.error(`No suite named "${n}" in suites.json`); process.exit(2); }
      return hit;
    });
  }
  // `api` and `browser` mean "every suite of that kind this runner can
  // actually run" — i.e. one that boots its own server. The other 42 were
  // written against a server started BY HAND in the session that built them;
  // until W2's harness starts one for them they fail in a second, and a
  // runner that reports those as failures every time teaches people to
  // ignore it. `--tier all` still includes them, deliberately, for the
  // session that wires the harness up.
  if (tier === 'all') return all;
  if (tier === 'api') return all.filter(s => !s.browser && s.selfBoots);
  if (tier === 'browser') return all.filter(s => s.browser && s.selfBoots);
  return all.filter(s => s.tier === tier);
}

function runOne(suite) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(LEGACY, suite.file)], {
      cwd: LEGACY,
      env: { ...process.env, ...(suite.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const take = d => { out += d.toString(); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      out += `\n[runner] timed out after ${(suite.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000}s\n`;
      try { child.kill('SIGKILL'); } catch {}
    }, suite.timeoutMs || DEFAULT_TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(timer);
      const pass = (out.match(/^PASS - /gm) || []).length;
      const fail = (out.match(/^FAIL - /gm) || []).length;
      resolve({ suite, code, ms: Date.now() - started, pass, fail, out });
    });
  });
}

(async () => {
  const manifest = loadManifest();
  const chosen = pick(manifest, process.argv.slice(2));
  if (!chosen.length) { console.log('No suites selected.'); process.exit(0); }
  console.log(`Running ${chosen.length} suite(s)\n`);
  const results = [];
  for (const suite of chosen) {
    process.stdout.write(`→ ${suite.file} … `);
    const r = await runOne(suite);
    results.push(r);
    const secs = (r.ms / 1000).toFixed(0);
    if (r.code === 0) console.log(`ok  (${r.pass} checks, ${secs}s)`);
    else {
      console.log(`FAILED  (exit ${r.code}, ${r.pass} passed / ${r.fail} failed, ${secs}s)`);
      // Only the failing lines — a full dump of a green-but-long suite buries them.
      const lines = r.out.split('\n').filter(l => /^FAIL - |^CRASH|Error:/.test(l)).slice(0, 12);
      lines.forEach(l => console.log(`      ${l}`));
    }
  }
  const failed = results.filter(r => r.code !== 0);
  const checks = results.reduce((n, r) => n + r.pass, 0);
  console.log(`\n${results.length - failed.length}/${results.length} suite(s) green · ${checks} checks passed`);
  if (failed.length) {
    console.log('Failed: ' + failed.map(r => r.suite.file).join(', '));
    process.exit(1);
  }
})().catch(e => { console.error('[runner]', e); process.exit(2); });
