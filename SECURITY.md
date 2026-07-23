# Security & Vulnerability Management

## Dependency vulnerability scanning

Scanning is **automated and runs at least monthly** — comfortably inside the
"at least once every three months" requirement (Lazada ISV Q7e).

- **Automated:** GitHub Actions workflow `.github/workflows/security-audit.yml`
  runs `npm audit` on the **1st of every month**, on **every pull request**
  (so new dependencies are checked before merge), and **on demand**
  (`workflow_dispatch`). Each run's log and the uploaded `npm-audit-report`
  artifact serve as the scan evidence/record.
- **Manual:** run `npm run audit` (production dependencies) or
  `npm run audit:report` (writes `audit-report.json`) at any time.

The scan **reports** results rather than hard-failing the build, because some
current advisories are in a transitive dependency with **no upstream fix
available** (see below); failing every run on an unfixable issue would only
block development. New high/critical issues are surfaced as a workflow warning
in the job summary for review.

## Remediation policy

1. When a scan reports a vulnerability **with a fix available**, update the
   dependency (`npm audit fix`, or a targeted version bump) and re-run the app's
   tests before merging.
2. When there is **no fix available**, assess exploitability in this app's
   context and record it as an accepted risk below, with rationale, until an
   upstream fix ships.
3. Re-review accepted risks on each monthly scan.

## Currently accepted risks (no upstream fix available)

| Advisory | Package (path) | Rationale |
|---|---|---|
| `xmldom` XML injection / uncontrolled recursion (GHSA-2v35-w6hq-6mfw, -f6ww-3ggp-fr8h, -x6wf-f3px-wcqx, -j759-j44w-7fr8) | `xmldom` (transitive, via `docxtemplater-image-module-free`) | Used only server-side for Word/`.docx` image templating from **operator-supplied** template files, never fed untrusted marketplace/customer input. No upstream fix is available for `xmldom` at the required version. Tracked for update when `docxtemplater-image-module-free` moves off the vulnerable `xmldom`. |

## Data protection (related compliance)

- **Marketplace order data retention (Lazada ISV Q8e):** personal data on
  completed marketplace (Lazada/ZORT) orders is automatically redacted after a
  configurable window (`MARKETPLACE_RETENTION_DAYS`, default **90 days ≤ 3
  months**) across live data and archives — see `lib/pii-purge.js` and
  `runMarketplaceDataPurge` in `server.js`. Nightly backups rotate off within
  14 days.
- **Secrets** (API keys/secrets, mail credentials) live only in the runtime
  data store / environment and are never committed to git; API responses mask
  them.

## Reporting a vulnerability

Email the maintainer (see repository owner) with details and reproduction
steps. Please do not open a public issue for undisclosed vulnerabilities.
