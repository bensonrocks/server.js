# The suites — copied out of the build session, 10 Sep 2026, wired up 13 Sep

Every `*-e2e.js`, `br-*.js` and `e2e-*.js` here was written and run green
against the REAL server during the sessions recorded in CLAUDE.md. They were
copied verbatim so they outlive the scratchpad they were written in.

`test/suites.json` is the manifest and `test/run-suites.js` is the runner:

    npm run test:suites     # tier "ci" — what CI runs on every push
    npm run test:api        # every self-booting non-browser suite
    npm run test:browser    # every self-booting Chromium suite
    npm run test:all        # everything, harness-less ones included
    node test/run-suites.js abort-e2e perf-e2e     # named

## TWO KINDS OF SUITE, AND THE DIFFERENCE IS THE WHOLE PROBLEM

**22 of the 64 boot their own server** (`selfBoots: true`): they spawn
`server.js` on their own port with their own `DATA_DIR`, wait for
`/api/version`, log in, run, and kill what they spawned. These run
unattended, and 8 of them are in CI.

**42 do not.** They were written against a server someone had already started
by hand in that session, so they open `http://localhost:<port>` and die in one
second with `ECONNREFUSED` when nothing is listening. That is not a bug in
them — it is how you write a suite when you are sitting in front of the
server. They are `selfBoots: false`, tier `needs-harness`, and `--tier api` /
`--tier browser` deliberately leave them out: a runner that reports 42 red
suites nobody can act on is a runner people learn to ignore. `--tier all`
includes them, for the session that wires the harness (W2 of
`docs/IMPROVEMENT_PLAN.md`).

Promoting one is: give it a harness-provided port and data dir, run it, and
if it is green set `tier: "ci"` in `test/suites.json`.

## What a script assumes

- The server is `path.join(__dirname, '../../server.js')` — the absolute
  `/home/user/server.js/...` paths were rewritten on 13 Sep, in 119 files.
- Fixtures sit beside the script (they are also kept in `fixtures/`).
- `demo/demo` is the login. Some seed a second user `whguy/whpass1` (role
  warehouse) because of one-device-per-user.
- Chromium comes from `TEST_CHROMIUM`, defaulting to the build sandbox's
  `/opt/pw-browsers/chromium`. CI installs Playwright's own and sets that
  variable. Never hard-code a browser path in a new suite.
- A suite keeps its data dir, logs, screenshots and fixtures **beside
  itself** (`__dirname`). It must create everything it reads: `br-onecart`
  once read label PDFs that `onecart-e2e` prints, and passed only when that
  suite had just been run by hand.
- `*-mock.js` stand in for ZORT, ZORT web, Shopify, OneCart and partner
  webhook receivers.
- A suite prints `PASS - ` / `FAIL - ` lines and exits 0 / 1 (2 on crash).
  The runner counts those lines; keep the prefixes exactly.

## Known traps, all recorded in CLAUDE.md under TEST GOTCHA

`pgrep -f <pattern>` matches its own shell — kill by scanning
`/proc/*/environ` for the port. db.json is written on a deferred timer (wait
~2s before reading it off disk). One active device per user, so a browser
signing in as `demo` invalidates a token the harness is holding. A server left
running from a failed run re-persists over a freshly reset data dir. Chromium
negotiates Brotli, so asserting `content-encoding === 'gzip'` fails in a real
browser even when compression is working.

## Deleted in W1

28 one-off diagnostics (`dbg*`, `shot*`, `walkthrough*`, `*-demo*`,
`probe.js`, `live*.js`) — they were investigations, not suites. Nothing
surviving required them; that was checked by grepping every remaining file for
`require('./<name>')` after the deletion, not before.
