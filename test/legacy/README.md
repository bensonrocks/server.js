# Legacy test suites — copied from the build session on 10 Sep 2026

Every `*-e2e.js`, `br-*.js`, `e2e-*.js` and `*-mock.js` here was written and
run green against the real server during the sessions recorded in CLAUDE.md.
They were copied verbatim so they survive the session's scratchpad; **they are
NOT wired into `npm test` yet** — that is Week 1 of `docs/IMPROVEMENT_PLAN.md`.

Until then, what a script assumes:

- `/home/user/server.js/server.js` is the server (absolute path — rewrite to
  `path.join(__dirname, '../../server.js')` when wiring).
- Fixtures were beside the script; they are in `fixtures/` now.
- Each script boots its own server on a hard-coded port with its own data dir
  (`DATA_DIR`), logs in as `demo/demo`, and kills what it spawned. Some seed a
  second user `whguy/whpass1` (role warehouse) because of one-device-per-user.
- Chromium is at `/opt/pw-browsers/chromium` in the build sandbox; in CI use
  Playwright's own download or `ZORT_BROWSER_PATH`.
- Mocks (`*-mock.js`) stand in for ZORT, Shopify, OneCart, ZORT web and
  partner webhook receivers; their fixtures are in `fixtures/`.
- Scripts named `dbg*`, `shot*`, `walkthrough*`, `*-demo*`, `probe.js`,
  `live*.js` are one-off diagnostics, not suites. They can be deleted in W1.

Known traps, all recorded in CLAUDE.md under TEST GOTCHA: `pgrep -f` matches
its own shell; db.json is written on a deferred timer (wait ~2s); one active
device per user invalidates the harness token when a browser signs in; a
server left running re-persists over a reset data dir.
