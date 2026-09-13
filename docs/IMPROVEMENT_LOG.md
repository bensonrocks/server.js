# Improvement log — one entry per Sunday

Baseline, 10 Sep 2026 (before Week 1):

| Measure | Value |
|---|---|
| `server.js` lines | 30,700 |
| Tests running in CI | 1 suite, 6 checks |
| Tests outside the repo | roughly 20 suites, several hundred checks |
| db.json write cost | measured from this week; read it off the Health Check |
| Response p99 (Railway, 7d) | 20 s spikes every few minutes |
| Egress | 40–80 MB bursts, uncompressed (fixed 10 Sep: gzip/brotli) |

---

## Sunday 13 Sep 2026 — W1 · Tests into the repo

**What moved.** The suites that proved every feature in this system lived in
a session scratchpad, which is deleted when the session ends. They are in the
repo now and CI runs them.

- Absolute `/home/user/server.js/...` paths rewritten to `__dirname` in **119**
  of the 190 files; all 190 parse.
- **28 one-off diagnostics deleted.** Verified nothing surviving required
  them (`grep -ln "require('./<name>')"` across the rest: clean). 162 files
  remain — 64 suites, 15 mocks, 83 fixtures and helpers.
- `test/suites.json` classifies every suite; `test/run-suites.js` runs them
  one at a time, counts `PASS -`/`FAIL -` lines and prints only failing ones.
- `npm run test:suites` (tier `ci`), `test:api`, `test:browser`, `test:all`.
- `.github/workflows/test.yml` is two jobs now: `fence` (`npm test`) and
  `suites` (`npm run test:suites`).

**Measured.**

| | Before | After |
|---|---|---|
| Checks running in CI | 6 | **202** |
| Checks runnable by one command | 6 | **610** (202 CI + 408 browser) |
| Suites running in CI | 1 | **8** |
| Suites living in the repo | 1 | **64** |
| `server.js` lines | 30,700 | 30,780 |

The 8 CI suites, all green, 4m00s total: `email-off` 12, `gi-backfill` 33,
`label-parcels` 32, `lag` 25, `onecart-ref` 50, `perf` 25, `perf-ocr` 6,
`web-note` 19.

**The finding this week actually produced, and it was not in the plan.**
Only **22 of the 64 suites boot their own server.** The other **42 were
written against a server started by hand** in the session that built them —
they open `http://localhost:<port>` and fail in one second with
`ECONNREFUSED` when nothing is listening. That is not a defect in them; it is
how they were written, when a human was sitting there. It means "copy the
suites in and switch CI on" was never the whole job: those 42 need a harness
to boot a server for them, which is now W2. Until then `--tier api` and
`--tier browser` select only self-booting suites, so the runner never reports
42 red suites that nobody can act on. `--tier all` still includes them, for
the session that does the wiring.

**Browser suites are on demand, not in CI.** 14 of them, each needing
Chromium and taking 15–43s; CI would need a browser image and the job would
run past 30 minutes. `npm run test:browser` runs them, and all 14 are green:
`abort-e2e` 16, `br-bulk-print` 32, `br-gi-backfill` 29, `br-gi-scan` 18,
`br-label-parcels` 20, `br-label-ref` 28, `br-lag` 15, `br-onecart` 39,
`br-onecart-ref` 31, `br-perf` 10, `br-preview` 23, `bulk-print-e2e` 38,
`label-ref-e2e` 30, `onecart-e2e` 79 — **408 checks**.

**THREE THINGS THAT ONLY SHOW UP WHEN A SUITE RUNS ON ITS OWN.** Every one of
these passed in the session that wrote it and would have gone red the first
time CI ran it, which is the entire argument for doing this week.

1. **`br-onecart` read label fixtures another suite creates.** It opened
   `oc-pdfs/`, which `onecart-e2e.js` prints through Chromium at the top of
   *its* run — so it passed only when that suite had just been run by hand in
   the same session. Alone it reported "0 of 3 label(s) attached", which reads
   like a broken Get Labels button. It prints its own fixtures now.
2. **…and it was ALSO asserting behaviour the app has since changed.** With
   the fixtures there it still attached nothing — correctly. The suite saves
   the store through the UI form, which now **defaults to reference mode**,
   and the ring fence says a label is never filed on a reference copy. The app
   was right and the test was stale. It selects work mode now (the scope
   `onecart-e2e.js` declares in its own comment); reference mode has its own
   pass in `br-onecart-ref.js`. 39 checks green.
3. **25 suites still wrote into the session scratchpad** — a hardcoded
   `/tmp/claude-0/<session-id>/scratchpad` for data dirs, screenshots and
   fixtures, including five of the eight CI suites. The first path sweep only
   looked for `/home/user/server.js/...`. Rewritten to `__dirname`, so a suite
   keeps its files beside itself and two runs cannot collide.

**And two CI suites needed a real Chromium.** `web-note-e2e` drives the ZORT
web-label worker signing in and capturing a PDF, and `lag-e2e`'s tap path
fetches one the same way; both hard-coded the sandbox's
`/opt/pw-browsers/chromium`. That path is now `TEST_CHROMIUM` with the sandbox
as the default (60 files), and the CI job installs Playwright's Chromium and
points at it. Left alone, those two would have been red in CI while green on
every developer machine — the fastest way to teach people to ignore a red run.

**Not done, stated rather than ticked.**
- The CodeQL +1 (181 → 182 on `bb5815b`) is **not identified**. This session
  has no code-scanning access and no `gh`, and grepping `test/legacy` for the
  usual medium patterns (URL-substring sanitisation, path expressions from
  request data, insecure randomness, clear-text logging) found nothing. It
  has to be read off the PR's Security tab. Worth knowing before anyone
  spends a Sunday on it: the alert is in a test or mock script that never
  ships, and GitHub's default CodeQL setup accepts no `paths-ignore`, so
  "fixing" it means either editing a mock to please a scanner or converting
  the repo to advanced setup and disturbing a 180-alert baseline. Deleting
  the offending script, if it turns out to be one of the mocks nothing needs,
  is the cheap answer.
- The 42 harness-less suites (above) → W2.

**Next Sunday: W2** — smoke test, size guard, and the harness.
