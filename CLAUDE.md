# IDEALSCAN — Project Notes for Claude

## OCR Pipeline (server.js — `preprocessForOcr` / `runOcr`)

All photo-based OCR (picking list and product label) goes through two stages:

### Stage 1 — Image preprocessing (`preprocessForOcr`, requires `sharp`)
1. **Greyscale** — removes colour noise that confuses the LSTM model
2. **Normalize** — auto-stretches histogram for better contrast on faded/dim prints
3. **Sharpen** (`sigma 1.5, m1 2.0, m2 0.5`) — crisp text edges reduce letter-doubling artefacts (e.g. DMG→DMMG)
4. **Threshold (140)** — binarizes to pure black/white; eliminates grey pixels between characters that cause LSTM hallucinations (e.g. `H6` pixel blur → model reads `HB6`)
5. Output as **lossless PNG** — avoids JPEG compression artefacts around text

If `sharp` is unavailable the original buffer is passed through unchanged (graceful degradation).

### Stage 2 — Tesseract with LSTM engine (`runOcr`)
- **OEM 1** (LSTM neural-net only) — more accurate than legacy engine
- **PSM 3** (auto page segmentation) for picking lists — lets Tesseract detect the mixed header+table layout
- **PSM 6** (single uniform block) for product labels — compact, few-line documents
- **`preserve_interword_spaces: 1`** — keeps column spacing so the parser can split tokens correctly
- Product label scan also sets a **character whitelist** to block OCR from inventing symbols

Do NOT revert to bare `Tesseract.recognize()` — always call `runOcr()`.

## OCR Parsing Rules (lib/ocr-parse.js)

### Location codes must NEVER become SKUs
Warehouse bin/location codes like `AB-005001-A`, `AB-006-001-B`, `BC-003-035`, `AC-007-003-B`, `DMG-2`, `BIN-1`
look like product codes but are shelf positions. The pattern is:
- **1–4 letter prefix** (up to 4 because OCR can double a letter: `DMG` → `DMMG`)
- 1–3 hyphen-separated digit groups (**1–6 digits each** — note: 1 digit minimum, e.g. `DMG-2`)
- optional hyphen + 1–2 letter suffix

`LOCATION_CODE_PAT = /^[A-Z]{1,4}(-\d{1,6}){1,3}(-[A-Z]{1,2})?$/i`

This is checked and skipped **before** any token is accepted as a SKU. Do not narrow this pattern.

### MIN_SKU_LEN for Picking List mode
`MIN_SKU_LEN = isPickingList ? 4 : 3`

4 in Picking List mode blocks 3-char noise (e.g. `333`) while allowing real 4-digit WMS product codes like `5603`, `8009`, `8101`, `8133`. Do NOT raise this back to 6 — that blocks legitimate short SKUs.

### OCR digit/letter confusion in order numbers (`fixOcrConfusions`)
Only triggered when extracted code is **7+ all-digit characters**.

**Leading fix** (`OCR_LEAD_MAP`): `5→S`, `8→B`, `6→G`
- `0` and `1` are NOT in the leading map — leading zeros are genuine in many codes.
- Example: `500037495` → `S00037495`

**Trailing fix** (`OCR_TRAIL_MAP`): `2→Z` and `7→Z`
- Z is routinely misread as 2 or 7 by OCR engines.
- Applied only when leading fix does not fire (they never both apply).
- Example: `010720262` → `01072026Z`, `010720267` → `01072026Z`

**Duplicate-Z fix**: When OCR reads a terminal Z as *both* a digit and Z (producing e.g. `010720267Z`), the pattern `^\d{6,}[27]Z$` strips the artifact digit → `01072026Z`. This fires on codes that are not all-digit.

**Do NOT merge these into one map or apply both at once.** Leading takes priority; trailing only fires if leading did not match.

### Scope — apply to ALL extracted document codes
`fixOcrConfusions` must be called on **every** extracted alphanumeric code field:
- order number (both inline and two-line extraction paths)
- reference, issue no, pick ticket
- batch/lot number

The 7+ all-digit guard means short numeric codes (SKUs like `5603`, batches like `533601`) are never touched. The duplicate-Z rule handles mixed digit+Z codes. **Do not apply to SKU tokens** — SKUs must match WMS records exactly.

### SKU token rejection rules
Before accepting a token as SKU, these checks run in order:
1. Length outside `[skuMinLen, 40]` → skip
2. In `SKIP_SKU` set → skip
3. **All-zero string** (`/^0+$/`) → skip (OCR noise, never a real product code)
4. **Matches `EXPIRY_DATE_PAT`** → skip (date tokens like `30/Jun/2028` are not SKUs)
5. Looks like a unit suffix (`100ml`, `250g`) → skip
6. Matches `LOCATION_CODE_PAT` → skip
7. Contains no digit → skip
8. Does not match `/^[A-Z0-9][A-Z0-9_\-]{2,}$/i` → skip (`/` is excluded to prevent date-like strings)

After a token passes all checks, a phantom-B correction is applied:
`/^([A-Z]{1,4})B(\d{3,}[A-Z]{0,2})$/` → `$1$2`
Tesseract sometimes inserts a spurious `B` between an alphabetic prefix and a digit body
(e.g. `PH6930` on the printed page → OCR outputs `PHB6930`). This strips it back.

## OCR Qty Parsing (lib/ocr-parse.js)

### Qty must be found BEFORE a UOM keyword, not as rightmost integer
`UOM_RE = /^(?:EACH|EA|PCS|PIECES|BOX|CTN|CARTON|CARTO|CARTOS|UOM)$/i`

Numeric batch numbers like `533601` and `517008` are all-digits and would be mistaken for qty
if we used rightmost-integer logic. Always prefer the integer before a UOM keyword; fall back to
rightmost integer only when no UOM is present.

### Batch/expiry extraction
After qty+UOM, columns follow: `/`, `CARTO`, `Total LHU (= repeated qty)`, `BatchNo`, `ExpiryDate`.
- Skip: `/`, UOM-like tokens, the repeated qty value
- Take: next alphanumeric token (2+ chars) → batch number (can be pure-digit like `533601` or letters like `RT`)
- Take: date-like token matching `\d{1,2}[/-]\w+[/-]\d{2,4}` → expiry date

## Betime scanning exceptions (server.js — `/api/scan/increment`)

1. **NP suffix**: product barcodes with a trailing `NP` are the same product as the
   plain code — `8006NP` scanned counts against order line `8006`, and scanning
   `8006` counts against a line listed as `8006NP`. Exact matches ALWAYS win first;
   the suffix fallback only fires when nothing matched as scanned, so orders that
   genuinely contain both `8006` and `8006NP` lines still count separately.

## Teach-on-scan learned barcodes (server.js)

- Unknown product barcodes scanned during picking can be taught: packer picks the
  order line, mapping saved to `db.learnedBarcodes` + `_learnedBarcodeMap`, audit-logged.
- PRIORITY INVARIANT: the official CODE2 listing ALWAYS wins over learned mappings
  (learned lookup is step 5, after all official steps, in `resolveBeTimeCode2`), and
  `/api/scan/learn-barcode` refuses (409) to teach a barcode the official map covers.
- Master reviews/removes learned entries: Administrator → WMS → Learned Barcodes.
- SKU ALIASES: when the official listing names a product differently from the order
  file (barcode → 9005 but order line says BC010), teaching stores a SKU alias pair
  in `db.learnedSkuAliases` instead (the official map is never modified). Aliases are
  tried at order-line matching, after exact + NP fallbacks.
- Per-order scan history: every increment/setqty/teach appends to `state.scanLog`
  (capped 800) — exported as the "Scan Log" sheet of the completion slip.

## Data lifecycle (server.js)

- ATOMIC WRITES: db.json persists via tmp+rename (`_persistDb`), serialized. Never
  revert to a bare fs.writeFile — a crash mid-write must not corrupt the db.
- SCAN JOURNAL: every order-state change appends to `DATA_DIR/scan-journal.ndjson`
  immediately; replayed at startup (last-wins per order, only if newer than stored
  state), then truncated. Protects the deferred-write window.
- AUTO-ARCHIVE: settled batches (all orders done/unprocessed) older than 60 days
  move to `DATA_DIR/archive/archive-YYYY-MM.json` daily. Completed-tab search hits
  archives via `/api/orders/archived?q=`; completion-slip falls back to
  `readArchivedBatch`. Audit ledger unaffected.
- NIGHTLY BACKUP: gzipped full backup to `DATA_DIR/backups/` (keep 14) + emailed
  via configured mail, after 02:00 SGT (30-min checks + 2-min post-boot catch-up).
- `/api/orders` accepts `?range=today|yesterday|week|all|range&from&to` — dashboard
  fetches only the selected window. Order rows include `uploadedAt` and `items`.

## Offline scan queue (public/app.js + /api/scan/increment eventId)

- Network-failed item scans are queued in localStorage (`is_offline_scans`),
  counted on screen as pending (⏳ rows, amber pill), and replayed on reconnect.
- IDEMPOTENCY: every queued event carries an eventId; increment ignores ids it
  has seen (state.scanEventIds, capped 100) so replays never double-count.
- Complete + auto-complete are BLOCKED while an order has unsynced scans.
- `/api/scan/resolve-cache` gives the client CODE2/learned/alias maps so
  offline scans resolve to the right line locally.

## Scan buffer — Enter handler (public/app.js `_globalScanKeydown`/`_scanBuf`)

`_scanBuf` is mirrored from `#itemScanInput`'s value on every keystroke while
that input is focused. The Enter-key branch must SET `_scanBuf = inp.value`,
never `+=` — the mirror has usually already caught the full typed value by
the time Enter fires, so appending double-counts it (e.g. a manually-typed
`5603` becomes `56035603` and fails to match any SKU). Bit us via a slow
`{delay}`-typed Playwright test; real scanner hardware rarely triggers it
because Enter usually arrives before the mirror's zero-delay timeout runs,
but manual keyboard entry (a packer typing a SKU by hand) hits it every time.

## Multi-carton orders (server.js — `activeCarton`/`addToActiveCarton`, /api/scan/new-carton)

- A big order can take more than one physical box. `state.cartons` is an array
  `[{ num, scans: {sku:qty}, startedAt, closedAt }]`, never reordered —
  `state.activeCartonNum` is an explicit pointer to whichever one is
  currently receiving scans (NOT always the last array entry — a packer can
  reopen an earlier carton, see below). Lazily created on first scan —
  orders that never split cartons end up with one implicit carton holding
  everything, so this is zero-friction for the common case, and legacy
  (pre-pointer, pre-feature) state falls back to treating the last carton
  (or `state.scanned` if no cartons at all) as active — never breaks old data.
- Every scan/count path (`increment`, `learn-barcode`, `setqty`) ALSO tallies
  into the active carton via `addToActiveCarton()`. `setqty` (an absolute
  correction) applies the delta (`newQty - oldQty`), not the raw value —
  this is also how removing an item from a reopened carton works: correct
  the qty down, the order-level total (and "pieces left") drops with it, so
  the shortfall naturally needs to be scanned into some carton again before
  the order can complete. No separate "remove" endpoint exists or is needed.
- `/api/scan/new-carton` ALWAYS creates a genuinely new carton (highest
  `num` + 1) and makes it active, regardless of which carton was previously
  active — even if the packer had switched back to edit an earlier one.
  Refuses (400) if the currently active carton is still empty — prevents
  phantom cartons from a stray double-tap.
- `POST /api/scan/carton/switch` `{orderNumber, cartonNum}` — reopens ANY
  existing carton (open or previously closed) as the active one. Toggling
  through cartons this way to add/remove items and "closing" it again is
  just: switch to it, use the normal scan/qty-correction inputs, switch to
  another (or hit "+ New Carton"). Contents are untouched by switching —
  it's purely a pointer change (plus `closedAt` bookkeeping).
- `POST /api/scan/carton/cancel-multi` `{orderNumber}` — "actually it all
  fits in one box": merges every carton's contents back into a single
  carton 1. Order-level `state.scanned` totals are untouched (already the
  sum across cartons); only the box-level breakdown collapses. 400 if the
  order was never split.
- CROSS-CARTON DUPLICATE CONFIRM: if a SKU already has qty > 0 in some OTHER
  carton but not yet in the active one, `/api/scan/increment` returns 409
  `{crossCartonConfirm, sku, activeCartonNum, existingCartonNums}` WITHOUT
  counting the scan. Client shows a confirm() dialog; resending with
  `{confirmCrossCarton: true}` forces it through. Only fires when
  `state.cartons.length > 1` (single-carton orders never see this) and is
  skipped entirely for offline-queued replays (`eventId` present) — there's
  no meaningful way to re-litigate a scan after the fact once the packer
  already made the physical call with no network to ask.
- On `/api/scan/complete`: if the LAST (highest-numbered) carton is still
  empty (e.g. an accidental "New Carton" tap right before completing), it's
  DROPPED rather than closed — never leave a phantom empty carton on the
  slip. Then EVERY carton still open gets `closedAt` set — covers both the
  normal case and a packer who reopened an earlier carton and completed the
  order without switching back to the latest one.
- Completion slip (`/api/completion-slip/...`) has a dedicated **Cartons**
  sheet: `Carton | SKU | Description | Qty`, one row per (carton, SKU).
- Scan overlay shows a "📦 Carton N" badge + "+ New Carton" button
  (`public/index.html` `#scanCartonWrap`); every scan-response handler in
  app.js updates `activeOrder.cartonNum`/`cartonCount` from the response.
  Prev/Next (◀▶) nav buttons and the "⟲ 1 Box" cancel-multi button are
  HIDDEN whenever `cartonCount <= 1` — a single-carton order (still the
  vast majority) looks exactly as it did before any of this existed.
- HANDS-FREE TRIGGER: scanning a printed control barcode (text `NEWCARTON`,
  case-insensitive; `NEW_CARTON_CODES` in app.js also accepts `NEW CARTON` /
  `NEW-CARTON` / `NEWBOX`) does the same thing as clicking "+ New Carton" —
  intercepted in `_flushScanBuf()` BEFORE the value is looked up as a SKU.
  Packers print their own reusable card via the 🖨 button next to "+ New
  Carton" (`printNewCartonCard()`, same window.open+JsBarcode+window.print
  pattern as `printWaybillLabel()`).
- PER-CARTON PACKING SLIP (📋 button, `printCartonSlip()` / `GET
  /api/scan/carton-slip/:orderNumber`): a READ-ONLY add-on, separate from the
  Waybill label and from the full completion slip. Defaults to the currently
  open carton; `?cartonNum=N` reprints any earlier one (works even after the
  order is done — nothing here checks `state.status`). Leads with the order
  number PLUS a Code128 barcode of it, so a carton is traceable back to its
  order even if the slip gets separated from the box — this is the
  traceability requirement a handwritten "Carton 2" alone doesn't satisfy.
  This endpoint and button write NOTHING — they only ever read
  `state.cartons`; do not let this drift into touching scan/complete state.
- MANDATORY LABEL PROMPT (`showCartonLabelPrompt()`, `#cartonLabelOverlay`):
  tells the packer exactly what to write on a carton — `{orderNumber}-{NN}`,
  zero-padded — and blocks further scanning until confirmed. Fires at THREE
  points: (1) inside `enterItemsPhase()`, for carton 1, the moment the scan
  overlay opens — a packer writes it on the box before ever making their
  first scan, whether or not the order ever splits; (2) inside
  `requestNewCarton()`, for the carton just being closed (whose number is
  `activeOrder.cartonNum` BEFORE it's reassigned to the new one) — skipped
  if that carton was already confirmed (always true for carton 1, since (1)
  already covered it); (3) inside `doCompleteOrder()`, for the LAST carton
  (`cartonCount`) — that one never goes through "closing" since nothing ever
  supersedes it, so completion is the only point it gets labelled (unless
  already confirmed some other way). `cartonLabelConfirmed(order, num)`
  checks `order.cartons[].labelConfirmed` before every fire so the same
  carton is never prompted twice. Runs for EVERY order now, including ones
  that never split — only the split/complete prompts stay conditional on
  `cartonCount > 1`. The "blocking" is real, not cosmetic: it's a
  `.modal-overlay`, and `_globalScanKeydown` already refuses to intercept
  scans while any modal overlay is open, so no separate gating logic was
  needed. Dismissible by clicking "I've Written It" OR by pressing ANY key
  (a capture-phase `keydown` listener on `document`) — a packer who's
  written the label and starts typing/scanning the next SKU shouldn't need
  to also reach for the mouse. Still a genuine action tied to something the
  packer actually does (not a timer), so `labelConfirmed` keeps meaning
  what it says; the dismissing keystroke isn't swallowed either — if it was
  the first character of the next scan, `_globalScanKeydown` still sees it
  once the overlay is hidden and processes it normally. Confirming marks
  `labelConfirmed = true` locally, then POSTs to
  `/api/scan/carton/label-confirmed`, which PERSISTS `carton.labelConfirmed`
  server-side (lazily creating `state.cartons` via `activeCarton()` if this
  fires before any scan) plus an audit-log entry (`scanLog` kind
  `carton_labeled`) — deliberately does NOT set `state.status = 'processing'`,
  since a label confirmation alone shouldn't mark an untouched order as
  started. A failed request never blocks the UI, since the modal itself
  (not this call) is what enforces the pause.

## IdealInbound — receiving POs/ASNs and returns (server.js `/api/inbound/*`, public/app.js)

- Runs the outbound picking idea in reverse: goods arrive across one or more
  boxes instead of being packed into them. Reuses the exact same carton
  primitives as outbound (`activeCarton`, `addToActiveCarton`,
  `appendScanLog`) since a box is a box regardless of direction — but is
  otherwise a fully separate module (own `db.inbound[]` array, own
  `/api/inbound/*` endpoints, own tab + scan overlay in the client) so none
  of it can regress outbound scanning.
- Flat data model — `db.inbound[]` is an array of job records, NOT nested
  under a batch like outbound orders are, because one upload or one
  "+ New Return" IS the whole job (no need for the batch/order two-layer
  split outbound has for one file containing many orders). Each record:
  `{ id, type: 'po'|'return', reference, source_name, client_name,
  uploaded_at, uploaded_by, filename, lines: [{sku, description,
  expected_qty}], state: { status, scanned, cartons, activeCartonNum,
  conditionTotals, scanLog } }`.
- TWO JOB TYPES:
  - `'po'` — an uploaded PO/ASN file (`parseInboundFile()`, independent of
    `parseUploadedFile`/`detectColumnMap` in lib/keyfields.js since those are
    tuned for outbound picking lists with columns receiving doesn't have).
    Auto-detects SKU/Description/Qty columns by header name. Scanning
    matches against `lines` like outbound does, but an unlisted SKU is
    still ACCEPTED (not blocked) — a shipment containing something not on
    the paperwork is routine and must still be logged; it just has no
    "expected" qty to compare against on the receiving screen.
  - `'return'` — created manually via `POST /api/inbound/return`, no
    expected list at all. Every scan carries a `condition`
    (`straight_to_inventory` | `damaged` | `kiv`, default
    `straight_to_inventory`), rolled up into
    `state.conditionTotals[sku][condition]` — `state.scanned[sku]` itself
    stays a condition-agnostic total so the shared carton functions never
    need to know conditions exist.
- COMPLETION NEVER HARD-BLOCKS. `POST /api/inbound/:id/complete` for a
  `'po'` job compares scanned vs expected and returns 409
  `{needsConfirm, mismatches, extras}` (mismatches = wrong qty, extras =
  unlisted SKUs) instead of outbound's harder stop — receiving discrepancies
  are routine and must still be recorded, not stuck. Resending with
  `{force:true}` completes anyway. `'return'` jobs have no expected qty so
  they always complete on the first call. Same "drop the empty trailing
  carton, close every still-open one" logic as outbound's `/complete`.
- Carton mechanics are the same story as outbound, endpoint-for-endpoint:
  `new-carton`, `carton/switch`, `carton/cancel-multi`,
  `carton/label-confirmed`, `carton-slip` all mirror their outbound
  counterparts exactly, scoped by `:id` instead of `:orderNumber`. The
  MANDATORY LABEL PROMPT behaves identically too — carton 1 is labelled the
  moment `openInboundReceiving()` opens the job (before the first scan),
  later cartons are labelled when sealed (another split) or at completion
  (the last carton, which never goes through "closing"). The client reuses
  the exact same `#cartonLabelOverlay` DOM (only one overlay is ever open at
  a time) via a parallel `showInboundLabelPrompt()`/`inboundCartonLabelConfirmed()`
  pair, rather than parameterizing the outbound `showCartonLabelPrompt()` —
  kept deliberately separate so a change to one flow's label logic can never
  silently affect the other.
- NOT YET BUILT (intentionally out of scope for v1, flagged rather than
  silently skipped): no claim/lock system (outbound's one-packer-per-order
  guarantee has no inbound equivalent yet — fine for a single active
  receiver, would need the same `claimedBy`/`claimedAt`/stale-claim pattern
  outbound uses if multiple people receive concurrently), no receiving
  report/audit-log integration, no email alerts on discrepancy.

## Report data retention (server.js — `db.auditLog` / `AUDIT_ARCHIVE_AFTER_DAYS`)

- Every report reads from `db.auditLog`, which otherwise grows forever (the
  same "db.json must stay small" problem batches had). Entries older than
  **180 days** move to `DATA_DIR/archive/audit-archive-YYYY-MM.json` (daily
  job, `runAuditLogArchive()` — mirrors `runAutoArchive()` for batches).
- `readAuditLogForRange(db, from, to)` transparently merges live +
  archived months whenever a report's requested `from` reaches past what's
  still live, so every report can filter/toggle across **at least 6 months**
  of history regardless of how long ago the data happened. Fast path: if
  `from` is within the live window, archive files are never touched.
- This is a read-through, not a migration — archived months are never
  re-merged into `db.auditLog`; they're read fresh from disk per report
  request that needs them.
- **Retention already exceeds the 12-month minimum, audited but unchanged.**
  Neither batches (archived after 60 days) nor the audit log (archived after
  180 days) are ever DELETED — `runAutoArchive()`/`runAuditLogArchive()` only
  ever move data from the live `db.json` into permanent monthly archive
  files on disk; nothing purges those files afterward. The only things that
  actually delete data are: (1) explicit admin-requested + Master-approved
  order/batch deletion, (2) the manual Master "Reset" button — both
  deliberate, on-demand actions, never a scheduled sweep. Nightly backup
  rotation (`runNightlyBackup`, keep 14) only prunes redundant point-in-time
  gzip snapshots, not the underlying data. No archive TABLE is needed beyond
  what already exists — the monthly JSON archive files already hold
  everything indefinitely, and since the two dashboards below only ever
  query the last 3 days, they read `db.auditLog` directly and never need to
  touch archives at all (3 days is always inside both the 60- and 180-day
  live windows).

## Admin/Warehouse dashboards — Activity Overview & Station Throughput (server.js `/api/master/dashboard/*`, public/app.js)

- Both read from the same `order_completed` audit-log events every other
  Administrator report already uses (`completionAuditData()` at completion
  time — `order`, `client`, `operator`, `pieces`, `lines[]`, `endTime`) — no
  new data source, no new retention concern (see above).
- `previousSgDays(3)` returns the 3 full SGT calendar days immediately
  BEFORE today, oldest first — today is excluded since it's still in
  progress, not a completed day. `completedOrderEventsForDays()` filters
  `order_completed` events to that window and tags each with its SGT day
  (`sgDateStr`, the same Asia/Singapore helper the nightly backup uses) —
  get this right deliberately, since naive UTC date-slicing (what the
  `daily-summary`/`productivity` reports already do) would misbucket events
  near the UTC/SGT day boundary.
- **"Station" = the packer/user who completed the order** (`operator` on
  the completion event). This system has no separate physical packing-
  station ID — one logged-in user is the closest available proxy, same
  convention Live Activity already uses for "active packers". If a real
  multi-station-per-user (or multi-user-per-station) setup is ever needed,
  this mapping would need revisiting.
- ACCESS CONTROL — server-enforced, not just UI hiding, mirroring the exact
  pattern `/api/master/report/:kind` already uses (NOT the pure
  `checkMaster()` pattern Live Activity/Pending Deletions use, which only
  checks the master-key header and would let anyone who extracted the
  client-side `LOG_PASSWORD` through regardless of role):
  - `activity-overview`: `x-master-key` header OR `role === 'admin'`, else
    403. Warehouse-role users get a real 403 even if they call the endpoint
    directly — verified in testing, not just hidden client-side.
  - `station-throughput`: `x-master-key` header OR `role === 'admin'` OR
    `role === 'warehouse'`, else 403 — today that's every valid role, but
    written explicitly so a future restricted role doesn't silently gain
    access.
- UI placement follows existing precedent: Activity Overview is a new
  `data-admin-tab="overview"` section inside the Administrator panel
  (`#logOverlay`), next to Live Activity — consistent with it being
  Admin/Master-only and the Administrator button already being hidden from
  warehouse client-side. Station Throughput can't live there (warehouse
  can't open Administrator at all), so it's a button + modal
  (`#stationThroughputOverlay`) on the Orders tab instead, which warehouse
  users can already access. Both reuse `.dcs-wrap`/`.dcs-table` for
  horizontal-scroll-on-mobile — the exact fix applied earlier this session
  after Live Activity's tables overflowed on phone screens.
- Station Throughput renders as TWO separate tables (Orders per Station,
  Lines per Station) rather than one table with day+metric sub-columns —
  fewer columns keeps it readable on a phone screen, which the task
  explicitly allowed as an alternative to sub-columns.

## Git

- Branch: `claude/order-processing-wms-fulfillment-6mf8o4`
- Commit suffix required:
  ```
  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DuieZfw6EN7FaZSYKtjtbV
  ```
- Never push to any other branch without explicit permission
- Never skip hooks (--no-verify)
- Do NOT create a pull request unless explicitly asked

## Auth

- Master key: `process.env.MASTER_KEY || '201432547E'`
- User auth: `x-auth-token` header checked against `activeSessions` Map
- Admin routes use `checkMaster(req, res)`
