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

LABEL-REVIEW STATUS FILTER — the label-review screen's summary counts
(`openLabelReview(importId, filter)` in public/app.js) are clickable filter
chips (`.lri-filter-chip`: All / matched / unmatched / duplicate / error);
clicking one shows only those pages, the active chip is outlined. The real
page index is preserved through the filter (`imp.pages.map((page,i)=>({page,i}))`
BEFORE filtering) so Match/Unmatch/Enlarge still target the correct page.
The "N unmatched" badge in BOTH label lists — the Labels tab history
(`.lhi-unmatched-link`) and the Administrator Upload-History label card
(`.log-unmatched-link`, `renderLogContent`) — opens the review already
filtered to `unmatched` (`stopPropagation` so it doesn't also trigger the
row's open-review), for quick tracking of what still needs matching.

DISPLAY — `issue_no`, whenever present, also needs to be visible, not just
scannable: shown as a `GI: <value>` pill on the Orders-list row (next to the
`idealscan_code` job-code, `public/app.js` `renderOrdersList`) and as a
`meta-pill-gi` pill in the scan overlay header (`enterItemsPhase`). Already
included in the Completed-tab free-text search (`ordersView === 'completed'`
filter) alongside order_number/waybill_number/pick_ticket/po_number.

THE SAME GAP EXISTED IN LABEL MATCHING — `buildLabelMatchIndex()`
(server.js, feeds `/api/label-imports` and the rematch endpoint) only
indexed `order_number`/`waybill_number`/`po_number` when matching an
uploaded carrier-label PDF's pages to orders. For BETIME orders where the
GI number lives in `issue_no` (the XLSX/CSV path above) rather than
`order_number`, a label PDF printing only the GI number had NO field to
match against — those orders' import pages showed "matched" in the import
LIST summary (100% of that file's pages matched *something*) while the
specific order the user was looking for never got `has_order_label = true`,
because the page actually matched a different order or nothing at all.
Fixed by adding `issue_no` to `buildLabelMatchIndex()`'s keys exactly like
`order_number` (own entry in `byOrderNo` plus a `scanKeys` fallback
candidate) — verified directly: a label containing only "GI-128685" (no
`order_number` anywhere on it) now resolves to the correct order via
`issue_no`, with existing waybill-based matching unaffected. Since this
only fixes matching for uploads/rematches going FORWARD, a `↻ Rematch All`
button was added next to `⚡ Auto Match Unmatched` on the Labels import
review screen (`POST /api/label-imports/:id/rematch {all:true}` — the
server already supported the flag, only the client button was missing) so
already-processed imports can be re-evaluated against the fixed index
without re-uploading the PDF.

## Day-bucketing is SGT everywhere; Orders tab never hides unfinished work

Two scoping rules that keep the sidebar badge, the Orders stat tiles, and
the Active tab IN TUNE (a real screenshot once showed 41+4 active in the
tiles but "Active 16" below them):

- **SGT calendar days, never UTC.** `sgDateStr()` (server) /
  `toLocaleDateString('en-CA', {timeZone:'Asia/Singapore'})` (client) is
  the ONLY way to turn a timestamp into a day. Naive
  `toISOString().slice(0,10)` puts anything before 08:00 SGT on the
  previous day — morning uploads/completions vanished from "today".
  Applied to: `/api/stats`, `/api/orders` range filter, `renderOrdersList`
  date chips, `deliveryHistoryRows` + history route defaults, and the
  audit-log report day buckets. (Filenames etc. don't matter.)
- **PACKER RULE — the Active view always shows current day + ALL
  pending/in-progress backlog from past days.** Both the server
  (`/api/orders`, active orders bypass the range filter) and the client
  (`renderOrdersList`, active orders bypass the date chips) enforce it;
  the chips effectively slice only the Completed view (by completion
  date). Sidebar badge = `pendingBacklog` from `/api/stats` = the same
  set, so all three always agree.
- **Upload page = management view**: historical throughput ("Processed
  Til Date" = `totalDone`, all done orders in the live 12-month window)
  PLUS today's operational tiles (`todayPending`, `todayDone` "Processed
  Today", `yesterdayDone`). Orders tab = packer view (today + backlog
  only). The two are deliberately different scopes.

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

## Spreadsheet SKU trust levels — schema vs AI-detected (lib/keyfields.js + server.js)

Real product SKUs can be SHAPED exactly like warehouse location codes
(`THT-64-427-3` vs bin `AC-007-003-B`) — pattern alone cannot distinguish
them. The old behaviour (location-pattern check inside `isMetadataRow`)
silently DROPPED such lines from XLSX/CSV uploads; found via a real
Keyfields IssueDetail file whose THT-64-427-3 line vanished. Now:

- `mapRow` tags every row with `_skuSource`: `'schema'` when the SKU came
  from a KNOWN named column (the alias chain — `sku`, `item_code`,
  `d-SKUCODE`, … — or an `explicit: true` detected map), `'detected'` when
  only the AI column-scoring fallback found it.
- KEYFIELDS/ISSUEDETAIL FAST-PATH: `detectColumnMap` returns
  `{explicit: true, schema: 'keyfields', sku_key: 'd_skucode', order_key:
  'd_exref2', qty_key: 'd_expectedqty'}` whenever `d-SKUCODE` is among the
  headers — NEVER heuristic-scores a d- schema file. (Heuristics once
  picked `d-exline`, the line NUMBER, as qty — "expectedqty" missed the
  old `^qty$` keyword regex and the two columns tied on numeric stats.)
  `d_expectedqty` is also in `mapRow`'s hardcoded qty chain so single-row
  files (detectColumnMap needs 2+) still get the right qty.
- `scoreQty` now: substring qty/quantity keyword match (catches
  `expectedqty`, `ship_qty`) AND a -15 penalty for line/seq/serial/row
  numbering column names.
- SCHEMA SKUs ARE TRUSTED OUTRIGHT — no location-pattern filtering
  (`splitSuspectSkuRows` skips `_skuSource === 'schema'`) AND no
  SKU-shape heuristics in `isMetadataRow` (spaces / label words): a real
  Keyfields line "Thermal Grease X23-7783D" was silently dropped by the
  SKU-with-spaces check before `isMetadataRow` learned to return false
  early for schema rows. Order-number checks still apply to every row.
- DETECTED SKUs matching `LOCATION_SKU_PAT` are NEVER silently dropped and
  never silently accepted — the system is "in doubt" and asks: `/api/preview`
  appends an ⚠ warning naming the SKUs; `/api/upload` returns 409
  `{needsSkuConfirm, suspects[], message}` unless the request carries
  `suspect_skus=include` (they're real products, audit-logged
  `upload_suspect_skus_included`) or `=exclude` (drop those lines,
  audit-logged `..._excluded`). The client (app.js, right before the
  `needsDuplicateConfirm` handler) walks the user through two confirm()s:
  "are these real SKUs?" → include; else "upload without them?" → exclude
  or abort.
- PDF picking lists are exempt from all of this — `parsePdfPicklistDetailed`
  separates location and SKU columns explicitly (lib/ocr-parse.js
  `LOCATION_CODE_PAT`), and its rows carry no `_skuSource`.

## GINo column — "Good Issue Analysis" export order detection (lib/keyfields.js mapRow)

An iWMS "Good Issue Analysis" export (header row: `Account, GINo, CustRef,
Type, Priority, PONumber, SiteCode, ShippedOn, CreatedOn, ExpectedDate,
ShipToCode, ShipToName, ShipReference, SKUCode, SKUDescr, …`) has NO
"Reference"/"Order No"/"Issue No"-named column at all — `GINo` (e.g.
`GI-129798`) IS the order identifier, one goods-issue transaction per GI,
same as the `GI-\d{4,}` barcode the PDF picking-list path already turns
into `order_number` directly. A real file with 1006 SKU lines across 270
distinct GIs uploaded as **2 orders** — `detectColumnMap`'s AI fallback
picked `ExpectedDate` as `order_key` instead, because its scoring rewards
LOW cardinality for an order column (+20 when ≤15% of rows have a unique
value — right for a picking list where many lines share one order number)
and PENALIZES high cardinality (-12 above 60%) — but `GINo` is
near-unique per row in this report shape (correct for a transaction-log
export), so it scored worse than a repeating date column that just
happened to have few distinct values. `GINo` also didn't match any name
keyword in `scoreOrder` (`order|ref|invoice|…`) so it got no help there
either. The 2-orders result cascaded into ~1000 bogus "duplicate line"
warnings at `/api/preview` (`findDuplicateLineWarnings`), since every real
GI's lines looked like 40+ repeats of the same 2 fake orders.

Fixed the same way the file's own header instructs ("add their column name
to the right-hand side of the relevant `??` chain, do NOT remove existing
aliases") — added `n.gino ?? n.gi_no ?? n.gi_number` to the KNOWN alias
chain for `order_number` in `mapRow` (right after `d_exref2`, before
`issue_no`), so a bare `GINo` header now resolves without ever reaching the
AI heuristic. Deliberately narrow: does NOT touch `scoreOrder`'s general
cardinality scoring (retuning that risks regressing picking-list detection
for other clients where low cardinality IS the right signal) and does NOT
touch the separate, already-documented `n.iwms_gino → issue_no` alias
(a DIFFERENT header spelling — `"iWMS GINo"` normalizes to `iwms_gino`,
not `gino` — used by a format that has its own separate order-number
column and intentionally keeps the GI as a secondary/scan-only field; see
the Scan-to-find-order section above).

## Batch deletion safety + label-import deletion (server.js `DELETE /api/master/batch/:batchId`, `DELETE /api/label-imports/:id`)

Found while tracking down a stale-duplicate-order label-matching bug: `DELETE
/api/master/batch/:batchId` unconditionally spliced the ENTIRE batch with no
check on any order's status — unlike every other destructive path in this
app (per-order deletion request, wave-cancellation reversal), which all
explicitly refuse to touch a `done` order. A batch containing even one
completed order could be wiped outright with no warning. Fixed: before
splicing, the endpoint now checks every order in the batch via
`orderStates[order_number].status === 'done'`; if any are found it refuses
with 403 and names the specific done order number(s), pointing at the
per-order deletion-request workflow instead. Only batches where every order
is still pending/processing can be deleted this way — the same rule the
per-order path already enforced, now enforced at the batch level too.

**Label-PDF imports (`db.labelImports[]`) are a separate, ADDITIVE record**
— they only carry a `db.orderLabels[orderNumber]` pointer to a matched page
plus the stored page PDFs on disk; they never touch a batch, an order, or
scan state. There was previously no way to delete an import at all (only a
per-page "unmatch"), so a bad/duplicate label upload stuck around forever.
`DELETE /api/label-imports/:id` (checkMaster-gated, same convention as batch
delete) removes the import record, clears every `db.orderLabels` entry that
pointed at it (so the "Label" chip disappears from whichever orders it was
attached to), and deletes the import's directory from
`DATA_DIR/label_imports/<id>/`. Deliberately has NO done-order check —
unlike a batch delete, removing a label import can't lose any operational
progress (scanned qty, cartons, completion state); it only detaches a
printable shipping-label PDF, so it's safe regardless of the matched
order's status. UI: a red "🗑 Delete" button next to "Review ›" on each
label-import card in the Administrator upload-history list
(`renderLogContent` in app.js), confirm()-gated, `logAudit`'d as
`label_import_deleted`.

## Label matching — current order wins, extraction always refreshed (server.js `buildLabelMatchIndex`/`rematchLabelImport`)

Two rules learned from a production incident where 500+ matched labels
never appeared on the orders the packers actually work from (a stale
duplicate batch — created before the GINo-detection fix above — held
orders keyed by the 18-digit CustRef for the same physical shipments):

- **FIRST WRITE WINS in `buildLabelMatchIndex`** — orders arrive from
  `globalOrdersWithState()` newest-batch-first (db.batches is unshifted),
  so when a stale duplicate order shares a normalized key (same waybill,
  same GI) with the current order, the index must NOT let the stale one
  overwrite it. Plain `Map.set` did exactly that; all four key inserts now
  check `.has()` first. `issue_no` is indexed alongside `order_number`
  (into `byOrderNo`) — XLSX/CSV-path orders carry their GI number there,
  not in `order_number` (see Scan-to-find-order above).
- **`rematchLabelImport` MUST re-run `extractLabelFields(rawText)` on
  every page it processes** — `page.extracted` is a cache built with
  whatever extraction rules existed at upload time, so any later regex
  improvement (e.g. widening the tracking-number prefix from `{2,4}` to
  `{2,6}` letters for SPTTND/SPXSG) silently never reached existing
  imports through "Auto Match Unmatched"/"Rematch All". The refresh runs
  whenever rawText is non-empty; the OCR branch still sets it too for
  image-only pages.

The remediation path for the production data itself: delete the stale
batch (Administrator → upload history → Delete Batch — now refuses if the
batch contains a done order, see the section above), then open each label
import → "↻ Rematch All"; labels re-attach to the surviving GI- orders
via `tracking_number` since those orders carry the SPTTND waybill numbers.

## Same-file re-upload confirm (server.js /api/upload + /api/label-imports)

Every order-file batch and label import stores a `contentHash` (sha256 of
the uploaded bytes) at creation. When an upload's filename AND hash both
match an existing record, the server answers 409 `{needsSameFileConfirm,
existing: {filename, uploadedAt, uploadedBy, job/pageCount, orderCount}}`
and the client confirm() reads the existing upload's details out loud
(file, when, by whom) — OK resends with `overwrite_same_file=yes`, which
REMOVES the earlier record (batch: splice + wms xlsx + waybill dir,
audit `upload_same_file_overwritten`; label import: same cleanup as
`DELETE /api/label-imports/:id`, audit `label_import_same_file_overwritten`)
and proceeds fresh. Order batches with any DONE order hard-abort 422
instead (completed work is never overwritten — same rule as everywhere).
This check runs FIRST, before parsing and before the duplicate-ORDER
tiers below, so an identical re-upload gets one clear file-level prompt
instead of hundreds of per-order duplicate warnings. Records created
before this feature carry no hash and are simply never flagged. Client
handlers: the `needsSameFileConfirm` branch at the top of the upload
retry chain in app.js, plus `labelSameFileConfirm()` shared by both
label-upload entry points (`doLabelImport`, `doLabelImportFromUploadTab`).

## Duplicate order numbers — locked vs overwritable vs confirmable (server.js /api/upload)

Clients RECYCLE order numbers (date-letter codes like `20260716-H`); the
`iWMS GINo` (issue_no) is the actually-unique identifier. The upload
duplicate rule has three tiers:
- **HARD abort** (422): earlier order with the same number (same/missing
  GI) is already DONE — completed work is never overwritten by an upload
  (same rule as deletion); the error points to the Master deletion
  workflow. Error names the exact batch (job code, filename, upload time).
- **OVERWRITE-OR-ABORT** (409 `{needsOverwriteConfirm, duplicates[]}`):
  earlier order is still pending/processing. The client confirm() offers
  OK = overwrite / Cancel = abort; resend with `overwrite_duplicates=yes`
  REMOVES the earlier order from its batch (order, orderStates, counts;
  empty batches are dropped) and proceeds with this file's version —
  any scan progress on the old copy is deliberately discarded (fresh
  `pending` state, new job code). Audit-logged
  `upload_duplicate_overwritten`. `/api/preview` mirrors the three-way
  split in its warning wording so the Confirm modal says what will happen
  BEFORE approve.
- **CONFIRMABLE** (409 `{needsDuplicateConfirm, duplicates[], message}`):
  earlier order is DONE and the GI differs — almost certainly a different
  order reusing the client's number. Client shows a confirm() listing each
  order with old→new GI; resend with `confirm_duplicates=yes` proceeds and
  is audit-logged (`upload_duplicate_confirmed`). The new batch is
  unshifted to the FRONT of db.batches, so order-number lookups
  (findBatchForOrder, scanning) resolve to the new pending order, not the
  completed old one.

## ZORT integration — per-client merchant store connections (lib/zort.js + server.js)

ZORT (zortout.com) is the e-commerce OMS the user's merchant CLIENTS use;
this integration is the window through which those clients' orders reach
IDEALONE for fulfillment. Spec source: the ZORT_Api_v4.0 Postman collection
(auth = three plain headers storename/apikey/apisecret on every request,
base `https://open-api.zortout.com/v4`; lib/zort.js `zortRequest`).

- THE MODEL (corrected per user): ONE ZORT account (the user's own) is
  the hub; each CLIENT'S Lazada/Shopee/TikTok/Shopify shop is linked
  into that account as a SALES CHANNEL (inside ZORT → Settings → Sales
  Channels — marketplace credentials never enter IDEALONE). Client
  attribution is per-ORDER via `store.channelClients` (saleschannel →
  client name; the "Channels" button opens the mapping editor
  `#zortChannelsModal`, fed by Merchant/GetSalesChannels). Pulls create
  ONE BATCH PER CLIENT (batch.client_name = mapped client; unmapped
  channels fall back to the store's clientName label). `db.zortStores[]`
  still supports multiple accounts: `{id, clientName (account label /
  default client), storename, apikey, apisecret, endpoint?, enabled,
  channelClients{}, autoPullMinutes, completeAction, completeStatusCode,
  lastPullAt, lastResult}`. SECRETS NEVER GO TO GIT — they live only in db.json;
  the API returns masked keys, and blank key/secret on edit keeps the
  stored value.
- UI: the 🔌 CONNECTIONS sidebar tab (`data-tab="connections"`) —
  hidden for warehouse AND gated behind the ADMINISTRATOR password:
  switchTab intercepts it via `_pendingUnlockTab` + the same
  `logPasswordOverlay`/`logUnlocked` gate the Administrator panel uses
  (unlock once per session; cancel clears the pending tab). Platform
  cards: ZORT = ACTIVE; Lazada/Shopee/TikTok/Shopify = "VIA ZORT" —
  marketplace credentials are keyed into the MERCHANT'S OWN ZORT
  dashboard (ZORT → Settings → Sales Channels), never into IDEALONE;
  the per-store "Channels" button (`/api/master/zort/stores/:id/channels`
  → Merchant/GetSalesChannels) READS what the client has linked. Below
  the cards: the ZORT store manager (`#connZortPanel`, moved here from
  the former Administrator → ZORT admin tab). Endpoints stay master-key
  guarded: `/api/master/zort/stores` (GET/POST/DELETE), `/:id/test`
  (Merchant/ValidateApi), `/:id/pull`, `/:id/channels`.
- PULL (`pullZortStore`): Order/GetOrders paged (limit 100, ≤20 pages),
  `updatedafter` = lastPullAt − 1 day (first run: 7 days back). Zort
  status 2 = void → skipped; orders whose number already exists anywhere
  → skipped (idempotent re-pulls). Lines map list[].sku/name/number →
  sku/description/qty; customer/shipping fields are mapped defensively
  (multiple fallback key names — REAL response field names should be
  verified on the first production pull). Each pull creates ONE batch
  (client_name = store.clientName, uploaded_by 'zort-sync', normal
  idealscan_code) so Zort orders scan/report exactly like uploads.
  Orders carry `zort_id` + `zort_store_id` (re-attached after
  summarizeOrders, which strips unknown fields).
- AUTO-PULL: one 60s scheduler; each enabled store with autoPullMinutes>0
  pulls on its own cadence; `_zortPulling` guards reentry.
- PUSH-BACK (`pushZortCompletion`, called in /api/scan/complete after
  logAudit): per-store `completeAction` = none (default — pull-only) |
  pack (Order/PackOrder + trackingno) | readytoship | status
  (Order/UpdateOrderStatus with configurable completeStatusCode).
  Fire-and-forget: NEVER blocks completion; success/failure audit-logged
  (`zort_completion_pushed` / `zort_completion_push_failed`).
- TESTED against a local mock of the Zort API (scratchpad zort-mock.js
  pattern — endpoint override makes the client point anywhere): pull
  imported 2/3 orders (void skipped), completion pushed PackOrder with
  correct id+trackingno, re-pull created 0. The sandbox proxy blocks
  open-api.zortout.com, so live verification must happen from production.
- Webhook/UpdateWebhook exists in the API — a future push-based
  alternative to polling, not yet used.

## Betime scanning exceptions (server.js — `/api/scan/increment`)

1. **NP suffix**: product barcodes with a trailing `NP` are the same product as the
   plain code — `8006NP` scanned counts against order line `8006`, and scanning
   `8006` counts against a line listed as `8006NP`. Exact matches ALWAYS win first;
   the suffix fallback only fires when nothing matched as scanned, so orders that
   genuinely contain both `8006` and `8006NP` lines still count separately.

## QR codes are the substitute-code format (NOT Code128, NOT short codes)

Real WESCO SKUs run to 26 chars (`MA-IDC3B-N-20F-Z-0100-N-0A`); as Code128
that's too wide/dense to scan off a card or screen ("barcode too long").
The user explicitly rejected system-assigned short codes (an NB#### scheme
was built and REVERTED — commit e34977f, reverted 5531170): the requirement
is scan a QR and take its DECODED VALUE into processing, identically for
outbound scanning and IdealInbound receiving. Current state:

- `qrcode-generator` (npm) served at `/vendor/qrcode.js` (same
  serve-from-node_modules pattern as jsbarcode); loaded by index.html and
  the no-barcode sheet.
- The printed No-Barcode Sheet (`/api/no-barcode-sheet`) renders one QR per
  card encoding the FULL SKU (110px, error level M, `createSvgTag`), full
  SKU + description as text.
- The on-screen substitute in the scan overlay (`.nb-inline-bc`, now a
  `<div>` not an `<svg>`) renders a QR of the full SKU; requires
  `window.qrcode`.
- No resolution layer needed: the decoded value IS the SKU, so the normal
  scan paths (exact match → NP fallback → aliases → learned) just work —
  verified by decoding rendered QRs with an independent reader (jsQR) and
  POSTing the value to `/api/scan/increment` (outbound) and
  `/api/inbound/:id/scan` (inbound; field name is `code`, not `sku`).
- The camera scanner reads QR on EVERY smartphone — warehouse staff use
  their own phones as scanners, so this cannot depend on platform:
  `BarcodeDetector` (Android Chrome/Edge; constructed with
  `getSupportedFormats()`, all 1D+2D formats) when available, else a jsQR
  fallback (`cameraUsesJsQR` in openCameraScanner/startCameraLoop —
  decodes video frames on a canvas, downscaled to ≤640px and throttled to
  ~6fps since it's CPU-bound). jsQR is served at `/vendor/jsqr.js` from
  node_modules like the other vendor libs. The fallback is QR-ONLY — an
  amber pill in the viewfinder (`#cameraQrOnlyHint`) says so (1D barcodes
  need a gun on those phones). The no-support screen now only appears
  when NEITHER decoder exists or the camera itself fails.
  `dispatchCameraScan` routes to `handleItemScan`/`inboundScan` by target.
  Hardware 2D guns are keyboard wedges — decoded QR text arrives through
  `_globalScanKeydown` like any typed value, no code path needed.
  TESTING TRICK: the whole camera path is testable headless with
  `--use-fake-device-for-media-stream` +
  `--use-file-for-fake-video-capture=<qr>.y4m` (ffmpeg from a QR PNG) —
  Linux Chromium has no BarcodeDetector, so it exercises exactly the
  iPhone/jsQR path end to end.
- JsBarcode stays for everything 1D that ISN'T a SKU substitute: waybill
  labels, NEWCARTON control card, carton-slip order barcode.

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
- IDEMPOTENCY — EVENTID IS MINTED AT SCAN TIME, NOT AT ENQUEUE TIME. Every
  scan (`handleItemScan` → `_scanQueue`) carries an eventId on its VERY FIRST
  `/api/scan/increment` request; a network-failed scan is queued WITH THE
  SAME id, and the replay sends it again plus `isReplay: true`. The server
  ignores ids it has already counted (`state.scanEventIds`, capped 100).
  This closed a real production double-count: the first attempt used to send
  NO eventId, so a scan the server processed whose response outlived the
  client's 8s `fetchT` timeout was queued as "offline" with a fresh id and
  counted a SECOND time on replay — packers saw "scan 1 piece, system shows
  2" intermittently (whenever Railway responded slowly). Server-side, the id
  is REGISTERED only at the moment the piece is actually counted — never on
  the 409 `crossCartonConfirm` bounce — so the confirmed retry (same id +
  `confirmCrossCarton`) still counts; the cross-carton skip now keys on
  `isReplay`, not on eventId presence (every live scan has one now).
- Complete + auto-complete are BLOCKED while an order has unsynced scans.
- `/api/scan/resolve-cache` gives the client CODE2/learned/alias maps so
  offline scans resolve to the right line locally.

## Warehouse-mobile scan layout — inline camera panel (`#inlineCamPanel`)

For WAREHOUSE-role users on phone-width screens (`whMobileScanLayout()`:
role check + `max-width: 768px`), the scan overlay follows the courier
pickup-scan pattern the user supplied as reference: a live camera
viewfinder pinned ABOVE the item list with **Camera / Scanner** tabs, an
**ADD** button next to the manual input, and the normal
Cancel/Pause/Complete dock below. Admin users and desktops keep the
original layout with the separate full-screen camera overlay
(`#openCameraBtn`, hidden in wh-mobile mode).

- `enterItemsPhase` toggles the whole mode; `closeScanOverlay` always
  stops the stream. Tab switch to Scanner stops the camera and focuses
  the input.
- The inline decode loop mirrors the full-screen scanner: BarcodeDetector
  when available, jsQR fallback (QR-only hint pill) otherwise; decoded
  values go through `_scanBuf = val; _flushScanBuf()` so NEWCARTON
  control cards and every scan rule behave identically to a wedge scan.
- Same-value cooldown is `SINGLE_COOLDOWN_MS` (1.8s) — holding the camera
  on one code deliberately counts another piece every cooldown (multiple
  identical pieces = point repeatedly), same behaviour as the full-screen
  scanner's single mode.
- The ADD button submits the typed input through the same
  `_flushScanBuf()` path (not a separate code path).

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
- **SEALED CARTONS — new-carton LOCKS the carton it closes.** The closed
  carton gets `locked: true`; `carton/switch` to it returns 403
  `{lockedCarton:true}` and `cancel-multi` refuses while any carton is
  locked — that box may already be taped shut, so its contents (SKU+qty)
  can't silently change. `POST /api/scan/carton/unlock {orderNumber,
  cartonNum, password}` (admin role + OWN password re-entered, 403 not 401
  on a wrong one, audit-logged `carton_unlocked`) clears the seal; the
  client's `switchCarton()` offers this inline to admins (prompt for
  password on the 403) and just shows "sealed" to warehouse users. Since
  every scan/setqty only ever tallies into the ACTIVE carton, blocking
  switch-to-locked is sufficient to protect sealed contents. Legacy
  cartons without the flag are simply unlocked.
- **"SEAL FINAL CARTON" SCREEN** (`showSealFinalCarton()` /
  `#sealCartonOverlay`) — when the last piece is scanned and the order
  completes (auto-complete or the Complete button), a big green screen
  shows the FINAL carton's label (`{order}-{NN}`) plus "Order complete —
  N pcs in M carton(s)" for ~4 seconds (tap or any key skips), then the
  flow closes the scan overlay back to the orders summary with the
  waybill-scan bar focused, ready for the next order. This REPLACED the
  old click-to-confirm label prompt at completion (`doCompleteOrder` no
  longer calls `showCartonLabelPrompt` for the last carton — the seal
  screen posts `carton/label-confirmed` fire-and-forget instead). The
  carton-1-on-open and closing-a-carton label prompts are unchanged.
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

## Driver Performance Stats — Administrator → Drivers, real data only

The "Performance Stats" tab inside Driver Details showed Distance/Time/Avg
Speed permanently at 0: it read `driver.stats.distance`/`driver.stats.time`,
fields NOTHING in the app ever wrote (no `stats` object exists on
`db.drivers` records). Jobs Completed alone looked real because it was
computed a different way (counting delivered jobs directly).

Fixed by wiring to the SAME computation the Reports → Driver Performance
XLSX already uses correctly — extracted into `computeDriverPerformance(db,
from, to)` in server.js (per-driver delivered/confirmed/open counts,
cartons, and an estimated distance from real postal-sector legs starting
at the depot) so the XLSX report and this tab can never disagree.
`GET /api/drivers/performance` (no date range = all-time) feeds the tab.

**Time (hrs) and Avg Speed were REMOVED, not fixed** — there is no
drive-duration tracking anywhere in the system (no start/end-of-drive
timestamps), so any "time" or "speed" number here would be fabricated.
Replaced the 4 stat tiles with ones backed by real data: Est. Distance
(km), Cartons Delivered, Jobs Delivered, Drivers Active. Table columns:
Driver / Delivered / Open / Cartons / Est. Distance / Days Active / Avg
Jobs per Day — matching the XLSX report's columns exactly. A hint line
in the tab points to Reports → Driver Performance for a date-ranged,
downloadable version and repeats the distance-is-an-estimate caveat.

## Driver App — real mobile PWA at /driver (public/driver.html + driver.js)

Replaces an entire non-functional predecessor: the old `/api/driver/*`
endpoints authenticated against `users[role==='driver']`, a store NOTHING
could ever create a record in (the user-creation form only offers
admin/warehouse) — and even a manually-inserted one would never match
`transport.assignedDriver`, which the route planner populates from
`db.drivers[]` ids, a COMPLETELY SEPARATE store. So no job could ever have
appeared for a logged-in driver; the feature was dead on arrival. The old
`public/driver.html` also had a live Google Maps API key hardcoded directly
in a `<script>` tag — publicly readable via view-source on a deployed page.
Both are fixed:

- **One driver identity.** `db.drivers[]` (already the Transport route
  planner's roster, `/api/drivers`) gains an optional PIN:
  `pinHash`/`pinSalt` (hashed like any password), set via a new "Driver App
  PIN" field on the existing Transport → Driver Details add/edit form
  (blank on edit = keep current, same rule as every other secret field in
  this app). `GET /api/drivers` never returns the hash — `hasPin: true/false`
  only; the driver list row shows a 📱 badge when a driver can log in.
- **Real sessions, not a parallel auth scheme.** `POST /api/driver/login`
  `{id, pin}` verifies against `db.drivers`, then issues a token through
  the SAME `activeSessions` map every other login uses — namespaced
  `driver:<id>` so it can never collide with an admin/warehouse user id.
  One active device per driver (a new login replaces the old session,
  same rule as `/api/auth/login`). `requireDriverAuth()` in server.js does
  the token→driver lookup for the other endpoints — the `/api/driver/`
  path prefix is exempt from the global `requireAuth` middleware (so login
  itself doesn't loop), and each handler checks its own token instead.
- **Jobs come straight from `db.transport`** — no separate job store.
  `GET /api/driver/jobs` filters to `assignedDriver === <this driver>` and
  `status !== 'cancelled'`, keeps today's delivered stops visible for
  reference, sorts by `routeNum`/`stopSeq` (the planner's route order), and
  returns the SAME status wording/colors as the office UI
  (`driverStatusLabel()` mirrors `tmsStatusLabel()` in app.js — Staging/
  On the road/Delivered/Delivered w/ Remarks — keep both in sync if the
  lifecycle ever changes).
- **Two actions, ownership-checked server-side** (a driver can only move
  their OWN assigned jobs — 403 otherwise): `POST
  /api/driver/jobs/:id/pickup` (confirmed→in-transit, mirrors the office
  map popup's "Picked Up" button) and `POST /api/driver/jobs/:id/deliver`
  `{remarks}` (→delivered; non-empty remarks = "Delivered w/ Remarks", same
  rule as office Mark Delivered). Both refuse to regress an already-
  delivered/cancelled job.
- **No embedded map.** `driver.html` has no map SDK at all — the detail
  sheet's "Navigate" button is a plain `https://www.google.com/maps/
  search/?api=1&query=` deep link (opens the phone's own installed maps
  app; needs no API key and is not a "keyed map service" in the sense the
  no-Google-Maps rule means) and "Call Consignee" is a `tel:` link.
- **Portable**: the feature is three self-contained pieces — the
  `db.drivers` PIN field + `/api/driver/*` block in server.js, and
  `public/driver.html`/`driver.js` — touching nothing else. Any branch
  already carrying the Transport/route-planner feature (which owns
  `db.transport`/`db.drivers`) can take this as a clean, isolated diff; see
  the `/upgrade-pack` skill.
- **Administrator → Drivers is now unified onto `db.drivers` too.** The old
  Admin-only "Add Driver" form posted to `/api/master/drivers` — the
  `users[role==='driver']` store above, now REMOVED entirely (nothing else
  ever read it). The tab's "+ Add Driver" button opens the SAME shared
  `#addEditDriverModal` Transport → Driver Details uses (triggered via
  `transportAddDriverBtn.click()`); its list re-fetches `/api/drivers`
  (`loadDrivers()`) and shows the 📱 hasPin badge. Any driver added from
  Administrator can immediately log into the Driver App and gets picked up
  by route planning — one identity, reachable from three places (Admin tab,
  Transport → Driver Details, and now the same modal both share).
  **Gotcha fixed along the way**: `#addEditDriverModal` used to be nested
  INSIDE `#tab-transport` — invisible (ancestor `display:none`) whenever the
  Administrator overlay was opened from any tab other than Transport, even
  after its own `.hidden` class was removed. Moved to body level (like every
  other global modal — `.modal-overlay`'s `z-index` already sits above the
  Administrator overlay's) so "+ Add Driver" works from Administrator
  regardless of which tab is active underneath.
- **`GET /api/drivers/export`** — the full roster as an XLSX (Driver ID,
  Name, Phone, Vehicle, Plate, both capacities, Status, "Driver App PIN
  Set" Yes/No) for handing off to or importing into another system.
  `pinHash`/`pinSalt` are NEVER included. Button lives next to "+ Add
  Driver" in the Administrator tab.
- **Still separate, NOT touched**: the TMS Management → Drivers section
  (`tmsDriversList`/`tmsAddDriverBtn`) — a third driver-management surface
  whose backend hasn't been audited; flagged here so a future pass folds it
  into the same `/api/drivers` roster rather than rediscovering the split.

Verified end-to-end (Playwright + curl): PIN-not-set login blocked with a
clear message; wrong PIN rejected; correct PIN issues a session; job
assigned+confirmed via the real `/api/transport/:id/update` API appears in
the driver's list with matching status wording; Picked Up moves it to
in-transit; Deliver-with-remarks closes it out as "Delivered w/ Remarks"
and blocks a second delivery attempt; a second driver gets a 403 trying to
touch the first driver's job; session survives a page reload; logout
returns to the PIN screen. No Google Maps key anywhere in `public/`.

## PWA install — iOS has no prompt; the app guides instead (installHintBar)

The PWA plumbing (manifest.json, /icons/*, apple-touch-icon + apple-mobile
meta tags, and a deliberately NO-CACHE sw.js — scanning is live-data, every
deploy must reach devices immediately) was already in place and serving 200.
"iOS cannot install" is Apple policy, not a bug: Safari never fires an
install prompt — install = Share → Add to Home Screen, manually. So
`#installHintBar` (bottom-fixed, app.js `initInstallHint`):
- iOS Safari → spells out Share → "Add to Home Screen"; iOS Chrome/Firefox
  (CriOS/FxiOS) → says to open the page in Safari first.
- Android/desktop Chrome → captures `beforeinstallprompt` and shows a real
  Install button that calls `prompt()`.
- Hidden when already running standalone (`display-mode: standalone` /
  `navigator.standalone`) and after ✕ dismissal
  (`is_install_hint_dismissed`, localStorage — device-local by design).
- iPadOS pretends to be Macintosh — detected via `maxTouchPoints > 1`.

## Per-user feature toggles (Administrator → Users → ⚙ Features)

`user.features` = `{upload, orders, inbound, transport, labels, reports}`
(absent/null = all visible). Set via `PUT /api/master/users/:id/features`
(checkMaster, keys whitelisted in `USER_FEATURE_KEYS`, audit-logged as
`user_features_updated`); returned by `/api/profile` and the master users
list. Client `applyFeatureToggles()` hides the corresponding sidebar tab
buttons (+ `#transportSubMenu` with transport) after profile load, and
kicks the user to the first visible tab if their current one was hidden.
This is UI visibility control layered ON TOP of roles — the role rules
(warehouse can't open Administrator, server-side report/deletion guards)
remain the actual security boundary. At least one function must stay
ticked (client-enforced).

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

- "🤖 AI Plan Routes" (renamed from "Plan Routes") opens the planner as a
  FULL-PAGE takeover (`.route-planner-page`, ← Back button) and AUTO-GENERATES
  the plan on open — the user arrives at a finished draft and only amends.
  "Generate AI Routes" became "Regenerate Routes".
- JOBS WITHOUT A POSTAL CODE ARE HELD OUT OF THE PLAN — a stop with no
  location poisons every distance and the stop order (all 0.0 km, N/A).
  `optimizeRoutes()` filters to `shipping.zip` only; an amber notice under
  the planner settings says how many are held, with a "Match & Fix Now"
  button that opens the resolver in place. After resolving, the plan
  regenerates automatically so fixed jobs join it. Uploads are NEVER
  blocked by unresolved stores — the jobs simply wait as pending.
- START LOCATION (cargo pickup) — routes begin at the depot stored in
  `db.transportDepot` (GET/POST `/api/transport/depot`, before `:id`;
  default `40 Penjuru Lane #04-01, 609216`). Both optimizers' `startPoint`
  and the Driver Performance report's distance legs use it; run sheets
  print "Pickup: <address> (<zip>)" in the header. Changeable via the
  "🏭 Start:" button in the planner header (postal prompt, 6-digit
  validated, shared server-side, re-plans immediately).
- BEFORE the planner opens (when 2+ drivers exist), a "Who's driving
  today?" picker (`showDriverPicker()`, all ticked by default) lets the user
  EXCLUDE unavailable drivers (leave/MC). `activeDriverIds` (null = all)
  scopes `includedDrivers()`, which feeds BOTH the auto-assignment and the
  per-stop dropdowns — an excluded driver can't be assigned even manually.
  Changeable mid-plan via the "👤 Today's Drivers" button in the planner
  header (re-runs generation). Requires at least one ticked driver.
- Route generation auto-assigns drivers ROUND-ROBIN per route
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

### Delivery status lifecycle & display wording (tmsStatusLabel in app.js)

Internal → displayed: `pending`/`preplanned` → **Preplanned** (blue),
`confirmed` → **Staging** (grey — scanning done, waiting pickup),
`in-transit` → **On the road** (yellow — set via the map popup's "Picked Up"
button on staging jobs), `delivered` → **Delivered** (green) or **Delivered
w/ Remarks** (red) when `podRemarks` is non-empty. Remarks are captured by
the per-job Mark Delivered prompt (empty = clean) and by the Driver Portal
completion notes; `/api/transport/mark-delivered` accepts `remarks`, and
`{allConfirmed:true}` sweeps BOTH confirmed and in-transit (clean only —
issue deliveries should be closed individually). Map marker colours + legend
follow the same scheme (delivered-with-remarks = darker red #dc2626 vs
unassigned #ef4444). `in-transit` jobs are excluded from re-planning. Stats
bar: Jobs Today / Pending / Preplanned / Staging / On Road / Delivered /
Done Yday.

### Batch status updates + run-sheet statuses (until a driver app exists)

`POST /api/transport/bulk-status {ids, status, remarks}` (before `:id`;
allowed: confirmed/in-transit/delivered, remarks → podRemarks) powers the
"🔄 Batch Status" button on the Transport bar: filter by driver and current
status, pick the target state (incl. Delivered w/ Remarks with a mandatory
remarks field), live count, one confirm — e.g. "everything LAK loaded goes
On the road". Driver run sheets print a Status column (same
`tmsStatusLabel` wording) and each stop's TR- id under the client name.

### Picking-list uploads feed Transport — GATED by a per-upload question

The Confirm-Upload modal asks "🚚 Delivery arrangement needed for this
batch?" (radio yes/no, `input[name="arrangeDelivery"]`, reset to UNANSWERED
on every upload — the user must choose each time; Approve is blocked with an
inline error until they do). Hidden for Inbound direction. The answer is sent
as `arrange_delivery` on both `/api/upload` (FormData) and `/api/ocr/upload`
(JSON body).

YES → `createTransportJobsFromOrders(db, orders, clientName, batchId)` runs
right after `db.batches.unshift(batch)`: every uploaded order also becomes a
`pending` transport delivery job (channel `'order-upload'`). NO → orders go
to scanning only, Transport untouched. Deduped by order number against
`referenceId`/`clientId`, so re-uploads never duplicate jobs. The SG postal
code is extracted from the free-text `delivery_address` (`\b\d{6}\b`); `tel`
becomes the shipping phone; the carrier goes in `notes`. Scanning completion
flips these to `confirmed` via the existing
`updateTransportOnOrderCompletion()` matcher (referenceId === order_number).
Uses `tmsImporter.nextTransportCode()` (exported from lib/tms-importer.js)
for TR-YYMMDD-NNN ids. The response's `transportJobsCreated` count feeds the
upload success message. (The old `planDeliveryJobs` zone-grouping system —
`confirmPlanDeliveryCheckbox`/`planDeliveryJobs` — was removed; it pushed
malformed `JOB-...` records into db.transport.)

### Address Book — fixed-location cross-reference (server.js `/api/address-book*`)

BETIME-style imports carry only a store name/code, no address. `db.addressBook`
= `[{code, name, address, zip, phone}]` maps them to a full address + 6-digit
postal. `applyAddressBookToTransport(db)` fills `shipping.address/zip/phone`
on every transport job still missing a zip (matched case-insensitively on
clientName OR referenceId; never overwrites an existing zip) and runs after
EVERY path that can leave a job unresolved: order-upload bridge, unified TMS
import, single-entry upsert, and book file import — so a book update takes
effect on existing jobs immediately (response includes `jobsFixed`).

IMPORT PARSER — tuned for the real STORE_CODE_with_postal_code.xlsx layout
(452 Watsons/Guardian-style rows): `Store` = CHAIN (saved as `chain`),
`Branch Name` = the entry name, `Branch Code` = code, `POSTAL CODE` may be
numeric (a 5-digit numeric postal gets its lost leading zero restored —
018945 → 18945 → 018945). The lookup index also registers "chain + name"
and "name + chain" combos so orders saying "Watsons WESTGATE" resolve, and
branch codes like "WSS (189)" match as codes. Export round-trips the same
Store/Branch Name/Branch Code column layout.

FUZZY MATCH + LEARN — when an order's store name is spelled differently
from every book entry, the job stays unresolved and the Transport tab shows
an amber "N job(s) have no postal code" banner with a 🔍 Match & Fix button.
`GET /api/transport/unresolved-suggestions` (before `:id`) scores every book
entry against each unresolved clientName (`addressBookSimilarity`: token
overlap + Levenshtein ratio + substring bonus, threshold 40%, top 3) and the
resolver modal preselects the best. Confirming calls
`POST /api/address-book/learn-alias {alias, targetName}` which ADDS the
misspelling to the book as an alias row (`aliasOf`, inherits the target's
zip/address/phone) and re-runs `applyAddressBookToTransport` — so the fix
applies now AND every future upload with that spelling resolves
automatically. No-match names (and the "➕ None of these" dropdown choice) reveal inline
KEY-IN fields in the resolver itself — code/address/postal(required 6
digits)/phone, with the entry name fixed to the exact spelling the orders
use — posted to the normal `/api/address-book` upsert, so the new store is
added to the book, the jobs fix immediately, and future uploads resolve.

DELIVERY DETAIL + POSTAL CORRECTION — clicking a stop's client name in the
route planner (`.route-stop-client`), the "📝 Details / Fix Postal" button
in a map popup, or the 👁 view button in the fallback table opens
`openDeliveryDetail(jobId)`: job id, order ref, the MATCHED Address Book
entry (reverse-looked-up client-side, shows alias parentage), address,
phone, cartons, status, driver, route/stop, notes — plus an editable
postal field. Saving updates BOTH the job (`/api/transport/:id/update`,
because the book sweep never overwrites) AND the Address Book master
entry (merge-upsert: the `/api/address-book` upsert now MERGES per-field
with the existing entry so a postal-only update keeps code/chain/address).
Re-plans automatically if the planner is open.

UI: 📒 Address Book in the Transport sidebar sub-menu (`#addressBookModal`) —
add/edit one entry, delete entries, ⬇ download the current list as XLSX
(serves a template row when empty), ⬆ upload an edited list which REPLACES
the whole book (typed confirm; rows with non-6-digit postals are skipped and
reported as warnings). All endpoints require login; changes audit-logged
(`address_book_upsert`/`_delete`/`_import`).

### Transport tab scope: today's workload + balance, user-adjustable window

`renderTransportTab()` filters the fetched list before anything renders,
same PACKER RULE as the Orders tab: jobs not yet delivered/cancelled — the
carried-over balance, ANY age — are ALWAYS visible, regardless of the date
chips. The chips (`#transportDateRow`, `transportDateFilter`: Today
default / Yesterday / Last 7 Days / This Month / All — mirror the Orders
`.filter-chip` pattern) effectively slice only the settled jobs, matched by
`createdAt` OR `deliveredAt` falling in the SGT window (`en-CA` +
`Asia/Singapore`, never `toDateString`/`toISOString`). Anything delivered
before the selected window stays hidden (full history lives in Delivery
History / Reports). The stats bar's first tile relabels with the window
(Jobs Today / Jobs Yday / Jobs 7 Days / Jobs Month / Jobs All); the rest
count within the filtered set, plus the fixed **Done Yday** tile. The map,
fallback table, and planner all read the same filtered `transportRequests`;
route planning additionally excludes delivered/cancelled jobs so a closed
job can never re-enter a route.

### ALL business records live on the SERVER — localStorage is device-local only

Rule from the user: records from different users must be maintained
server-side. localStorage is reserved for genuinely device-local things:
session token (`wms_token`/`wms_user`), the app-lock PIN, the offline scan
queue (`is_offline_scans` — a network-outage buffer, by design), and the
scan resolve cache. Everything else was migrated:
- drivers → `db.drivers` (`/api/drivers`, see below)
- transport record edits / bulk driver assignment / deletion → the real
  `/api/transport/:id/update`, `DELETE /:id`, `/bulk-delete` endpoints
  (five call sites used to write `transportRequests` to localStorage only —
  edits were invisible to other logins and lost on refresh). `:id/update`
  now also accepts `packages` and `assignedDriver`/`assignedDriverName`
  (assignment flips status to preplanned unless explicit, never regresses
  confirmed/delivered).
- driver job lists/stats → DERIVED live from transport records
  (`jobsForDriver()` over `/api/transport`; `driverJobs` localStorage store
  removed). Driver Portal "Complete Delivery" calls mark-delivered.
- route templates → `db.transportTemplates`
  (`/api/transport/templates` GET/POST/DELETE — registered BEFORE `:id`).
  Template "apply" no longer clobbers the live in-memory job list (the old
  behaviour replaced `transportRequests` with partial objects lacking
  ids/status).
- the client-side copy of order-completion→transport-confirm logic was
  gutted — the server's `updateTransportOnOrderCompletion()` is the single
  implementation; the client just re-renders.

### Drivers are SERVER-side (db.drivers, /api/drivers) — not localStorage

`window.drivers` is loaded from `GET /api/drivers` (login, opening Driver
Management, and opening the route planner all refresh it). Add/edit posts to
`POST /api/drivers` (upsert by id), delete to `DELETE /api/drivers/:id`; all
audit-logged. Originally localStorage-only, which meant drivers added on one
machine were INVISIBLE from every other login — found when the user's team
couldn't see the fleet list. A one-time migration pushes any drivers still in
a browser's localStorage up to the server on first load, then clears the
local copy. GOTCHA: never call an /api/ endpoint before login — the global
fetch wrapper (top of app.js) force-reloads on 401, so an init-time fetch
without a token loops the login page; the init-time `loadDrivers()` is
guarded by a `wms_token` check for exactly this reason.

### Driver Performance report (`kind === 'drivers'`)

In ADMIN_REPORT_KINDS (admin login or master key). Live `db.transport` data
like `aging`/`inbound`. Three sheets: **Driver Summary** (jobs assigned/
delivered/confirmed/open, cartons, est. distance km, days active, avg jobs/
day), **Driver Jobs** (every job line with route/stop/times), **Notes**
(disclaimer). Distance is an ESTIMATE: per driver-day, stops sorted by
routeNum+stopSeq, legs summed with `transportLegKm()` over the server-side
postal-sector table (`SG_SECTOR_TO_DISTRICT_SRV` — a MIRROR of the client
map in app.js; keep both in sync), starting from the Marina depot reference
(018945). Suitable for comparing drivers/days, NOT for odometer or fuel
claims — the Notes sheet says so.

### Transport job deletion — ADMIN role only, direct (no approval queue)

Unlike orders/inbound (request + Master-approve), transport jobs are planning
data, so admins delete directly: `DELETE /api/transport/:id` (single, 🗑
button in each map-point popup — button only rendered for admin role) and
`POST /api/transport/bulk-delete` `{ids:[...]}` or `{all:true}` (the
"🗑 Clear All Jobs" button in the Upload Jobs modal, guarded by a typed
DELETE confirmation). Both use `requireTransportAdmin()` — master key or
admin role, warehouse gets a real 403 server-side. Every deletion is
audit-logged (`transport_deleted`, with mode single/ids/all and count).
bulk-delete must stay registered before the generic `:id` routes.

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

### Delivery History — viewer tab + Excel download (server.js `/api/transport/history*`)

The Transport tab's today-only scope (see above) deliberately hides past
deliveries — Delivery History is where they live. 📜 Delivery History in the
Transport sidebar sub-menu (`#deliveryHistoryBtn`, after Address Book) opens
`#deliveryHistoryModal`: date-filter chips (`.dh-range` — Today / Yesterday /
Last 7 Days / This Month) plus a custom from→to picker (`#dhFrom`/`#dhTo`/
`#dhApplyRangeBtn`), a summary line (`#dhSummary` — count, total cartons,
"⚠ N with remarks"), and a read-only table (Delivered At, TMS ID, PO/Ref,
Client/Store, Postal, Cartons, Driver, Status). Status renders green
"Delivered" or red "Delivered w/ Remarks" with the remark text underneath —
same `podRemarks` rule as `tmsStatusLabel`.

- `GET /api/transport/history?from&to` (both `YYYY-MM-DD`, default today)
  returns a BARE ARRAY of delivered-only rows — filter is
  `status === 'delivered'` with `deliveredAt` day-sliced (`.slice(0,10)`)
  into the inclusive from/to range, sorted newest first. Pending/preplanned/
  confirmed/in-transit jobs never appear regardless of dates.
- `GET /api/transport/history/export?from&to` → XLSX, single "Delivery
  History" sheet (title row + header + one row per delivery incl. address +
  POD remarks), filename `Delivery_History_<from>_to_<to>.xlsx`, downloaded
  via `authDownload`.
- Both routes MUST stay registered before the generic `/api/transport/:id`
  routes (same Express-ordering rule as import/plan/bulk-status/etc).
- Chip date maths (`dhRangeDates` in app.js) uses
  `toLocaleDateString('en-CA')` for LOCAL dates (never `toISOString`, which
  would shift the day near midnight); "This Month" = 1st → today.

### Sync Strategy

When porting to IdealScan or other codebases:
1. Copy `lib/tms-importer.js` verbatim (no platform dependencies)
2. Copy TMS endpoints from server.js to target codebase's order handler
3. Copy import handlers from public/app.js (update IDs if target uses different HTML)
4. Copy Transport tab HTML from public/index.html
5. Update CLAUDE.md in target with same Transport section
6. Link both commits in PR/commit messages for sync tracking

## Wave Picking — "consolidated pick, then sort" (lib/wave-pick.js)

Lets a packer select 2+ already-uploaded pending orders and pick every SKU's
TOTAL quantity across the whole wave in ONE pass (one bin visit for SKU-123
covers all 12 orders that need it, instead of picking it separately per
order), then a sort/allocate step divides the picked pile back into each
order's required quantity before the packer opens each order individually
to verify cartons and complete it. PICKING IS PAPER-DRIVEN, NOT SCAN-DRIVEN
— every pick-list line defaults to its full needed quantity the instant the
wave is created; a packer prints the list (`🖨 Print Pick List (PDF)`) and
walks the floor with it, only coming back to the on-screen list to correct
a line DOWN if a bin came up short. There is no "scan each SKU to build up
a running total" step — that on-screen scan-and-add flow was tried and
explicitly dropped as impractical (packers don't stand at a keyboard while
picking); the review screen is just an editable "Picked" number per line.
Selecting
exactly 1 order never triggers wave mode — it opens the normal single-order
scan overlay exactly as before; the wave bar only offers "Start Wave Pick"
at 2+ selections (Orders tab, checkbox column on `.wave-select-check`,
`waveSelected` Set in app.js). A persistent "☐ Select All" button
(`#waveSelectAllBtn`) sits at the TOP of the Active list — right below the
Active/Completed subtabs, above the table — not in a header checkbox easily
missed while scrolling; it toggles to "☑ Deselect All" once every eligible
order is selected. Combined with the existing client filter, this is how a
whole uploaded batch gets into a wave without checking each order one by
one. `waveCheckableNow` is computed from `activeOrders` right where the
Active/Completed split happens (before date/client filters are re-applied
below), so "select all" only ever grabs what's actually visible in the
current filtered view, never hidden rows. The bar itself is always visible
whenever the Active view has at least one selectable order, growing to show
"N selected / Clear / Start Wave Pick" once something's checked.

- **PORTABLE CORE — `lib/wave-pick.js`**: zero dependencies on IDEALONE's db
  shape, Express, or order/state schema — every function takes plain data in,
  returns plain data out (`buildWavePickList`, `createWave`, `setPickQty`,
  `autoAllocate`, `adjustAllocation`, `allocationSummary`,
  `isFullyScanned`/`isFullyAllocated`). `setPickQty` SETS a line's picked
  quantity directly — it is not an accumulator — matching the paper-driven
  workflow above; a host that still wants a scan-and-accumulate flow can
  layer that on top by reading the current value and adding to it before
  calling `setPickQty`. Copy this file verbatim into IDEALOMS
  or any other codebase, same convention as `lib/zort.js`/`lib/tms-importer.js`.
  The ONE seam into a host's real order records is `applyWaveToOrderStates(wave,
  applyFn)` — it never touches any host object directly, only calls
  `applyFn(order_number, sku, qty)` per allocated line, so wiring it to a new
  host's order store is a one-function job.
- **CLOSING A WAVE WRITES NOTHING INTO THE ORDERS** (corrected per user —
  the previous design auto-filled each order's `scanned` totals at wave
  completion, which was WRONG). The wave covers ONLY the consolidated floor
  pick: each (location, SKU) visited once for the wave's total. Sub-picking
  the pile back down to order level IS the normal per-order scan flow —
  the packer opens each order (scan its GI/waybill) and scans every piece
  from zero, so per-order verification is a real physical count, not a
  pre-filled number. `POST /api/waves/:id/complete` (accepted from
  `picking` or `sorting` status) only stamps `state.wave_id` on each
  order (skipping `done` ones), sets `wave.appliedToOrders = false`, and
  marks the wave `done`. `db.waves[]` (own `WV-YYMMDD-NN` serial,
  `nextWaveCode()`) tracks its `pickList` totals completely separately
  from `orderStates`. There is no on-screen sorting/allocation phase
  anymore — the client's `#waveSortingPhase` UI was removed; the
  `finish-picking`/`allocate` endpoints and the lib's allocation functions
  remain for API compatibility and portability but the shipped UI closes
  the wave straight from the picking screen ("✓ Close Wave — Start Order
  Scanning"). LEGACY: waves completed before this redesign DID write
  quantities (`appliedToOrders` absent = true) — the cancellation-approval
  reversal still subtracts for those, but for new-style waves approval
  just clears each order's `wave_id` pill (nothing to roll back).
- **FULL PICK BY DEFAULT, AUTO-ALLOCATE, then manual override**: `POST
  /api/waves` sets every line's `scannedQty = totalQty` right after
  `wavePick.createWave(...)` (before the response is even sent) and calls
  `autoAllocate()` once, so the sort screen already looks correct the moment
  the wave exists — the common case (nothing short) needs ZERO interaction
  before Finish Picking → Sort → Complete. `autoAllocate()` fills each
  order's need in wave order (first selected order first) from whatever the
  "Picked" quantity currently is, deterministic and idempotent, re-run after
  every `set-qty` call. `POST /api/waves/:id/allocate {sku, orderNumber,
  qty}` (the sort screen's +/- steppers) lets the packer manually correct
  the split between orders (e.g. a physical miscount); `adjustAllocation`
  clamps to `[0, scannedQty − everyone else's allocation]` so one order's
  line can never claim more than what was actually picked for that SKU.
- **ENDPOINTS**: `POST /api/waves` (creates from `{orderNumbers}`, refuses
  <2 orders, refuses an order already `done` or already in another
  non-terminal wave), `GET /api/waves` (list summaries), `GET /api/waves/:id`,
  `POST /api/waves/:id/set-qty {sku, qty, location?}` (SETS one line's
  picked quantity directly — the only way picked quantities change; resolves
  the sku through `resolveBeTimeCode2` first for consistency with normal
  scanning, though in practice it's called with the exact SKU already shown
  on that row), `POST /api/waves/:id/finish-picking` (→ `sorting` status),
  `POST /api/waves/:id/allocate`, `POST /api/waves/:id/complete`, `POST
  /api/waves/:id/cancel`.
- **SANITY CHECKS ON THE PICK SCREEN**: a stats strip (Orders / SKU Lines /
  Total Qty Needed / Scanned So Far) makes an upload or selection mistake
  visible before the packer is halfway through picking, and a collapsible
  "Orders in this Wave & what they need" table (`waveOrdersBreakdown()` in
  app.js — reverse-indexes the pick list back to per-order line lists) shows
  each order's GI/waybill number and what it's owed, so nothing is picked
  blind.
- **SCAN-TO-COMPLETE AFTER A WAVE**: no new scanning code was needed — the
  existing "Scan waybill number or order number to find order" bar
  (`waybillScanInput`/`waybillLookupGo`, already matches `issue_no` per the
  Scan-to-find-order section above) works on wave-completed orders exactly
  like any other order, since wave completion writes into the same real
  `orderStates`. Closing the wave modal (`closeWavePickOverlay`) calls
  `focusWaybillInput()` so the packer lands straight back on that bar, and
  the post-complete confirmation explicitly tells them to scan each order's
  GI/waybill to open and complete it next.
- **LIVE-WAVE PILL + REOPEN** — from the moment a wave is CREATED, every
  order in it shows a purple `🌊 <WV-id> — Picking` (or `— Sorting`) chip
  (`.chip-wave-active`): `globalOrdersWithState()` cross-references
  non-terminal waves' `orderNumbers` into `active_wave_id`/
  `active_wave_status` per order. The chip is clickable for EVERYONE (not
  admin-gated — reopening a wave is a packer action): `resumeWavePick(id)`
  fetches `GET /api/waves/:id` and reopens the overlay at the right phase
  (`sorting` → `showWaveSortingPhase(allocationSummary)`, else picking).
  This is also the discoverable route to the **Cancel Wave** button, which
  lives inside the overlay (`#waveCancelBtn`, instant cancel while the wave
  is still picking/sorting) — before this pill existed, closing the overlay
  left a live wave with NO visible way back to it or to cancel it. Both
  wave pills (this one and the completed one below) include the WV- number
  in their visible text, not just the tooltip.
- **"WAVE PICKED — SCAN TO PACK" PILL** (renamed from "Needs Closing" with
  the sub-picking redesign; the mechanics below are unchanged) — closing a wave stamps
  `state.wave_id = wave.id` on every affected order's state (in the same
  `/api/waves/:id/complete` callback that writes `scanned`), exposed as
  `wave_id` on every order object from `globalOrdersWithState()` (the
  function behind `/api/orders`). `renderOrdersList()` shows a blue
  `🌊 Wave Picked — Needs Closing` chip (`.chip-wave-pending`) on any order
  where `wave_id` is set and `scan_status !== 'done'` — a visible flag that
  the pieces are in but THIS specific order still has to be individually
  opened, verified, and Completed; a wave never does that part. The chip is
  purely a status read of existing state, not a new gate — the actual
  enforcement (wave completion never marks an order `done`) already existed
  before this chip did. Once the order is Completed normally the chip
  disappears (gated on `scan_status`), though `wave_id` itself is left on
  the record afterward as harmless history.
- **WAVE MANAGEMENT VIEW — sidebar sub-item under Orders** — "🌊 Wave
  Management" (`#ordersSubMenu`/`#waveMgmtSidebarBtn`, same sub-menu
  pattern as Transport's; shown when the Orders tab is active, hidden for
  warehouse role) opens `#waveManageOverlay`: a stats strip (Waves Picking
  Now / Closed — Scan to Pack / Orders in Waves / Orders Still to Pack)
  plus one row per non-cancelled wave — status, order count, "N/M packed"
  progress, total qty, created by/when, an Open button (live waves →
  `resumeWavePick`) and a per-order chip row colour-coded by each order's
  scan status (green done / amber processing / red pending, tooltip shows
  scanned/total). Data: `GET /api/waves?detail=1` adds an `orders[]`
  array (order_number, status, scannedTotal, totalQty) resolved through
  `globalOrdersWithState()` — only on demand, the plain list endpoint is
  unchanged. The same overlay hosts the bulk-cancel below (it grew out of
  the earlier "Manage Waves" modal — one surface, two jobs: see how many
  waves are going on + administer them).
- **BULK CANCEL — same overlay ("🌊 Wave Management", Admin-only)** —
  select-all across every non-cancelled wave, one password-confirmed
  action (`POST /api/waves/bulk-cancel {ids|all, password}` — admin role +
  own password re-entered, 403 not 401 on a wrong one). CANCELLATION TAKES
  EFFECT IMMEDIATELY (per user): legacy waves that prefilled quantities
  are reversed on the spot via `reverseWaveAndCancel()` (the same helper
  the per-wave approval uses — extracted for exactly this reuse; orders
  back to 0 scanned/pending, done orders skipped), new-style waves just
  lose their pills, in-progress waves cancel outright. Each cancelled
  wave is then stamped `pending_purge` — the RECORD stays in db.waves
  until Master approves deleting it clean from the data: `GET
  /api/master/wave-pending-purges` + `.../:id/approve` (splice the
  record) / `.../:id/reject` (keep it as cancelled history) — a FOURTH
  table ("Wave Deletion Requests") in Administrator → Pending Deletions,
  counted into the nav badge. Approve/reject never touches any order —
  the operational effect already happened at cancel time. This two-step
  split (effect now, purge later) is deliberate: packers must never wait
  on Master's approval to re-scan orders.
- **CANCELLING A COMPLETED WAVE NEEDS MASTER APPROVAL** — `POST
  /api/waves/:id/cancel` (instant, no approval) only works on a wave still
  `picking`/`sorting`, since nothing real has been touched yet; it already
  refused `done` waves before this. Once a wave IS `done` it has written
  real picked quantities into orders, so cancelling it follows the SAME
  admin-request/Master-approve pattern as order/inbound deletion:
  - `POST /api/waves/:id/cancel-request {reason, password}` — admin-role
    only, re-enters their OWN password as confirmation (403 not 401 on a
    wrong password, so the client's global session-expired handler doesn't
    fire). Sets `wave.pending_cancellation = {reason, requestedBy,
    requestedAt}`. The client reaches this by clicking the (blue, admin-only
    clickable) "Wave Picked" pill itself — `#waveCancelRequestOverlay`,
    same shape as `#deleteOrderOverlay`. The pill turns amber and reads
    "⏳ Wave Cancellation Requested" (`wave_cancel_pending` on the order,
    cross-referenced from `state.wave_id` against `db.waves` in
    `globalOrdersWithState()`) but otherwise nothing changes — the order is
    exactly as untouched as before the request.
  - `GET /api/master/wave-pending-cancellations` / `.../:id/approve` /
    `.../:id/reject` (checkMaster) — a THIRD table ("Wave Cancellation
    Requests") in Administrator → Pending Deletions, below the existing
    Orders and Inbound tables; the nav badge count sums all three.
  - APPROVE REVERSES, IT DOESN'T DELETE THE WAVE RECORD: walks
    `wavePick.applyWaveToOrderStates(wave, ...)` again (the SAME function
    used at completion time — direction is just "subtract" instead of
    "add") to undo exactly the qty/location lines this wave applied, clamps
    each `scanned[sku]` at 0, reverses the carton delta, clears
    `state.wave_id` (removing the pill), and sets `wave.status =
    'cancelled'`. Any order that's since been Completed is SKIPPED
    entirely — same "never touch a done order's record" rule deletion
    follows — and reported back separately (`skippedDone[]`) so Master
    knows which orders still carry the wave's contribution and must be
    handled some other way (e.g. a manual correction) if that's wrong.
  - REJECT just clears `pending_cancellation`; the wave stays `done`, the
    pill goes back to its plain blue "Needs Closing" state, nothing about
    the order changes — the packer's request was simply denied.
- **GROUPED BY LOCATION + SKU, not SKU alone** — a packer physically stands
  at one bin and picks everything from it, so `buildWavePickList` keys each
  pick-list entry on `(location, sku)`, not just `sku`. The SAME SKU stocked
  in two different bins produces TWO separate consolidated lines, each with
  its own needed-per-order breakdown — never silently summed into one
  location-blind total. `location` flows in from `lib/keyfields.js` mapRow's
  new `location` field (alias chain: `location`, `loc`, `bin`, `bin_code`,
  `bin_location`, `storage_location`, `rack`, `shelf`, `zone`, …) →
  `summarizeOrders`'s per-line push → server.js's `uniqueSkuLocationLines(ord)`
  (a location-preserving sibling of `uniqueSkuLines`, used ONLY when building
  a wave — every other scan/complete/mismatch path keeps using the original
  `uniqueSkuLines`, which pools by SKU alone and must not change behaviour).
  Orders/items with no location data fall back to grouping by SKU alone —
  fully backward compatible with hosts that don't track locations.
- **AMBIGUITY CAN'T ARISE ON THE REVIEW SCREEN** — every pick-list row IS one
  exact (location, sku) pair with its own "Picked" input
  (`.wave-picked-input`, `data-sku`/`data-loc`), so `waveSetPickedQty()` in
  app.js always knows exactly which line it's editing — no lookup-by-SKU
  ambiguity like a scan-driven flow would have. `POST /api/waves/:id/set-qty`
  still accepts an optional `location` and still returns 409
  `{ambiguousLocation:true, sku, options:[{location, needed, scanned}]}` if
  a caller omits it for a SKU stocked at 2+ locations — kept for API safety
  and for a future host that scripts against this endpoint directly — but
  the shipped UI never triggers it, since it always sends the row's own
  location. `adjustAllocation`/`findPickEntries` in lib/wave-pick.js take
  the same optional `location` param throughout for this reason.
- **PRINTABLE PICK LIST IS THE ACTUAL PICKING TOOL** — `🖨 Print Pick List
  (PDF)` (`printWavePickList()` in app.js) opens a new window with the
  consolidated list (Location / SKU / Description / Qty, plus a blank
  checkbox column for hand-ticking) and calls `window.print()` — same
  window.open+print pattern as the carton slip and driver run sheets
  elsewhere in this app (the browser's own print dialog offers "Save as
  PDF"). This is the document a packer actually carries onto the floor; the
  on-screen list is only for reviewing/correcting after the fact.
- **ULD FLOOR-LOCATION PRIORITY (server.js only, NOT in the portable lib)**
  — ULD's bin naming is Row-Bay-Location (`AA-BB-CC`, e.g. `99-001-011`);
  Row `99` is FLOOR level — no ladder/reach truck needed, the fastest pick
  a packer can make. `sortPickListUldFloorFirst()` re-sorts a freshly built
  wave's pick list so every `99-…` bin is grouped together AHEAD of every
  racked row, applied once right after `wavePick.createWave(...)` in `POST
  /api/waves`. Deliberately kept OUT of `lib/wave-pick.js` — the core module
  stays a generic, portable location+SKU grouping with no site-specific
  naming convention baked in; a future IDEALOMS port (or any other warehouse
  with a different bin-naming scheme) applies its own re-sort the same way,
  or none at all.
- **"START WAVE PICK" OFFERED RIGHT ON THE UPLOAD RECEIPT** — the Upload
  tab's success screen (`#uploadStartWaveBtn`, next to the existing
  "Download WMS File" button) appears whenever a batch of 2+ orders was just
  uploaded, so starting a wave doesn't require a separate trip to the Orders
  tab to hand-pick checkboxes for exactly the batch that was just uploaded.
  It still respects the existing download-before-scanning tab lock
  (`lockTabsForDownload`/`unlockTabsAfterDownload`) — clicking it downloads
  the WMS file (same as the Download button), unlocks the Orders tab, then
  jumps straight there with every order from that upload pre-selected and
  the wave-pick overlay already open.

### Sync Strategy — packaging this as a portable feature

Wave Picking is deliberately a self-contained vertical slice (1 core lib +
isolated additions to 3 files, same shape as Transport/Zort) so it can be
lifted into IDEALOMS or another codebase as one unit:

1. Copy `lib/wave-pick.js` verbatim — zero dependencies, drop-in.
2. Copy the `// ── Wave Picking ──` block from server.js (sits right after
   `/api/scan/reset`, before `/api/scan/resend-completion-alert`) into the
   target's order/scan handler, PLUS `uniqueSkuLocationLines` (sits right
   after `uniqueSkuLines`) and `uldLocationSortKey`/`sortPickListUldFloorFirst`
   (only if the target warehouse actually uses ULD's Row-Bay-Location naming
   — skip these two for any other convention, or write an equivalent) AND
   the `cancel-request`/`wave-pending-cancellations` block (sits right after
   the plain `/cancel` endpoint) — this second block calls
   `wavePick.applyWaveToOrderStates` a SECOND time (with a subtracting
   callback) to reverse an already-applied wave, so it depends on the same
   host functions as the completion endpoint. The endpoint block(s) call
   host functions that must already exist there: `findBatchForOrder`,
   `uniqueSkuLines`, `resolveBeTimeCode2`, `addToActiveCarton`,
   `appendScanLog`, `journalOrderState`, `logAudit`, `readDb`/`writeDb`,
   `readUsers`/`hashPass` (for the password re-confirmation step), and
   `req.userId` from the host's own auth middleware. If any are named
   differently, only this endpoint block needs adapting — `lib/wave-pick.js`
   itself never changes.
3. Add `require('./lib/wave-pick.js')`, `if (!_dbCache.waves)
   _dbCache.waves = [];` to the target's db init, and `nextWaveCode(db)`
   (mirrors `nextIdealscanCode`/`nextInboundCode` — copy verbatim, only the
   `WV-` prefix and `waveCodeSeq` counter key matter).
4. Copy the `location` field from `lib/keyfields.js` mapRow (if the target
   still uses that file) or add an equivalent alias chain so pick-list
   location grouping has data to work with — it degrades gracefully to
   SKU-only grouping if omitted entirely.
5. Copy the `waveSelected`/`activeWave` state vars and every `wave*`-
   prefixed function from public/app.js, plus the wave-select-bar/checkbox
   additions inside `renderOrdersList()` (checkbox column, `waveCheckableNow`,
   select-all wiring in the table header), the `wavePendingChip`/
   `.chip-wave-pending-clickable` logic in the same function, the
   `#uploadStartWaveBtn` wiring right after the upload-success download-
   button setup, and the `openWaveCancelRequestModal`/`_waveCancel*`
   block (mirrors `openDeleteOrderModal` exactly).
6. Copy the `#wavePickOverlay` and `#waveCancelRequestOverlay` modal blocks
   from public/index.html (plus the `#uploadStartWaveBtn` button next to the
   WMS download link, and the "Wave Cancellation Requests" table inside
   whatever the target calls its Pending Deletions tab) — modals must stay
   at BODY level, not nested inside a `.tab` section (see the modal-nesting
   visibility bug fixed for the Driver modal, above).
7. Copy the `/* ── Wave picking ── */` CSS block from public/styles.css.
8. Update the target's CLAUDE.md with this same Wave Picking section.
9. Link both commits in PR/commit messages for sync tracking.

## Admin: full roster exports (Users + Drivers)

`GET /api/master/users/export` (checkMaster-gated, same convention as `GET
/api/drivers/export`) returns the full user roster as XLSX — User ID, Name,
Role, Enabled Features — for handing off to another system or an audit.
Never includes `passwordHash`/`salt`. Button lives next to "System Users" in
Administrator → Users (`#adminExportUsersBtn`, wired with the `x-master-key`
header via `authDownload`'s optional third `extraHeaders` argument, since
this endpoint is master-gated like the rest of that panel rather than
session-gated like `/api/drivers/export`).

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
