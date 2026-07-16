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

## Scan-to-find-order (public/app.js `waybillLookupGo`, server.js `/api/waybill-lookup`)

The "Scan waybill number or order number to find order…" bar on the Orders
tab must accept every number actually printed/barcoded on a picking list —
not just `order_number`. Where the GI number ends up depends on the upload
path:
- Keyfields picking-list **PDF** upload (`parsePdfPicklistDetailed`): the
  `GI-\d{4,}` barcode becomes `order_number` directly, so it already matches.
- XLSX/CSV upload with an "Issue No" / "iWMS GINo" column
  (`detectColumnMap` in lib/keyfields.js): the same GI number instead lands
  in `issue_no`, a DIFFERENT field from `order_number`.
Both the client-side instant match (`directMatch` in `waybillLookupGo`) and
the server-side fallback (`/api/waybill-lookup`) must check `issue_no`
alongside `order_number`/`pick_ticket`/`waybill_number`/`po_number` — missing
this field meant any order uploaded via the XLSX/CSV path could never be
found by scanning its GI-number barcode, even though the number was
captured and stored correctly. Both call sites use the same `strip0`
leading-zero-tolerant comparison as the other identifier fields.

DISPLAY — `issue_no`, whenever present, also needs to be visible, not just
scannable: shown as a `GI: <value>` pill on the Orders-list row (next to the
`idealscan_code` job-code, `public/app.js` `renderOrdersList`) and as a
`meta-pill-gi` pill in the scan overlay header (`enterItemsPhase`). Already
included in the Completed-tab free-text search (`ordersView === 'completed'`
filter) alongside order_number/waybill_number/pick_ticket/po_number.

## Duplicate-line upload safeguard (server.js `findDuplicateLineWarnings`)

Two lines in the SAME order sharing SKU + batch_number + expiry_date is
ambiguous on sight — it could be a genuine split pick across two bins (sum
the quantities) or a data-entry duplicate (one of them shouldn't be there).
`findDuplicateLineWarnings(orders)` detects this at `/api/preview` time (the
step that populates the Confirm-Upload modal, for every file type — PDF,
XLSX, CSV all pass through the same `summarizeOrders()` call site) and
returns a plain-English message per duplicate group, e.g. "SKU 7010 appears
2 times in this order (batch W0492A_1), expiry 07/Jan/2029 — combined qty
is 12."

NOT blocking, and deliberately NOT wired into the existing `flagged` /
"Review flagged order(s) — amend quantities" table that the PDF
picking-list parser already uses for its own issues (missing SNo, total
mismatch). That table matches rows by `order_number + sku` only — if two
duplicate rows share that exact key, editing ONE row's quantity input would
silently apply to the OTHER (untouched) row too, since the server-side
adjustment-apply loop (`/api/upload`'s `adjustments` handling) matches every
row with that key, not a specific row instance. Instead, `duplicateWarnings`
is a separate read-only field in the `/api/preview` response, rendered as
its own info-blue banner (`#confirmDuplicateWarnings` /
`.confirm-dup-warnings`) below the (amber) `#confirmErrors` block — visible,
but never editable. Confirmed via the actual bug report this was built for:
the uploaded order's WMS export (traced field-by-field) showed exactly one
row per SKU with the correct combined total, proving IdealScan's parsing
was not at fault — the discrepancy was between the source order file and a
printed picking list that visually repeated a line. This safeguard exists
so that discrepancy is caught at upload time instead of requiring this kind
of after-the-fact investigation.

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
- AUTO-ARCHIVE: settled batches (all orders done/unprocessed) older than 12 months
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

SHARED WITH IDEALINBOUND — `_scanTarget` ('outbound' | 'inbound', set by
`attachGlobalScanCapture(target)`) is what lets ONE global keydown listener
serve both `#itemScanInput` (outbound) and `#inboundScanInput` (IdealInbound
receiving) — `_scanInputId()` resolves to whichever is current, and
`_flushScanBuf()` routes the finished code to `handleItemScan()` or
`inboundScan()` accordingly. Only one of the two screens is ever open at
once, so a single shared target is safe. `openInboundReceiving()` calls
`attachGlobalScanCapture('inbound')`; both ways of leaving it (the "back"
button and a successful End Receipt) call `detachGlobalScanCapture()` —
miss either one and the listener leaks into whatever's opened next.
IdealInbound's receiving screen originally only had its OWN plain
`keydown`-on-Enter listener directly on `#inboundScanInput` (no global
capture, no redirect-if-unfocused) — meaning a scanner firing while focus
had drifted elsewhere (a very normal thing to happen on a real device)
silently went nowhere, which is the bug this was built to fix. That
listener is now a no-op guard (`e.preventDefault()` only, mirroring
outbound's own `itemScanInput` listener) so Enter doesn't fire through both
listeners and double-count the scan — the global capture does the actual
submission for both screens now.

## Scan row layout — `.big-scan-input` must keep `min-width: 0` (public/styles.css)

`.item-scan-wrap` (both outbound's scan overlay and IdealInbound's receiving
screen use this same class) lays out `.scan-icon-prefix` + `.big-scan-input`
+ a fixed-width button (`.btn-camera-open`, etc.) as a flex row, and has
`overflow: hidden` — so an overflowing child is silently CLIPPED, not
visibly broken. Flex items default to `min-width: auto`, which refuses to
shrink an `<input>` below its browser-default intrinsic width; combined
with the fixed-width sibling button, the row's total content width can
exceed a real narrow phone's viewport even though it looks fine at desktop
widths or in a 412px emulator. `.big-scan-input` sets `min-width: 0` to
override this and let the input actually shrink. Found via a real-device
screenshot showing IdealInbound's per-scan camera button clipped to an
invisible sliver; since the class is shared, the same latent bug applied
to outbound's `#openCameraBtn` too, and the one CSS fix resolves both.

## Camera barcode scanning — shared between outbound and IdealInbound (public/app.js)

The live-viewfinder `BarcodeDetector`-based scanner (`openCameraScanner()`,
`#cameraScanOverlay`, single/batch/label modes) originally belonged only to
outbound's scan overlay (`#openCameraBtn`). IdealInbound's receiving screen
had a camera button too, but it only attached a documentation photo
(`#inboundScanPhotoBtn`) — no way to scan a barcode with the phone's camera
there, forcing manual typing on phones with no physical scanner.

Rather than duplicate the scanner, `openCameraScanner(target)` now takes an
optional `target` (`'outbound'` default, or `'inbound'`), stored in
`cameraScanTarget`, and a `dispatchCameraScan(val)` helper routes each
detected/OCR'd value to `handleItemScan()` (outbound's offline-aware queue)
or `inboundScan()` (inbound's direct scan call) accordingly. `closeCameraScanner()`
returns focus to whichever input opened it (`itemScanInput` vs
`inboundScanInput`). `#inboundCameraScanBtn` (next to the existing photo
button in IdealInbound's scan row) opens the same overlay with
`target: 'inbound'`.

**Gotcha avoided**: both trigger buttons must wrap the call in an arrow
function (`() => openCameraScanner('outbound')`), never pass the function
directly as the event handler — `addEventListener('click', openCameraScanner)`
would hand the click's `MouseEvent` as the `target` argument, silently
breaking the default.

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
- ORDER-LEVEL SPLIT CONFIRM (client-only, `requestNewCarton()` in app.js):
  before even calling `/new-carton`, if the order's total scanned pieces are
  less than total ordered, a `confirm()` warns that starting a new carton
  now means a SKU could end up split across boxes, and lets the packer
  cancel. This is a heads-up at the point of DECIDING to split — the
  existing CROSS-CARTON DUPLICATE CONFIRM below is the reactive check that
  catches the actual split once a specific SKU gets scanned twice across
  cartons; the two are independent and both still fire.
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
  `{ id, serial, type: 'po'|'return', reference, source_name, client_name,
  uploaded_at, uploaded_by, filename, lines: [{sku, description,
  expected_qty}], state: { status, scanned, cartons, activeCartonNum,
  conditionTotals, scanLog } }`.
- SERIAL NUMBER — `serial` (`nextInboundCode()`/`backfillInboundCodes()`,
  mirrors outbound's `idealscan_code`/`nextIdealscanCode()` exactly, own
  per-day counter key `db.inboundCodeSeq` so it never collides with or
  depends on outbound's numbering) gives every inbound record a permanent
  `IB-YYMMDD-NN` cross-reference, assigned once at creation (upload or
  "+ New Return") and shown in the Inbound list's Serial column and as a
  pill on the receiving screen.
- TWO JOB TYPES:
  - `'po'` — an uploaded PO/ASN file (`parseInboundFile()`, independent of
    `parseUploadedFile`/`detectColumnMap` in lib/keyfields.js since those are
    tuned for outbound picking lists with columns receiving doesn't have).
    XLSX/CSV: auto-detects SKU/Description/Qty columns by header name. PDF
    (`parseAsnPdfFile()`, reuses `extractPdfPageTexts()`): a best-effort
    heuristic, NOT the same tuned parser as the outbound Keyfields
    picking-list PDF (`parsePdfPicklistDetailed()`) — real ASN/PO PDFs vary
    supplier to supplier with no fixed layout, so this just looks for lines
    shaped like `SKU  description text  qty` (SKU first token, integer qty
    last token) and fails loudly (blocks the upload, no partial/silent PO)
    if it can't find any such lines, rather than guess. Deliberately does
    NOT reuse the outbound `LOCATION_CODE_PAT` filter — that shape (1-4
    letters + digit groups) is exactly what an ordinary SKU looks like here
    (`URI-8001`, `NUX-5450`), so applying it would reject legitimate SKUs;
    the ambiguity that filter guards against only exists inside a picking
    list, which prints location and SKU as separate columns. Scanned/
    image-only PDFs (no selectable text layer) aren't supported — told to
    use XLSX/CSV instead, same as when zero lines are recognized. Scanning
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
- REOPEN UNTIL "END RECEIPT" — nothing except `POST /api/inbound/:id/end-receipt`
  (client button `#inboundCompleteBtn`, labelled "End Receipt") ever sets
  `state.status = 'done'`. Closing the receiving overlay, switching tabs, or
  coming back tomorrow all leave the job at `pending`/`processing`, so the
  Inbound list keeps showing "Receive" (not "View") and `openInboundReceiving()`
  just resumes from the stored `state` — a packer can walk away and return as
  many times as needed before ending it. This is also why the list's
  Receive/View split (question packers sometimes ask) is exactly one field:
  `job.status === 'done'`, set by exactly one action.
- END RECEIPT NEVER HARD-BLOCKS. `end-receipt` for a `'po'` job compares
  scanned vs expected and returns 409 `{needsConfirm, mismatches, extras}`
  (mismatches = wrong qty, extras = unlisted SKUs) instead of outbound's
  harder stop — receiving discrepancies are routine and must still be
  recorded, not stuck. Resending with `{force:true}` ends it anyway. `'return'`
  jobs have no expected qty so they always end on the first call. Same "drop
  the empty trailing carton, close every still-open one" logic as outbound's
  `/complete`. (Renamed from `/api/inbound/:id/complete` and the
  `inbound_complete` audit event → `inbound_end_receipt` for clarity; the
  historical `logAudit` field-collision note below still refers to the old name.)
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
  outbound uses if multiple people receive concurrently), no email alerts
  on discrepancy.
- REPORT: "Inbound Receiving" (`kind === 'inbound'` in `/api/master/report/:kind`,
  added to `ADMIN_REPORT_KINDS` so admin logins get it too, not just the
  master key) — pulls straight from live `db.inbound` (like `aging` does for
  outbound, not audit-log-derived) filtered by `uploaded_at` within the
  report's from/to range. Two sheets: "Inbound Jobs" (one row per job — serial,
  type, reference, source, client, status, expected/scanned totals, carton
  count) and "Inbound Lines" (one row per job×SKU actually scanned or
  expected, with the return-only condition breakdown as three columns).
- RECEIVING PHOTOS — two entry points, both hitting `POST
  /api/inbound/:id/photo` (multipart, optional `sku` field): (1) a per-scan
  camera button (`#inboundScanPhotoBtn`) next to the scan input, tagged to
  `lastScannedInboundSku` (the client tracks this — refuses with an alert if
  nothing's been scanned yet, since an untagged "per-scan" photo would be
  meaningless); (2) a general "Add Photo" button in the header, untagged
  (`sku: null`), for a shot of the box/shipment as a whole. Bytes are
  written to `DATA_DIR/inbound_photos/<jobId>/<photoId>.<ext>` — same
  reasoning as WMS/waybill files: keep them OFF the JSON blob, db.json only
  stores `{id, sku, caption, uploadedBy, uploadedAt}` per photo. Serving
  (`GET /api/inbound/:id/photo/:photoId`) is registered BEFORE the blanket
  `requireAuth` middleware, using `requireAuthOrToken` instead — same
  pattern as the existing PDF viewers — so plain `<img src="...?token=">`
  tags work (they can't send the `x-auth-token` header the way `fetch()`
  can). Thumbnails open a small lightbox (`#inboundPhotoLightbox`) on
  click; no delete — this is additive/read-mostly like the carton slip,
  not a place state gets removed.
- DELETION — mirrors the outbound Orders admin-request/Master-approve
  workflow exactly, adapted for the fact that IdealInbound has no
  batch/record split (one upload or one "+ New Return" already IS the
  whole job — see the module note above), so there's only ONE deletion
  path per record rather than outbound's separate "delete whole batch" vs
  "delete one order":
  - `DELETE /api/master/inbound/:id` — Master direct delete (checkMaster),
    requires a `reason`, blocked once `state.status === 'done'` (same rule
    outbound orders use — completed work is never deletable, by either
    path).
  - `POST /api/inbound/:id/deletion-request` — Admin-role + the admin's
    OWN password re-entered as a confirmation step (not the master key),
    sets `rec.pending_deletion = {reason, requestedBy, requestedAt}`.
    Wrong password → 403 (never 401 — a 401 here would trip the client's
    global "session expired" handler and force-reload, since the session
    token itself is still valid; only this secondary password check
    failed). Blocked if already `done` or already has a pending request.
  - `GET /api/master/inbound-pending-deletions` /
    `POST .../:id/approve` / `POST .../:id/reject` — Master reviews.
    Approve calls `removeInboundRecord()` (splices from `db.inbound[]` +
    `fs.rmSync`s the job's whole photo directory). Reject just clears
    `pending_deletion`, record stays.
  - UI: the 🗑 button on each Inbound list row (admin-only, hidden once
    `status === 'done'` or already pending) opens `#deleteInboundOverlay`
    (reason + own password — literally the same modal shape as
    `#deleteOrderOverlay`, just a separate instance). A row with a pending
    request shows a red "Pending Deletion" badge next to its status, same
    as orders. The Administrator → Pending Deletions tab gained a SECOND
    table ("Inbound Deletion Requests") below the existing orders one
    rather than merging them into one table — the two record shapes don't
    line up well enough (order progress is scanned/total qty; inbound is
    scanned/expected and only meaningful for `'po'` jobs) to share columns
    cleanly. The nav badge count is the SUM of both tables' pending counts.
  - Caught during testing: `logAudit(type, data)` builds
    `{ type, at, ...data }` — spreading `data` AFTER the `type` argument
    means any `data.type` key silently overwrites the real event type.
    Every inbound `logAudit(...)` call that wanted to record po-vs-return
    (including one pre-existing in `inbound_complete`, predating this
    deletion work) was accidentally doing exactly that, corrupting
    `auditLog` entries' `type` field to `"po"`/`"return"` instead of e.g.
    `"inbound_complete"`. Fixed by renaming that data field to `jobType`
    everywhere. Any FUTURE `logAudit()` call anywhere in this file must
    avoid a bare `type` key in its data object for the same reason.

## Report data retention (server.js — `db.auditLog` / `AUDIT_ARCHIVE_AFTER_DAYS`)

- Every report reads from `db.auditLog`, which otherwise grows forever (the
  same "db.json must stay small" problem batches had). Entries older than
  **12 months (365 days)** move to `DATA_DIR/archive/audit-archive-YYYY-MM.json` (daily
  job, `runAuditLogArchive()` — mirrors `runAutoArchive()` for batches).
- `readAuditLogForRange(db, from, to)` transparently merges live +
  archived months whenever a report's requested `from` reaches past what's
  still live, so every report can filter/toggle across **the full 12-month**
  retention period regardless of how long ago the data happened. Fast path: if
  `from` is within the live window, archive files are never touched.
- This is a read-through, not a migration — archived months are never
  re-merged into `db.auditLog`; they're read fresh from disk per report
  request that needs them.
- **Full 12-month retention enforced.** Neither batches (archived after 12 months) nor
  the audit log (archived after 12 months) are ever DELETED — `runAutoArchive()`/`runAuditLogArchive()`
  only ever move data from the live `db.json` into permanent monthly archive
  files on disk; nothing purges those files afterward. The only things that
  actually delete data are: (1) explicit admin-requested + Master-approved
  order/batch deletion, (2) the manual Master "Reset" button — both
  deliberate, on-demand actions, never a scheduled sweep. Nightly backup
  rotation (`runNightlyBackup`, keep 14) only prunes redundant point-in-time
  gzip snapshots, not the underlying data. No archive TABLE is needed beyond
  what already exists — the monthly JSON archive files already hold
  everything indefinitely, and since the two dashboards below only ever
  query the last 3 days, they read `db.auditLog` directly and never need to
  touch archives at all (3 days is always inside the 12-month
  live window).

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

## Transport Management — TMS Importer (server.js — `/api/transport/*`)

Complete TMS (Transportation Management System) integration for importing delivery
schedules from BETIME and order trackers from Outright. Creates transport
requests from Excel imports.

### Core Functions (lib/tms-importer.js)

**`parseExcelFile(buffer)`** — Parse XLSX workbook
- Input: File buffer from multipart upload
- Output: `{ sheetName: [rows], sheetName2: [rows], ... }`
- Uses XLSX library for robust multi-sheet parsing

**`detectFormat(row)`** — Auto-detect Excel format
- Examines header row for known column names
- Returns: `'betime' | 'outright' | 'standard' | 'unknown'`

**`importBetimeDeliveries(rows)`** — Convert BETIME schedule to orders
- Input: Array of BETIME rows (PO NO, CUSTOMER, ADD 1, DELIVERY DATE, etc.)
- Output: Array of customer objects ready for order creation
- Deduplicates by `poNo + deliveryDate`
- Extracts: customer name, address, zip, SKU count

**`importOutrightOrders(rows)`** — Convert Outright tracker to orders
- Input: Array of Outright rows (Customer Name, PO Number, Invoice, etc.)
- Output: Array of customer objects ready for order creation
- Supports multi-sheet workbooks (Clinics, Spa, Hospital tabs)

**`createOrdersFromImport(importData, db)`** — Persist to database
- Input: `{ customers: [], adjustments: [] }` + db instance
- Output: `{ created: [ids], updated: [ids], skipped: [errors] }`
- Creates new transport request records in `db.transport`
- Updates existing requests if customerId already exists
- Never overwrites, only appends or merges metadata

### API Endpoints

**`GET /api/transport`** — List all transport requests
- Returns array of request summaries (id, clientName, status, createdAt)

**`POST /api/transport`** — Create new request manually
- Body: `{ clientName, items?, shipping? }`
- Returns: full request object with auto-generated ID

**`GET /api/transport/:id`** — Fetch request details
- Returns: complete request object including shipping address, items, source

**`POST /api/transport/:id/update`** — Update request status/metadata
- Body: `{ status?, clientName?, shipping?, notes? }`
- Logs audit event with new status
- Returns: updated request object

**`POST /api/transport/import/betime`** — Import BETIME delivery schedule
- Multipart: `file` (XLSX)
- Parses file → detects format → extracts deliveries → creates orders
- Returns: `{ success: true, imported: { format, ordersCreated, ordersUpdated, skipped, summary } }`
- Logs audit event with counts

**`POST /api/transport/import/outright`** — Import Outright order tracker
- Multipart: `file` (XLSX)
- Optional body: `{ sheet: "Clinics|Spa|Hospital" }` (defaults to Clinics)
- Same flow as BETIME
- Returns same response structure

### Client-Side (public/app.js)

**`renderTransportTab()`** — Fetch and display transport requests
- GET /api/transport
- Render HTML table with ID, Client, Status, Date columns
- Wire up View buttons for each request

**`importTransportFile(file, format)`** — Handle file upload
- Accepts: File object + format ('betime' | 'outright')
- POST to `/api/transport/import/{format}`
- Display status bar with success/error feedback
- Auto-refresh list on success

**Event Handlers**
- `#transportBetimeFileInput` — File picker for BETIME
- `#transportOutrightFileInput` — File picker for Outright
- Browse buttons open file dialogs

### UI (public/index.html)

**Tab Structure**
- Transport tab button in sidebar (between Inbound and Labels)
- `#tab-transport` section with two main areas:
  1. **Import Cards** — Two-column grid (BETIME | Outright)
     - Each card has drag-drop zone and "Browse Files" button
     - Icons and labels for each format
  2. **Transport Requests List** — Standard table view
     - Shows all imported/created requests
     - Empty state when no requests

**Status Bar**
- `#transportImportStatus` — Shows import progress/results
- CSS classes: `progress` (blue), `success` (green), `error` (red)

### Database Schema

**`db.transport[]`** — Array of transport request objects
```javascript
{
  id: "ORD-1014171733",              // From PO NO or auto-generated
  clientId: "1014171733",            // Source customer ID
  clientName: "Customer Name",       // Display name
  channel: "tms-import",             // Source: tms-import or manual
  createdAt: "2026-07-15T09:00:00Z", // ISO timestamp
  status: "pending",                 // pending|assigned|in-transit|delivered|cancelled
  currency: "SGD",
  notes: "Imported from BETIME",
  items: [{ sku, name, qty, unitPrice }],
  shipping: {
    recipient: "...",
    addressLine1, addressLine2,
    city, state, zip, country,
    phone, email
  },
  subtotal: 0, shippingCost: 0, tax: 0, total: 0,
  source: {
    importedAt: "2026-07-15T09:05:00Z",
    customerId: "1014171733",
    format: "betime",  // betime | outright | standard
    deliveryDate: "2026-07-15T14:00:00Z",
    skuCount: 50,
    invoiceNumber: ""
  },
  updatedAt?: "...",  // Set on update
  geocoded?: { lat, lng }  // Optional: for route planning
}
```

### Audit Logging

Logged events:
- `tms_import_betime` — `{ ordersCreated, ordersUpdated, skipped }`
- `tms_import_outright` — `{ ordersCreated, ordersUpdated, skipped }`
- `transport_created` — `{ id, client }`
- `transport_updated` — `{ id, status }`

### Testing

Verified with real files:
- ✅ BETIME_DELIVERY_SCHEDULE__PLANNER.xlsx (90+ deliveries)
- ✅ Outright_Order_Tracker_Spa_Hospitals_Clinics.xlsx (200+ orders)
- ✅ Duplicate deduplication (seen set by poNo + deliveryDate)
- ✅ Error handling for missing addresses/fields
- ✅ Partial import (skip invalid rows, log skipped)

### Maps — Leaflet + OpenStreetMap, NOT Google Maps

The Transport tab map (`initTransportMainMap`, `initTransportMap`,
`displayDriverLocations` in public/app.js) uses **Leaflet 1.9.4 vendored at
`public/vendor/leaflet/`** with OpenStreetMap tiles — no API key, no billing
account, works out of the box. Google Maps was removed after its key failed
with "Oops! Something went wrong" (invalid key/no billing); do NOT reintroduce
a keyed map service. Marker positions come from `getPostalCodeCoords()`, which
maps the FIRST 2 DIGITS of any Singapore 6-digit postal code (the postal
sector) to its district centroid (`SG_SECTOR_TO_DISTRICT` /
`SG_DISTRICT_COORDS`, all 28 districts) plus a small deterministic jitter so
same-district jobs don't stack. This also powers the Haversine distances used
by route optimization. Marker number labels are Leaflet tooltips styled by
`.leaflet-tooltip.map-marker-label` (the extra `.leaflet-tooltip` specificity
is REQUIRED — leaflet.css loads after styles.css and would otherwise win with
its white box styling).

### Single unified upload — ONE import card only

The Upload Jobs modal has exactly ONE import card (`#transportImportFileInput`)
posting to the unified `POST /api/transport/import`. The three format-specific
cards (BETIME / Outright / generic) and their endpoints are GONE — the server
detects the format by analysing column CONTENT (attribute-based detection in
lib/tms-importer.js), so users never pick a format. CSV files get a client-side
column preview first (`analyzeAndPreviewFile`); XLSX is binary so it goes
straight to the server. Do not add back per-format upload buttons.

### Driver auto-assignment + plan approval (Preplanned → Confirmed)

Job lifecycle: `pending` → `preplanned` (plan approved) → `confirmed`
(warehouse scanning completed the matching order) → `delivered`.

- "Generate AI Routes" auto-assigns drivers ROUND-ROBIN per route
  (`autoAssignDrivers()` in app.js; drivers come from Driver Details /
  `window.drivers`). Every stop's dropdown is prefilled; the user amends any
  dropdown or stop order before approving. Nothing is saved at generation time.
- "✓ Assign Routes to Drivers" opens a summary modal grouped by driver
  (`#planApprovalModal`, built dynamically) for the user to approve or go back
  and amend. Only on Approve does the client POST
  `/api/transport/plan/approve` — the server sets each job to `preplanned`
  with `assignedDriver`/`assignedDriverName`/`routeNum`/`stopSeq`/`plannedAt`.
  Jobs already `confirmed`/`delivered` are never regressed by a re-approval.
- `updateTransportOnOrderCompletion()` (called from `/api/scan/complete`)
  flips the matching job to `confirmed` and records the carton count as
  `packages`. Matching uses `referenceId`/`clientId` (the PO number captured
  at import) as well as `id`, because transport ids are `TR-YYMMDD-NNN` codes,
  not PO numbers.
- The `/api/transport/plan/approve` route MUST stay registered before the
  generic `/api/transport/:id` routes (same rule as `import`/`fix-schedule` —
  Express matches in order, and `:id` would swallow them).

### No-driver-app workflow: run sheets + office Mark Delivered

Drivers do NOT need the driver portal — the whole lifecycle works without it:

- 🖨 **Run Sheets** (`printDriverRunSheets()` in app.js, `#transportRunSheetsBtn`,
  also offered right after plan approval): prints one page per driver — stops
  in route order with client, address, postal, phone, carton count and a
  "Received by / Time" signature column. Same window.open+print pattern as
  waybill labels/carton slips. Only assigned, undelivered jobs are included.
- ✓ **Mark Delivered** (`POST /api/transport/mark-delivered`, must ALSO stay
  before the `:id` routes): body `{ids:[...]}` for individual jobs, or
  `{allConfirmed:true}` for the end-of-day sweep that closes out every
  Confirmed job at once (`#transportMarkDeliveredBtn`). Delivered/cancelled
  jobs are never re-touched. Each map point's tap popup also carries a
  per-job "✓ Mark Delivered" button (`.popup-deliver-btn`, delegated
  listener on document).

### Sync Strategy

When porting to IdealScan or other codebases:
1. Copy `lib/tms-importer.js` verbatim (no platform dependencies)
2. Copy TMS endpoints from server.js to target codebase's order handler
3. Copy import handlers from public/app.js (update IDs if target uses different HTML)
4. Copy Transport tab HTML from public/index.html
5. Update CLAUDE.md in target with same Transport section
6. Link both commits in PR/commit messages for sync tracking

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
