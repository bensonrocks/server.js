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
| Checks running in CI | 6 | **126** |
| Checks runnable by one command | 6 | **610** (126 CI + 452 browser + 32 local-only) |
| Suites running in CI | 1 | **5** |
| Suites living in the repo | 1 | **64** |
| `server.js` lines | 30,700 | 30,780 |

The 5 CI suites, all green, ~1m15s total, none launching a browser and none
reading anything outside the repo: `email-off` 12, `gi-backfill` 33,
`onecart-ref` 50, `perf` 25, `perf-ocr` 6.

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

**Browser suites are on demand, not in CI.** 16 of them, each needing
Chromium and taking 15–90s; CI would need a browser image and the job would
run past 30 minutes. `npm run test:browser` runs them, and all 16 are green:
`abort-e2e` 16, `br-bulk-print` 32, `br-gi-backfill` 29, `br-gi-scan` 18,
`br-label-parcels` 20, `br-label-ref` 28, `br-lag` 15, `br-onecart` 39,
`br-onecart-ref` 31, `br-perf` 10, `br-preview` 23, `bulk-print-e2e` 38,
`label-ref-e2e` 30, `onecart-e2e` 79, `lag-e2e` 25, `web-note-e2e` 19 —
**452 checks**.

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

**And two CI suites needed a real Chromium — which I first tried to solve the
wrong way, and CI said so within the hour.** `web-note-e2e` drives the ZORT
web-label worker signing in and capturing a PDF, and `lag-e2e`'s tap path
fetches one the same way; both hard-coded the sandbox's
`/opt/pw-browsers/chromium`. That path is `TEST_CHROMIUM` now, defaulting to
the sandbox (60 files). But the first cut then kept both in CI and installed
Chromium for them, and the `End-to-end suites` job went red on the very first
run (`5d1c5fc`). Two faults:

- A plain contradiction of my own making: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`
  was set on the same job that then ran `playwright install chromium`, so the
  install is a no-op and the resolved `executablePath()` points at nothing.
- The real fault underneath it: **the classification was wrong.** A suite that
  launches Chromium is a browser suite whatever else it asserts, and calling
  those two API suites is what dragged a browser install into a job that needs
  none. Both are `browser: true` now and run with the other 14.

**AND A THIRD ABSOLUTE-PATH CLASS, found only after that.**
`label-parcels-e2e` reads two label PDFs from
`/root/.claude/uploads/<session-id>/` — **files the user uploaded into the
session**, which exist on exactly one machine in the world. It was in the CI
tier and could never have passed there. They are real customer shipping
labels carrying a name and a delivery address, so committing them to a GitHub
repo is out of the question — the same rule this system already applies to
label URLs on the audit trail. It is tier `needs-fixtures` now, still run by
`--tier api` here, with the reason on the suite record. W2 should synthesise
an equivalent two-page label (numbers only, no person) and put it back.

**So CI is 5 suites and 126 checks, not 202** — 76 fewer than the first cut
claimed, and 120 more than ran before this week. Proved browser-free by
running the tier with `TEST_CHROMIUM=/nonexistent/chromium`: 126 green.

**THE GUARD, because three times in one day is a pattern, not bad luck.**
Sandbox paths, then scratchpad paths, then session uploads — each found by
hand, each after the previous sweep had "finished". `test/run-suites.js` now
refuses to run a **ci-tier** suite whose source carries an absolute path
under `/root`, `/home`, `/tmp`, `/opt`, `/Users`, `/var`, `/mnt` or `/media`,
naming the path and the file; outside the ci tier it is a note, because a
browser suite's Chromium default legitimately lives under `/opt`. Proved by
putting `label-parcels-e2e` back into `ci` and watching it refuse with exit 2.
Grepping was never a control. This is.

The diagnosis was made without the CI log — this session has no
code-scanning or Actions access and no `gh`. What settled it was which job
did NOT fail: `fence` shares `npm ci`, the native rebuild and booting the
server, so the fault had to be in what is unique to the suites job. Worth
remembering as a technique; it is also why CI now does nothing that the
local run cannot do.

**Not done, stated rather than ticked.**
- **CodeQL on the W1 commit came back at 182 — exactly where `bb5815b` left
  it.** So W1 introduced nothing new, and one thing is now ruled out: the
  extra alert is **not in any of the 28 deleted scripts**, or deleting them
  would have taken it back to 181. It is in a file that survived. That
  narrows the search to the 162 still there and is worth knowing before
  anyone opens the Security tab.
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
