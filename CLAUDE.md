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
  `[{ num, scans: {sku:qty}, startedAt, closedAt }]`; the LAST entry is always
  the currently-open carton. Lazily created on first scan — orders that never
  split cartons end up with one implicit carton holding everything, so this
  is zero-friction for the common case and legacy (pre-feature) completed
  orders fall back to treating `state.scanned` as one carton.
- Every scan/count path (`increment`, `learn-barcode`, `setqty`) ALSO tallies
  into the active carton via `addToActiveCarton()`. `setqty` (an absolute
  correction) applies the delta (`newQty - oldQty`), not the raw value.
- `/api/scan/new-carton` closes the current carton and opens the next one.
  Refuses (400) if the current carton is still empty — prevents phantom
  cartons from a stray double-tap.
- On `/api/scan/complete`: if the trailing carton is still empty (e.g. an
  accidental "New Carton" tap right before completing), it's DROPPED rather
  than closed — never leave a phantom empty carton on the slip. Otherwise the
  last carton is closed.
- Completion slip (`/api/completion-slip/...`) has a dedicated **Cartons**
  sheet: `Carton | SKU | Description | Qty`, one row per (carton, SKU).
- Scan overlay shows a "📦 Carton N" badge + "+ New Carton" button
  (`public/index.html` `#scanCartonWrap`); every scan-response handler in
  app.js updates `activeOrder.cartonNum` from the response's `cartonNum`.
- HANDS-FREE TRIGGER: scanning a printed control barcode (text `NEWCARTON`,
  case-insensitive; `NEW_CARTON_CODES` in app.js also accepts `NEW CARTON` /
  `NEW-CARTON` / `NEWBOX`) does the same thing as clicking "+ New Carton" —
  intercepted in `_flushScanBuf()` BEFORE the value is looked up as a SKU.
  Packers print their own reusable card via the 🖨 button next to "+ New
  Carton" (`printNewCartonCard()`, same window.open+JsBarcode+window.print
  pattern as `printWaybillLabel()`).

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
