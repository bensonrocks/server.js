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

## GI Analysis exports — "(017) SKU Lottables Issued" (lib/keyfields.js)

A real upload failed with 0 orders / 0 lines / "Conversion failed" /
"1 row skipped (missing SKU or order number)". The file is a WMS **GI Analysis**
report: six preamble rows (company, title, Format, Account, Site, Shipped Date)
then the real header row, then the data. `_detectHeaderRow` found the header
correctly — the failure was purely unmapped COLUMN NAMES:

- `SKU Code` → `sku_code`, absent from `mapRow`'s sku chain, so every row came
  out with an empty SKU and was filtered away by
  `.filter(r => r.sku && ...)`. Hence "row skipped" and zero orders.
- `SKU Descr` → `sku_descr` (description), `BatchNo/LotNo` → `batchno_lotno`,
  `ExpiryDate/Lot1` → `expirydate_lot1`. All added.
- `GI No`, `Tracking No` and the LHU/Loose/Whole qty family already resolved.

CLIENT FROM A ONE-CELL PREAMBLE: `_extractKVMeta` only handled key-in-column-A
/ value-in-column-B. This report puts the whole thing in ONE cell —
`"Account :    BETIME - BETIME"` — so nothing was found and the Confirm-Upload
dialog said "No client/brand name found in this file". It now also splits a
single cell on its first colon, and collapses an `account` value of the form
`X - X` (account code + account name, identical) to one name. `account` was
already in `_KV_MAP`; only the parsing shape was wrong. A plain `Account`
COLUMN is still never treated as the client — verified, since that could be an
account number.

Verified with the client's own file: 1 order, 1 line, conversion succeeded, no
skipped rows, client auto-filled as BETIME. Regression-checked against the
Keyfields `d-` schema, plain SKU/Quantity, and the Betime picking-list shape.

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

THE SAME GAP EXISTED IN LABEL MATCHING — `buildLabelMatchIndex()` only
indexed `order_number`/`waybill_number`/`po_number` when matching an
uploaded carrier-label PDF's pages to orders, so a label printing only the
GI number (which lives in `issue_no`, not `order_number`, on the XLSX/CSV
path above) had nothing to match against. See "Label matching — issue_no
indexing, first-write-wins, live re-extraction" further down for the fix
and the two other bugs found alongside it.

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

## Outbound fulfilment KPI — what has to leave, and what is critical

Per the user, for marketplace orders (Lazada / Shopee / TikTok / Shopify):
received **by 12:00** → picked, packed and handed over the SAME working day;
**12:01–14:00** → prioritise same-day, *"mainly for Shopee"*; **after 14:00** →
handed over the NEXT working day. *"Set the timer at the Office end so we can
tell what is critical."*

- **THE DEADLINE IS THE HANDOVER TIME, NOT A NOTIONAL END OF DAY.** A parcel is
  only fulfilled when it physically leaves, so the due moment is the daily
  collection cut-off (`pickupPolicy.cutoff`, 17:00) on the due day, and the days
  it can leave on are the days the collection policy already says it can
  (`nextHandoverDay` skips `noCollectionDays`). **ONE calendar, not two** — a
  second copy would drift the first time someone moved a courier's pickup time.
  Consequence worth knowing: Saturday IS a handover day here, because this
  operation self-drops on Saturday. Change that in Collection → ⚙ Schedule, not
  here.
- **NO WAYBILL, NO CLOCK.** Per the user, this KPI is the promise on ONLINE
  marketplace orders, and those arrive with a tracking number. An order with no
  waybill is a B2B or manually-keyed job carrying no handover commitment, so
  `fulfilmentSla` returns null for it — no chip, not counted in the tiles, not
  scored in the report. Inventing a deadline nobody agreed to would also bury
  the orders that DO have one under a pile that does not.
- **DERIVED ON EVERY READ** (`fulfilmentSla`), never stamped — same discipline
  as `collection_due` and the inbound SLA. Editing a band re-scores every open
  order honestly instead of leaving stale targets behind; the test asserts this
  by switching the KPI off (every promise disappears) and back on (they all
  come back).
- **TARGET vs COMMITMENT is a real distinction, not decoration.** The 12:01–14:00
  band is `commitment: 'target'` — we aim for it, and a miss reads as a missed
  target. `priorityPlatforms: ['shopee']` lifts it to a commitment **for that
  channel only**, which is exactly what the user asked for. The report scores
  the two groups separately: folding a "where we can" into a hard promise would
  flatter or damn us for the wrong reason.
- **JUDGED ON THE DAY IT LEFT, not when scanning stopped.** An order packed at
  16:30 makes the 17:00 handover; one packed at 18:30 leaves the next day and
  missed. `collectionDayFor(endTime)` supplies that day (or `pickup.at` when the
  parcel was actually closed off). Verified both ways.
- `db.fulfilmentPolicy` = `{enabled, bands[{until, sameDay, commitment, label,
  priorityPlatforms}], warnMins: 240, criticalMins: 120}`. `GET
  /api/fulfilment-policy` is open to anyone signed in (the floor has to know
  today's cut-offs); `POST /api/master/fulfilment-policy` is **admin or master**,
  same guard as the collection schedule — warehouse gets a real 403 and the ⚙ is
  not rendered for them. The **last band always catches everything** (`24:00`),
  or an evening order would fall through and carry no promise at all.
- **THE SCREEN**: a `#kpiBar` under the Orders stat tiles — Overdue / Critical /
  Due soon / On time, then Met / Late — where **every tile is a filter**,
  because knowing 6 orders are critical is only useful if those 6 are one tap
  away. **A FILTERED LIST SAYS SO IN WORDS** (`.kpi-filter-note` — "⏱ Showing
  186 of 189 — Due soon only", with a Clear filter button): reported as "the
  tiles do not filter" when they always had. With a 17:00 cut-off and a 4h
  amber window, from 13:00 onward nearly every same-day order is Due soon, so
  filtering to it removed 3 rows out of 189 and read as nothing happening. The
  row count cannot speak for itself when one bucket holds almost everything.
  (If the buckets are that lopsided the THRESHOLDS want tuning — that is the ⚙,
  and it is the user's policy, not something to quietly change for them.) Row chips show the countdown (`⏱ 2h 15m left`, `⏳ 13d 15h over`) with
  the whole promise in the tooltip. **The Active list is sorted most-urgent
  first** — a countdown nobody scrolls to is a countdown nobody acts on.
  Counted from the SAME `fulfilment` object the chips render, so tile and pill
  can never disagree.
- **Report — "⏱ Fulfilment KPI (Handover)"** (`kind === 'fulfilment'`, in
  `ADMIN_REPORT_KINDS`): every order with its band, due day, the day it actually
  left and the verdict; a Summary scoring Committed and Target separately; and a
  By Channel breakdown. Built from live orders, not the audit log, precisely
  because the promise is derived. (`outbound-stock` was also added to the
  Reports screen — it had been reachable only by API.)

Verified 37 API checks (each band incl. Shopee's exception, Friday→Saturday,
Saturday→Monday skipping Sunday, met vs missed across the 17:00 cut-off, the
thresholds moved around a real countdown to flip a live order
critical→amber→on-time, every open order in exactly one stats bucket, warehouse
403 with nothing changed but still able to read, three validation refusals, off
then on again) plus 30 browser checks on desktop and a Pixel 5 (tile colours by
computed style, the tile filter and its clear, urgency-first ordering, the
editor saving and the chips re-scoring at once, no cog for warehouse, and all
four live tiles fitting a 393px screen without scrolling the bar).

## Collection / "Picked Up" — finished is not the same as gone

Per the user: platform orders (Lazada/Shopee/TikTok) are collected by the
marketplace's own courier, so once a parcel leaves we can observe nothing more.
"Picked Up" is therefore a **terminal** fact, not a step towards Delivered —
making it a Transport leg would leave jobs stuck at "On the road" forever
waiting for an event that never arrives.

- **A SEPARATE FIELD, never `state.status`.** `state.pickup = {at, by, method,
  collection_day}`. `state.status` drives completion, stats, reports and the
  packer's screens; overloading it with a shipping state would ripple through
  all of them. `scan_status` is asserted untouched by the tests for this reason.
- Only **picked, packed and scanned** work can be closed — `/api/orders/pickup`
  refuses anything not `done` ("Not finished yet (pending)"). Marking a
  part-scanned order as collected would bank an unfinished pick as shipped.
- **`collection_due` is DERIVED, never stamped** (same discipline as the inbound
  SLA): `collectionDayFor(endTime, policy)` runs on every read, so changing the
  cut-off or the collection days moves every open order's target honestly
  instead of leaving stale dates behind.

### The schedule (`db.pickupPolicy`, editable from Collection → ⚙ Schedule)

`{enabled, cutoff:'17:00', selfDropDays:[6], noCollectionDays:[0]}` — defaults
are the user's operation: Saturday we drive to the drop-off point ourselves,
Sunday nothing leaves.

- **cutoff** — work finished after it rolls to the next collecting day.
- **selfDropDays** — the order left as part of being finished, so
  `applyAutoPickups()` marks it `method:'self-drop'` **stamped with `endTime`,
  not `now`**. The method name matters: the audit trail must never claim a
  courier collected something we dropped off ourselves.
- **noCollectionDays** — roll forward to the next day that collects.
- A day cannot be both (400). Saving re-runs `applyAutoPickups`, so newly
  adding a self-drop day settles that day's history immediately.
- **ADMIN OR MASTER, not master-only** — per the user, admins run this day to
  day (a courier changing their pickup time should not need the Administrator
  key). Same guard as `/api/master/report/:kind`: master key OR `role ===
  'admin'`, enforced server-side, so warehouse gets a real 403 calling it
  directly and not just a hidden button. READING the schedule
  (`GET /api/pickup-policy`) and CLOSING parcels off stay open to everyone
  signed in — that is floor work, not an admin decision.
- `sgParts()` derives the weekday from the SGT date STRING, so the host
  timezone can never pull a completion back a day (SGT everywhere — see
  "Day-bucketing is SGT").

### A marketplace parcel closes itself — `courier-scan` (`closeCollectionFromHub`)

The platform's own courier takes a marketplace parcel and we observe nothing —
so a finished Lazada/Shopee order sat at **Awaiting collection** forever and
then turned red **Not collected** days after it had actually shipped. The
courier's scan does reach ZORT; that is the handover we could not see.

SUPERSEDED RULE, changed per the user (Aug 2026): `/api/orders/pickup` used to
REFUSE a hand-tick on an API order. **The tick now closes API orders too** —
Picked Up is an INTERNAL own status, the pickup route pushes NOTHING to the
platform (never did), and this auto-close never re-stamps a pickup already
recorded, so a hand-close simply stands. What stays refused, API or uploaded:
anything not `done` (cancelled work included), and an order carrying
`platform_cancelled` — the collection queue lists those flagged red ✕
("do not ship, reclassify it instead") and never offers the tick, and
`closeCollectionFromHub` skips them too (ZORT saying "success" while the
marketplace says cancelled is a contradiction for a human, not an auto-close).

- **STAMPED `method: 'courier-scan'`**, never `manual` and never `self-drop`.
  The trail must never claim we handed the parcel over ourselves or that
  somebody here ticked it — nobody did either. `via: 'zort'` and `hub_status`
  ride along, so the record says where the fact came from.
- **API ORDERS ONLY, structurally**: the order has to carry a `zort_id` that
  MATCHES the hub record. An uploaded order merely sharing an order number is
  not this order and carries no channel relationship at all — there is no flag
  to forget, the gate is the data.
- **`shipping` and `success` only** (`ZORT_LEFT_STATUSES`). **`waiting` (RTS'd)
  is deliberately excluded** — Ready-to-Ship is US declaring the parcel ready,
  not the courier taking it, and closing on it would record a collection that
  has not happened. `returned` is left out too: it did leave, but a returned
  parcel is its own story and calling it a clean collection overstates what we
  know.
- **THE HUB SAYS SHIPPED AND WE HAVE NOT FINISHED PACKING IT** is a real
  disagreement, not a collection: audited `zort_collection_conflict` and
  counted on the store row, nothing changed. A FRESH IMPORT HAS NO STATE RECORD
  AT ALL and those are the loudest case (somebody shipped it outside the
  system), so a missing state reads as pending rather than as "nothing to do" —
  the same trap the no-stock sweep hit.
- **WHEN it left**: the hub's own timestamp when it gives one, else now (when
  we learned of it) flagged `at_estimated` with `noticed_at` beside it, and
  never earlier than `endTime` — a parcel cannot leave before it was packed.
  This matters because `fulfilmentSla` judges the promise on the day it left.
- Never re-stamps an existing pickup, so a re-pull cannot move a closed record.
- **`store.collectionSync`, default ON** (absent reads as on): off by default
  would leave every already-connected store with the bug. Turn it off per store
  on Connections → the ZORT store form.
- The client is told **Picked Up** in our own words, with `by_courier: true`
  ("collected by the platform's courier") alongside the existing `by_us`
  self-drop wording — so the two ways a parcel can leave never read the same.

Verified 31 API checks against a hub whose orders move (closes on Shipping with
the right method/by/via, dated from the hub's own timestamp, clamped when that
timestamp precedes the pack, flagged estimated when there is none, RTS'd does
NOT close, an unfinished order is refused and reported, a second pull changes
nothing, the switch turns it off, and the client sees the courier wording) plus
10 browser checks on desktop and a Pixel 5.

### The screens

- Order-row chips: green **✓ Picked Up**, amber **📦 Awaiting collection**,
  red **⚠ Not collected** once the due day has passed. Nothing at all on an
  order still being picked. Colours asserted by computed style, not class name.
- **Orders → 🚚 Collection** (`#pickupOverlay`): four tiles, a scan bar, and the
  queue grouped by the day each parcel leaves, oldest first. Scanning a waybill
  closes that one parcel (`method:'scan'`); ticking closes a trolley
  (`method:'manual'`). `undo:true` reverses a mis-tick.
- Selection is held in a Set and re-applied after each render, and ticks whose
  rows are gone are dropped — same reasoning as the bulk-deletion tables.
- Badge on the Orders tab counts what is still to leave and turns red when
  anything is overdue. `switchTab` reaches the module via `window.pickupUI`
  because it runs earlier in the file than the `const` (the temporal-dead-zone
  trap `waveUI` documented).

`.modal-card` HAD NO CSS AT ALL — every modal using it (split inbound,
putaway-now-or-later, this one) rendered as bare content floating on the blurred
backdrop, and on a phone the inline `max-width:900px` made it wider than the
screen and clipped it on both sides. Now styled like the card it is, with
`width:100%` so the inline max-width is a CAP, plus the bottom-sheet treatment
`.modal` already had under 768px.

`refreshOrders()` only REFETCHES; it does not repaint. Anything that needs the
Orders list to visibly change must call `renderOrdersDash()` (which awaits
refreshOrders and then renders) — calling refreshOrders alone left the closed
order still showing "Not collected" behind the modal.

### Relayed to the client portal

Per the user, whatever status we hold is pushed back to the client — and in the
SAME words we use, not a parallel vocabulary (the standing rule from the TMS
pills). `portalPickup(state, policy)` builds it ONCE and is reused by
`/api/portal/orders`, `/api/portal/order/:orderNumber`, the orders XLSX export
(`Collection` + `Picked up (SGT)` columns) and the `orders[]` inside each
client submission row, so those four can never drift.

- **Ready for Collection** (green), **📦 Picked Up** (a STRONGER solid green),
  blue **Not collected**. Per the user: a packed parcel on the shelf is good
  news, so it reads as good news — "Awaiting collection" described our queue,
  "Ready for Collection" describes their order. Picked Up keeps a distinct
  green so the terminal state is not just one more green pill (asserted: the
  two background colours differ).
- **Pending Processing** (yellow) replaced "Queued" for the same reason —
  "Queued" said where the work sat in OUR list. Yellow is `p-wait`, deliberately
  not the amber `p-open` that "Being packed" uses: one is waiting, the other is
  moving.
  Blue for the missed case is deliberate — it follows the portal's existing
  GREEN = met / BLUE = missed rule, not the office's red.
- Both labels live in ONE place server-side (`PORTAL_STATUS_LABEL` and
  `portalPickup`), so the orders list, the order detail, the submission rows and
  the XLSX export cannot drift — the export is asserted to carry the same words.
- `by_us: true` when the method was `self-drop`, and the client is told plainly
  ("delivered to the drop-off point by us") rather than being left to assume a
  courier collected it.
- An order that is not `done` carries **no** collection status at all — there is
  nothing to collect yet, and an empty pill would read as a problem.
- **Undo propagates.** Reversing a mis-tick at our end takes the client's pill
  back with it, so they are never left looking at a wrong "it left".
- **`applyAutoPickups` also runs at BOOT and on the portal read.** Completion
  covers new work and the Collection queue covers the office — but a client
  opening their portal before anyone here opens that screen would otherwise see
  Saturday's parcel as still sitting with us. Idempotent, so both are no-ops
  when clean.

Verified: 30 API checks (every day rule incl. after-cut-off roll, Sunday wait,
Saturday auto-settle stamped at `endTime`, part-done refused, double-close
refused, undo, derived due days moving with the cut-off, the self-drop/no-
collection clash), 25 browser checks on desktop and a Pixel 5 — pill colours by
computed style, the scan close, the bulk close, the schedule editor, and no
sideways scroll on a phone — plus 14 access checks (admin saves without the
master key, warehouse 403s and changes nothing, the master key still works from
any account, no token is 401, and warehouse can still read the schedule and
close parcels), plus 18 relay checks (the client sees Picked Up / Not collected
in our words, self-drop flagged as ours, an unfinished order carries nothing,
closing and undoing both propagate, and the XLSX carries the same value).

## Reclassifying COMPLETED orders — the one password-gated exception (server.js `/api/orders/bulk-reclassify`)

Per the user: *"orders could be done. but I need to be able to reclassify them
to pending (put back inventory), or cancel order. user can select a few and
choose to reclassify. password of the user is needed."* This DELIBERATELY bends
the standing completed-work-is-never-regressed rule — do not "fix" it away, and
do not widen it: everywhere else (bulk-cancel, batch delete, mass putaway,
refile's pending path…) the rule stands, and this route is the one door
through it, gated on the person's own password.

- **`POST /api/orders/bulk-reclassify` `{orders[], to:'pending'|'cancelled',
  reason, password}`** — `verifyAdminReconfirm(role:'admin')`: the caller's OWN
  login password or the Administrator key, **403 never 401** (a 401 trips the
  client's session-expired reload and eats the typed reason). Warehouse gets a
  real 403 server-side and the button is hidden for them. Reason ≥ 6 chars.
  Only `done` orders accepted; anything else is refused BY NAME (open orders
  already have ✕ Cancel / deletion). Per-order outcomes, one `writeDb`.
- **"PUT BACK INVENTORY", precisely.** Completion deducted on-hand and released
  the reservation, so the give-back is gated on `state.inventory_deducted`
  (an untracked batch or a repeat call can never inflate stock) and differs by
  destination:
  - **→ pending**: deduction returned as `adjustment` movements naming the
    reclassification, then the reservation is RE-TAKEN (`reserveOrder`) — a
    pending tracked order holds one. A shortfall on re-reserve is REPORTED,
    never a block. Scan counts reset, cartons/endTime/startTime/pickup cleared
    — the floor genuinely re-picks — while `scanLog` keeps the history plus a
    `reclassified` entry.
  - **→ cancelled**: deduction returned, NOTHING reserved. `unprocessed_at` is
    stamped (the `cancelledAtOf` day-bucket field — omitting it refiles the
    cancellation under the upload date, the 15-vs-17 class of bug), reason
    recorded, and the hub is told through `tellHubWeCancelled` — the same
    guarded path as the office bulk-cancel (off unless the store opted in, and
    its read-back refuses a parcel that already shipped).
- **BIN POSITIONS ARE NOT REWRITTEN** — same honesty as the completed-order
  refile — and both the modal (before) and the outcome dialog (after) say so:
  the account balance is corrected, the SKUs want a putaway/cycle count.
- Audited `order_reclassified` per order (units returned, shortfalls,
  wasPickedUp, who, viaMaster) + one `orders_bulk_reclassified`.
- **NOT reversed here, stated honestly**: a transport job flipped to
  `confirmed` by the completion, and anything the completion push already told
  the hub (`zort_pushed_at` is left standing so completion does not re-push).
- UI: **↺ Reclassify** on the Orders bulk bar — counts only the selected DONE
  orders, disabled at zero, hidden for warehouse. `#reclassifyOverlay`: the two
  destinations spelled out in consequences, the bin caveat, reason + password.
  A wrong password shows INLINE and keeps the typed reason.

Verified 30 API checks driven through the REAL pipeline (stock in → upload
reserves → complete deducts → reclassify), so the stock assertions measure the
genuine ledger: wrong password/short reason/unknown state each refused with
nothing moved, pending gets its units back AND re-reserved with counts reset, a
repeat finds the order no longer done and moves nothing, cancelled gets units
back with nothing reserved and the day stamped, a mixed selection refuses by
name and carries on, warehouse 403s, and the trail names who/why/how much.
Plus 14 browser checks on the full flow.

TEST GOTCHA: the office Orders screen's Active/Completed/Cancelled switcher is
a `data-oview` SUB-TAB, not a `.filter-chip` (those are the date chips) — a
selector that "clicks Completed" via the chips silently no-ops and the test
then reads the Active list.

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

## Same-file re-upload confirmation (server.js /api/upload, /api/label-imports)

Distinct from the duplicate-ORDER-NUMBER tiers above — this catches
literally re-uploading the SAME FILE (identical filename AND identical
bytes, sha256 `contentHash` stored on the batch/import record at upload
time). Runs first, before parsing and before the per-order duplicate
checks:
- **CONFIRMABLE** (409 `{needsSameFileConfirm, existing:{filename,
  uploadedAt, uploadedBy, ...}}`): client confirm() reads out the earlier
  upload's details; OK resends with `overwrite_same_file=yes`, which
  REMOVES the earlier batch/import (and, for label imports, its
  `db.orderLabels` attachments) and proceeds fresh with this upload —
  never stacks a duplicate copy.
- **HARD abort** (422, orders only): the earlier batch has a DONE order —
  same standing rule as everywhere else, completed work is never
  overwritten, so this aborts instead of offering the confirm.
- Only batches/imports uploaded after this feature shipped carry
  `contentHash`; older records simply never match, so they're invisible
  to this check (not a bug — nothing to compare against).

## Batch deletion refuses completed orders; label imports are deletable

`DELETE /api/master/batch/:batchId` used to splice the whole batch
unconditionally — the only destructive path in the app that didn't check
for completed work first. Now refuses (403, naming every completed order
in the batch) if ANY order inside is `done`; the per-order deletion
request workflow (admin-request + Master-approve, see order/inbound
deletion elsewhere in this file) is the only way to remove a batch that
contains completed work, one order at a time.

`DELETE /api/label-imports/:id` (master-key gated) is new: a label PDF
import carries no operational progress (it's just PDF pages matched to
orders for printing/reference), so it's deletable outright with no
done-order check — removes the import record, every `db.orderLabels`
entry pointing at it, and the page PDFs on disk. UI: 🗑 button on each
label-import card in the upload history.

## Label matching — issue_no indexing, first-write-wins, live re-extraction (server.js `buildLabelMatchIndex`/`rematchLabelImport`)

Three bugs that together meant "500+ matched labels never appeared on the
orders the packers actually work from":

1. **`issue_no` wasn't indexed.** Same gap as the scan-to-find-order bar
   (see above) — BETIME/XLSX orders carry their GI number in `issue_no`,
   a field separate from `order_number`. A label PDF printing only the GI
   number had nothing to match against until `issue_no` was added to
   `buildLabelMatchIndex()`'s keys (own `byOrderNo` entry + a `scanKeys`
   fallback candidate), exactly like `order_number`.
2. **Stale duplicates were winning the match index.** `buildLabelMatchIndex()`
   used `Map.set()` for the `byOrderNo`/`byWaybill` maps — since orders
   are iterated newest-batch-first, a stale duplicate order sharing a
   waybill/GI key with the CURRENT order would overwrite it (last write
   wins). Now first-write-wins: `if (!byOrderNo.has(key)) byOrderNo.set(...)`,
   so the newest order (encountered first in the newest-first iteration)
   always keeps the key.
3. **Rematch reused the cached extraction.** `rematchLabelImport()` matched
   against `page.extracted` as captured at upload time, so an extraction
   improvement (e.g. the tracking-number regex widening below) never
   reached an already-processed import — only fresh uploads benefited.
   Rematch now re-runs `extractLabelFields(rawText)` on every page before
   matching, so `↻ Rematch All` (added next to `⚡ Auto Match Unmatched`
   on the Labels import review screen) genuinely re-evaluates old imports
   against current logic, not just the current order list.

`lib/label-extract.js`'s tracking-number regex was also widened from
`[A-Z]{2,4}\d{10,18}` to `[A-Z]{2,6}\d{9,18}` — 5–6 letter courier
prefixes (SPXSG…, SPTTND…) were being missed entirely; existing
TRACX/SGDEX/postal patterns run first and are unaffected.

## Live-wave visibility pill + build stamp (server.js `globalOrdersWithState`, public/app.js)

Before a wave had a visible pill, closing the Wave Pick tab left a
picking/created wave with NO way back to it — and therefore no reachable
Cancel Wave button. `globalOrdersWithState()` now maps every order to its
wave via `activeWaveByOrder` (waves not yet `completed`/`cancelled`) and
`doneWaveByOrder` (completed waves, newest-first so a stale duplicate
never wins — same first-write-wins pattern as the label match index
above), exposing `active_wave_id`/`active_wave_code`/`active_wave_status`
and `wave_id`/`wave_code`. Every wave gets a short display code
(`nextWaveCode()`, `WV-YYMMDD-NN`, per-SGT-day counter) alongside its
internal UUID — the UUID stays the primary key everywhere, `code` is
purely for what's shown on screen.

- **Purple "🌊 WV-… — Picking/Ready" chip** on any order still inside a
  live (not-yet-completed) wave, clickable by anyone
  (`resumeWavePick(waveId)` → switches to the Wave Pick tab and opens
  that wave's detail view directly, where Cancel Wave lives).
- The existing amber "Needs Closing" pill (shown once a wave is completed
  but the order hasn't been individually finished through Scan & Check)
  now shows the WV- code in its visible text too, not just in the tooltip.
- **Retroactive fallback**: `wave_id`/`wave_code` resolve via
  `doneWaveByOrder` even when `state.wave_id` was never stamped on the
  order (e.g. a wave completed with no fully-picked lines, or one
  completed before the stamping feature existed) — so the pill isn't
  silently missing for older/edge-case data, it's derived fresh from
  `db.waves` every time `globalOrdersWithState()` runs.

**Build stamp** — `GET /api/version` (public, no auth — `AUTH_PUBLIC`)
returns `{commit, bootedAt}` (`RAILWAY_GIT_COMMIT_SHA`/`SOURCE_COMMIT` +
process start time); rendered as a small `build xxxxxxx · up since …`
line under the sidebar's Administrator button (`initBuildStamp` in
app.js) so "did the new deploy actually go live?" is answerable by
reading the screen instead of digging through deploy logs.

## Direct marketplace webhooks — Shopee & Lazada (own API), admin-gated backup

Per the user: **ZORT stays the live order intake**; IdealOne's OWN direct
connection to Shopee and Lazada is a **background backup an administrator turns
on** when ready to port off ZORT, and can turn back off to fall back. The two
providers are mirrored deliberately, NOT shared — a change to one marketplace's
rules must never silently alter the other's.

- **Receivers**: `POST/GET /api/shopee/push` and `/api/lazada/callback` (both in
  `AUTH_PUBLIC` — external callers). ACK 200 fast (Shopee's "Verify and Save"
  and Lazada both require a quick 2xx). Raw body is captured for signature
  verification.
- **Signature**: Shopee = HMAC-SHA256(`<callback_url>|<raw_body>`, push
  partner_key) in the `Authorization` header — CONFIRMED against Shopee's verify
  step. Lazada = **HMAC-SHA256(`app_key + raw_body`, app_secret), hex, in the
  `Authorization` header — CONFIRMED against a real captured push** (verified ✓
  on the live site, 2026-08-08). Two traps that each cost a debugging round,
  found via the raw-push viewer (each log row's "raw" button shows the raw
  body, headers, sign, and every computed candidate with a ✓/✗ badge):
  (1) the global `app.use(express.json())` consumed the stream before the
  route's verify could capture `req.rawBody`, so verification compared against
  a RE-SERIALISED body that could never match — the global parser now stashes
  the raw bytes for the webhook paths (`RAW_BODY_PATHS`); (2) the sign rides in
  the `Authorization` HEADER, not a body `sign` field. `verifyLazadaPush` tries
  candidate signing strings (app_key+body first, body alone as fallback),
  accepts timing-safe whichever matches, and NAMES the scheme on the log entry.
  An unsigned push with a secret set is `unverified_skipped`.
- **TWO GATES before any order is touched**: a verified signature AND
  `config.shopeeDirectEnabled` / `config.lazadaDirectEnabled` (both **off by
  default**). While off, every push is received and LOGGED (`direct_disabled`)
  so the wiring is provably working, but no order changes.
- **Actions land on EXISTING fields, so they surface in the EXISTING UI, no new
  screens**: a cancel (`CANCELLED`/`IN_CANCEL`; Lazada `canceled`) voids the
  matching order and releases its reservation — but ONLY if pending and
  untouched; a cancel on a scanned/done order is a logged conflict, never
  regressed (same rule as `handleZortVoid`). A tracking-number push updates
  `waybill_number` — the SAME field that prints at scan completion — so the
  packer's label is current; refused on a done order whose label already
  printed. Product-level pushes (banned item, stock, violation) are
  alert-only.
- **Order match** by marketplace order id → `order_number` (what ZORT stamped)
  or by tracking → `waybill_number`. Unmatched is logged, never dropped. HONEST
  CAVEAT: if ZORT stored a different `order_number` than the marketplace serial,
  a cancel comes back `no_match` (harmless) — the push log shows it and the fix
  is to add the marketplace id as a match key.
- **Config + viewer**: `GET/POST /api/master/{shopee,lazada}/config`
  (checkMaster) read state, flip the switch, set the key/secret IN-APP (no
  redeploy; an env `SHOPEE_PUSH_PARTNER_KEY` / `LAZADA_APP_SECRET` still wins),
  and return the recent push log. UI: two panels on the **Connections** tab
  (Administrator-gated) — the on/off switch (confirms before turning on), the
  key field, and a live table of recent pushes with when/code/verified/what-
  happened. Answers "where can I see this push?".
- **Intake stays single-source**: do NOT build direct order PULL from a
  marketplace while ZORT is the intake, or the same order imports twice. This
  path is EVENTS-ONLY on orders ZORT already brought in.

Verified 13 Shopee + 14 Lazada API checks (dormant while off, acts once on,
cancel voids pending / refused on scanned+done, tracking updates open / locked
on done, unmatched no-op, unverified takes no action) plus 6 browser checks on
the Shopee panel.

### Marketplace token auto-refresh + Connections health check

- **WITHOUT A REFRESH SWEEP, EVERY SELLER AUTHORIZATION DIES IN A DAY.** The
  Lazada app console shows access tokens lasting **1 day** (refresh 5 days) —
  far shorter than the ~7d the exchange response implies. `refreshMarketplaceTokens()`
  (server.js, next to the OAuth routes) sweeps `marketplaceAuth`'s
  {provider → client → record} store every 15 min (+ once ~90s after boot,
  `_mpRefreshing` reentry guard): an entry is DUE when its `expires_at` is
  inside the provider window (`MP_REFRESH_AHEAD_MS` — Lazada 6h, Shopee 1h),
  or twice a day when the expiry is unknown. Refresh calls live in
  lib/marketplace-oauth.js (`lazadaRefreshToken` — `/auth/token/refresh`,
  same signing as create; `shopeeRefreshToken` — `/api/v2/auth/access_token/get`).
  **Both providers ROTATE the refresh token on every call — store both halves
  back or the next refresh fails.** Failures are recorded on the record
  (`refresh_error`) and audit-logged (`{provider}_token_refresh_failed`), and
  the entry retries each sweep while its refresh token still lives. Entries
  connected via a PASTED token have no refresh_token and are skipped — the
  health check names them as "cannot auto-refresh" rather than leaving a
  mystery. TikTok has NO direct app yet (flows via the Hub) — deliberately no
  fake TikTok code; a future app slots into the same sweep.
- **`GET /api/master/connections/health` is READ-ONLY by contract** — per the
  user, a health check must never affect the main flow. It only reads stored
  state (no external calls, no writes): per-provider credentials/switch state,
  per-client token validity + refresh status, last push received (+verified?),
  Hub stores with last pull + outbox pending/stalled, and the OneMap token.
  UI: 🩺 Health Check panel at the top of Connections, with a "↻ Refresh
  tokens now" button (`POST /api/master/connections/refresh-tokens`) for
  on-demand sweeps.
- WHERE TO AMEND a marketplace: credentials/switches/URLs are all IN-APP on
  the Connections tab (db.config, no redeploy); per-provider protocol logic
  (auth URLs, signing, token exchange/refresh) is isolated in
  lib/marketplace-oauth.js; the receivers + sweep wiring are the marketplace
  block of server.js. One provider's change never touches another's code.

Verified with a mock refresh endpoint: a due Lazada entry and a due Shopee
entry refresh (rotated refresh tokens stored back), a not-yet-due entry and a
pasted-token entry are untouched, a bad refresh token records its error and
keeps retrying, a second sweep is otherwise a no-op, and the health endpoint
returns the full shape while writing nothing.

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
- **WHICH CLIENT A SYNCED ORDER BELONGS TO — the SKU decides.** One store
  account houses MANY clients selling on the SAME channels, so the sales
  channel is too coarse: every unmapped order was filed under the store's own
  name (`IDEALONEMAIN`), where its stock, billing and portal visibility all sat
  against the wrong account **in silence**. Per the user, no SKU is shared
  between clients, so the products on an order name its owner outright.
  `buildSkuOwnerIndex(db)` builds SKU → client once per pull;
  `attributeSyncClient()` resolves each order: **SKU (specific) → channel map
  (coarse) → the store's default**.
  - A client can exist **ONLY as an item master** — that is what onboarding
    creates FIRST, before any profile or order — so the index also reads
    `inventory.listClientIds()`. Without it the NEWEST clients were exactly the
    ones it could not place (caught by the test: everything came back
    IDEALONEMAIN).
  - A SKU registered to TWO clients resolves to **nothing**, not a guess.
  - An order it cannot place still falls back to the store, but is REPORTED —
    `lastResult.needsAttribution` with the reason, and audit-logged
    `sync_client_attribution_unsure`. Silence is what made this invisible.
  - A channel mapping that CONTRADICTS the SKUs is flagged too: one of the two
    is wrong and someone should look.
  Verified 10 checks against a mock store carrying three orders: the AAA-1
  order files to AlphaCo, the BBB-1 order to BetaCo, a SKU nobody owns falls
  back to the store AND is the only one flagged, and the pull splits into one
  batch per client.
- **AND WHEN IT LANDS WRONG ANYWAY — `POST /api/orders/:orderNumber/refile`.**
  Reported live as *"this order exists in Zort but not in IdealOne"*. It was in
  IdealOne all along: its SKUs were registered in TWO item masters, so
  attribution refused to guess (correctly), fell through to the channel map, and
  filed it under a "client" called **LAZADA** — a sales channel, not an account.
  From everywhere scoped to the client it really belongs to (their portal, their
  stock, their billing, the sidebar filter) it was simply absent, which reads
  exactly like a missing order. **A re-pull cannot fix it** — the sync skips
  order numbers it already holds, which is what makes re-pulls idempotent.
  - **THE BATCH IS WHAT CARRIES THE CLIENT, so this MOVES the order** rather
    than stamping a per-order override. Every reader — portal, billing, reports,
    sidebar, stock — resolves an order's client through `batch.client_name`; an
    override would mean editing dozens of read sites and silently missing one,
    which is the same class of mistake that misfiled it to begin with.
  - A batch holding only that order is renamed; otherwise the order is **split**
    into its own batch which KEEPS the job code, filename, upload time and
    uploader — it really did arrive on that job, and rewriting its provenance to
    tidy away a filing mistake would be worse than the mistake. `contentHash` is
    deliberately NOT copied (two batches answering to the same-file fingerprint
    would make the re-upload check ambiguous), and the new batch is **unshifted**
    because `globalOrdersWithState` is newest-batch-wins.
  - **THE STOCK MOVES WITH IT**, which is what makes this a fix rather than a
    label change: the reservation is released on the old account and taken on
    the new one, and pick locations are re-allocated — the pick list was pointing
    at the WRONG CLIENT'S BINS. What to release is read from the ledger
    (`openReservations`), never assumed from the order's lines: releasing a
    quantity it never reserved would free somebody else's units on the same SKU.
  - **A COMPLETED ORDER MOVES TOO, and takes its deduction with it.** The first
    cut refused one (the standing completed-work rule) — but the order actually
    reported was already DONE, and what is wrong about it is the ATTRIBUTION,
    not the shipment. So per the user the deduction is moved at ACCOUNT level:
    given back on the account that never shipped it, taken on the one that did,
    as `adjustment` movements naming the refile on both sides so neither balance
    moves without an explanation. The work itself is never regressed — the order
    stays `done`.
    - **BIN POSITIONS ARE NOT REWRITTEN**, and cannot honestly be: the pieces
      physically came out of the old client's bins, and inventing a bin movement
      on the new client would be a claim about where stock sat that nobody can
      support. Both the dialog (before) and the answer (after) say so, because
      it means both accounts want a cycle count on those SKUs.
    - Symmetric — moving it back returns both balances exactly, with no drift.
    - A SKU the new client's master does not carry is **named**, never created.
  - **MASS SELECTION** (`POST /api/orders/bulk-refile {orders[], client,
    reason}`, 🔄 Refile on the Orders group bar). One misattributed SKU misfiles
    every order carrying it, so these arrive in batches. ONE db write for the
    lot, per-order outcomes so a single refusal reports itself instead of
    stopping the rest, capped at 500. Audited `orders_bulk_refiled` alongside
    each order's own `order_refiled` entry.
  - A shortfall on the new account is **reported, never a block** — the order is
    real and already on the floor; a backorder keeps it visible. A **live wave**
    is named in the response, because its pick list was built against the old
    client's bins.
  - **THE "SKUs → …" FLAG IS CLEARED BY THE REFILE.** It is stamped at pull time
    to say attribution could not decide, and its tooltip said to fix the item
    master and RE-PULL — which cannot work, since the sync skips numbers it
    already holds. Left standing on a row a person has just settled, it is a
    warning that outlived the decision it asked for, which is how people learn
    to ignore warnings. What it said is kept on the audit entry (`wasHinted`),
    and the tooltip on the ones still flagged now points at 🔄 Refile and says
    re-pulling will not fix it.
  - Admin or master; warehouse gets a real 403. Reason of 6+ characters, audited
    `order_refiled` with from/to/why/who. Transport jobs are deliberately NOT
    rewritten — their `clientName` is the CONSIGNEE, not the billing account.
  - **THE 6-CHARACTER RULE HAS TO SAY SO ON THE SCREEN.** Reported live as
    "refile doesn't work": the reason typed was "Wrong" (5 chars), the Refile
    button only unlocks at 6, it had NO disabled styling (solid blue, looked
    live), and a disabled control fires no events — so the tap did nothing in
    total silence. Now: `#refileConfirmBtn[disabled]` is dimmed with
    `pointer-events:none` so the tap falls through to `#refileActions`, which
    answers in words ("the reason needs at least 6 characters (1 more)"), and
    `#refileReasonHint` states the rule up front and counts down in amber
    while short. Same trap exists anywhere else a button silently gates on
    input length — check for it before shipping such a gate.
  - UI: 🔄 on the order row (admin, not-done) → `#refileOrderOverlay`. The client
    is a **PICKER fed by `/api/putaway/clients`, never free text** — a typed name
    is precisely how the phantom account appeared — and it never offers the
    client the order is already on.
  Verified 37 API checks on the pending case (the reservation moving off one
  shelf and onto the other with no on-hand touched, the sibling order untouched,
  provenance kept, warehouse 403) and 37 more on the completed and bulk cases
  (the deduction moving both ways and returning exactly on a move-back, both
  ledgers naming the refile, an unknown SKU reported and not created, three
  moved with the non-existent one refused by name, only the completed one moving
  stock), plus 28 + 26 browser checks on desktop and a Pixel 5.
- **IMPORTING AN ITEM MASTER ASKS whether to send it on.** Per the user.
  Loading a catalogue returns `storeOffer` (store id, name, SKU count) when a
  connected store carries that client, and the onboarding screen puts a yes/no
  in front of the operator. **The import itself pushes NOTHING** — sending a
  catalogue outward is a decision, and the right answer differs between a first
  onboarding and a correction to two rows. Saying yes posts `{client}` so only
  THAT client's catalogue goes, not every client the store happens to carry.
  GOTCHA: `zortStoresForClient` defaults to `requireStockSync: true` — that is
  the STOCK fan-out's rule, and using it here meant the offer never appeared
  for a store that wants products but not stock levels. Pass
  `{ requireStockSync: false }`.
- **THE PUSH IS AIMED BY CLIENT NAME, not by what the store is mapped to.**
  Reported from the floor: "clients like Betime, Mayer — how to push? I only see
  IDEALONEMAIN." Correct, and it was a real dead end. `push-products` scoped to
  `store.clientName` plus the channel mappings, which on a HUB account holding
  many fulfilment clients under one login is just the account label — and a 3PL
  client with no online shop of their own has **no channel to map**, so their
  catalogue could never reach the store at all.
  `GET /api/master/zort/catalogue-clients` lists every client that HAS an item
  master (name + SKU count, from `inventory.listClientIds()`), and 📦 Push
  Catalogue now opens a picker instead of assuming. Picking a name posts
  `{client}` — the route already supported it — and "Everything this store is
  mapped to" is still offered as the old behaviour.
  GOTCHA fixed by the browser test: the handler disabled the button, then
  `return`ed early when the operator backed out of the picker or the confirm,
  skipping the trailing re-enable — the button stayed dead until a page reload.
  It re-enables in a `finally`.
- **A PRODUCT NAME IS MANDATORY, and never faked from the SKU.** Found on a
  screenshot of a store's own product list: every row read `1730` / "1730",
  code and name identical. The cause was in OUR importer, not the push — the
  item-master upload ended `String(r.name ?? r.description ?? r.productname ??
  sku).trim() || sku`, so a blank Product Name silently became the SKU. From
  then on nothing could tell a real name from a placeholder, and the code
  appeared where a description belongs on pick lines, the client portal, the
  GRN and the store catalogue.
  Per the user the name is a must. A nameless row is now **refused and reported
  BY SKU** at three points: the upload response (`noName`, `noNameSkus`, said
  on the onboarding screen), the picker (`missingName` per client, before
  anything is sent), and the push itself (`skippedNoName`, plus a defensive
  `sync_product_no_name` skip in the outbox send branch). A count alone cannot
  be acted on; a list of codes can.
  `inventory.upsert` already required a name, so the old fallback was also the
  only reason the refusal was not already happening — it just happened as an
  anonymous exception counted under `skipped`.
- **CATALOGUE PUSH IS A REAL UPSERT, not add-only.** The API has SEPARATE
  `Product/AddProduct` and `Product/UpdateProduct?id=`, and Update needs the
  STORE'S OWN product id — which we do not hold, since we only know our SKU. So
  `zortProductId()` reads their catalogue back via `Product/GetProducts` (paged)
  and builds SKU → id, cached per store for 60s because one drain pass sends
  many products and would otherwise re-fetch the whole catalogue per SKU.
  Existing → Update, new → Add. Without this a second push would error or
  silently duplicate every product.
  - The cache is **dropped after a create**, so the next push sees the new id
    instead of trying to add the same SKU twice.
  - A catalogue we cannot read falls back to Add rather than skipping — no
    worse than the old behaviour, and it still gets a product across.
  - **SKU is not sent on an update**: it identifies the record, it is not a
    field to edit.
  Verified 9 checks against a mock that rejects a duplicate SKU the way a real
  catalogue does: the first push Adds both, a second push Updates and creates
  nothing, and a rename plus a cost change reach the store.
- **CARRIER LABELS FOR SYNCED ORDERS** (per-store `labelSync`, off by default).
  A synced order arrives with its tracking number but no label. When the toggle
  is on, `pullZortStore` enqueues a `kind: 'label'` outbox entry per order and
  `getShippingLabel()` fetches the PDF, which then goes through
  **`processLabelPdf` — the SAME pipeline a staff upload and a client
  submission use**, so it matches and attaches like every other label. One
  implementation; a second path would drift.
  - **QUEUED, NOT FETCHED INLINE.** The channel generates the label MINUTES
    after the order exists, so an inline fetch finds nothing on most of them.
  - **"Not generated yet" is a WAIT, not a failure**: `err.notReady` gets a
    flat `ZORT_LABEL_RETRY_MS` (60s) retry, does NOT count toward the
    20-attempt stall limit, and only after a full day of waiting is it flagged
    (`sync_label_never_arrived`). A channel that is slow must never read as
    broken.
  - **THE LABEL PATH IS CONFIGURABLE** (`store.labelPath`, default
    `Order/GetOrderLabel?id={id}`, `{id}`/`{tracking}` substituted). This is
    the ONE call in the client never confirmed against a live account — the
    sandbox cannot reach zortout.com. If the first production call 404s,
    correct it on the Connections screen; no redeploy, same escape hatch
    `store.endpoint` already gives the base URL.
  - A 200 carrying JSON rather than a PDF is treated as absent, not as a fault
    to retry forever (`%PDF` magic checked).
  - `POST /api/master/zort/outbox/drain` runs the queue on demand, for when
    someone is standing there waiting for a label.
  Verified against a mock store that refuses the label twice then serves a real
  29-page AWB: the order syncs with its tracking number and NO label, a label
  job is queued, it retries until the label exists (3 attempts, not one-and-give-up),
  and the PDF lands as a normal label import split into all 29 pages.
- Webhook/UpdateWebhook exists in the API — a future push-based
  alternative to polling, not yet used.

### The waybill has to be there WHEN THE PACKER OPENS THE ORDER (`/api/orders/:orderNumber/waybill-now`)

Every other path that gets a waybill is a BACKGROUND queue — the pull notices
it, the outbox retries every 30s with backoff. That is right for unattended
catch-up and wrong at the one moment it matters: a packer has just opened the
order and is about to put things in a box. Waiting out a retry cycle at the
bench is how a carton gets packed with no label on it, and the screen used to
say NOTHING — the waybill pill appeared when there was one and there was blank
space when there was not.

- **THE PILL IS ALWAYS THERE ON A SYNCED ORDER, AND THE PILL IS THE BUTTON.**
  Red **⚠ No waybill yet — tap to get it**, amber **`<number>` · ⚠ no label yet
  — tap**, or the number with a ✓ once the label is attached. An UPLOADED order
  is untouched: its waybill comes from the client's file or an uploaded label
  PDF and there is no channel to ask (said in those words if the route is
  called anyway, rather than left as a dead button).
- **ASKED AUTOMATICALLY THE MOMENT THE ORDER IS OPENED** — synced, no label, not
  yet done. Non-blocking and silent: it repaints the pill and reveals the ⇩
  Label button when it lands, and never interrupts a packer who did not ask.
  A TAP always reports what the channel said, in a dialog — a tooltip is
  unreadable on the phone the floor works from.
- **IT PACKS, AND IT NEVER READY-TO-SHIPS.** Lazada mints the tracking number at
  order creation but the AWB only becomes PRINTABLE once Pack is declared, so an
  order left Pending has a number and no label forever — Pack is the step that
  produces the label. RTS says the parcel is finished and ready for the courier,
  which is a lie told before a single piece has been picked; the test asserts
  ReadyToShip is never called on this path.
- **"NOW" HAS TO MEAN NOW.** Two things quietly made it a no-op: a label entry
  already waiting out its flat 60s retry is SKIPPED by the drainer as not due
  (so the tap did nothing for up to a minute), and `drainZortOutbox` holds a
  reentry guard for the 30s scheduler, so a single call lands as a silent no-op
  whenever it collides with one — which read as "the channel has no label" when
  the truth was "we never asked". The route makes the entry due, then drains
  until the entry has genuinely been attempted (its next-attempt time moves, or
  it succeeds and disappears), bounded at 8s so a wedged drain cannot hold the
  packer's screen.
- **A LABEL WE ASKED FOR BY ORDER IS NOT ORPHANED BY A MISREAD.**
  `processLabelPdf(..., { forOrder })`: we asked the hub for THAT order's label
  and it handed one back, so which order it belongs to is not a guess. A
  ONE-PAGE document is attached directly when the text match missed (OCR on a
  scanned AWB garbles a digit and the label would otherwise import and attach to
  nothing). A MULTI-PAGE document is never blind-attached — which page is whose
  IS a guess, and a guess puts the wrong label on a box; it is still imported so
  a human sorts it out on the Labels tab. Text matching stays the rule for bulk
  PDFs, where it is the only evidence there is.
- Any signed-in user, deliberately: a packer who cannot print a label must not
  have to find an admin. An 8s per-order cooldown keeps a double-open from
  asking the hub twice, and says so rather than pretending to work.
- Audited `sync_packed_on_demand`, `sync_waybill_backfilled` (`via:'waybill-now'`),
  `sync_label_attached_by_request`.

Verified 26 API checks against a hub that behaves like the live one (the order
arrives Pending with NO tracking and NO label; one call packs it, gets the
number and attaches the label; Pack was called and RTS never was; the label is
only served after the pack; a hub that refuses to pack relays its own reason and
invents nothing; a one-page label fetched for an order attaches, a six-page one
does not) plus 18 browser checks on desktop and a Pixel 5 (the warning pill is
red by computed style and fully on screen, the pill is the button, and opening
the order fills the waybill in and reveals the Label button with no reload).

### A 200 FROM PACK IS NOT A PACK (`sync_arrange_not_taking`)

Reported live from the Sync-activity dialog: **fourteen consecutive green
"✓ Asked the channel to PACK it at intake"** rows, six minutes apart, on an
order the hub still showed as Pending. Three defects, all in the same place:

1. **SUCCESS WAS CLAIMED WITHOUT VERIFICATION.** `sync_arranged_at_intake` was
   logged the instant `packOrder` RESOLVED, which asserts nothing about whether
   the hub moved. Exactly the lesson `zortBodyError` taught one level up — the
   call returning is not the outcome. The hub is now asked where the order
   stands **before and after**: still `pending` afterwards is not a success and
   is never recorded as one.
2. **NOTHING RECORDED WHAT THE HUB SAID.** Fourteen identical rows could not
   explain why the fifteenth would differ. `_zortSaid(resp)` puts the hub's own
   `resCode`/`resDesc` on the trail — only documented fields, so the record is
   never a guess.
3. **THERE WAS NO STOP CONDITION.** Success DROPS the outbox entry, so the next
   pull saw `pending` again and enqueued again, for ever. After
   `ZORT_ARRANGE_MAX_TRIES` (4) the order is stamped `state.arrange_blocked`
   and the pull skips it — a request repeated hourly with no effect is not a
   sync, it is noise burying the one line somebody needed to read.

- **The first failure to move is treated as LAG, not as a fault** — it retries
  on the normal backoff, and the before-read turns the retry into a no-op the
  moment it does land. Only a persistent non-mover is flagged.
- An order **already past Pending is never asked at all** (we packed it
  earlier, or the client did) — recorded as such, and tracking/label are still
  chased.
- The same read-back went into `/waybill-now`, which had the same overclaim in
  its own words ("Told the channel this order is Packed").
- **A FRESH IMPORT HAS NO STATE RECORD**, and those are exactly the orders this
  fires on — the flag write silently did nothing until the record was created
  lazily. Third time this trap has bitten; see also the no-stock sweep and
  `closeCollectionFromHub`.
- `ZORT_BACKOFF_MS` overrides the retry ladder flat, for tests only — the same
  escape hatch `ZORT_LABEL_RETRY_MS` already had, since a ladder measured in
  minutes cannot otherwise be exercised.

### ROOT CAUSE: `Order/PackOrder` DOES NOT EXIST IN THE v4 API

Found by reading the live docs (developers.zortout.com/api-reference/order via
the docs MCP, 2026-08-17). The Order page lists every POST it has — AddOrder,
UpdateOrderStatus, UpdateOrderPayment, VerifySlip, UpdatePartialOrder,
EditOrderInfo, EditOrder, VoidOrder, VoidOrderPayment, **ReadyToShip**,
BookOrderShipment, UpdateOrderSerialNo, UpdateOrderExpiry/Lot, … — and
**PackOrder appears nowhere on it.** It came from the old Postman collection.

That is the whole mystery: **ZORT's gateway answers 200 for a route it does not
implement**, so there was nothing to detect at the HTTP layer OR in the body,
and fourteen calls "succeeded" while changing nothing.

- **PACKED IS STATUS 5, SET THROUGH `Order/UpdateOrderStatus`** — the
  documented way, and the only one. `packOrder()` now posts that.
- **`shipment` is NOT a parameter of UpdateOrderStatus.** It belongs to
  ReadyToShip (where the docs mark it REQUIRED, and confirm the Lazada `"lex"`
  fallback verbatim). The arrange path no longer resolves or sends it.
- **CONSEQUENCE, STATED PLAINLY: this makes the status flip, and it does NOT
  produce an AWB.** UpdateOrderStatus is ZORT's own bookkeeping and never
  touches the marketplace. Only ReadyToShip "will try to update order in
  marketplace to Ready to ship", and only ReadyToShip returns
  `detail.trackingno` + `detail.link`. So the premise arrange-at-intake was
  built on — pack early, get the label early — **cannot work against the real
  API**; there is no marketplace pack step to call. Getting the label early
  would mean RTS'ing before anything is picked, which is the one thing this
  system must not do. That trade-off is the user's call, not a silent change.
- `Order/BookOrderShipment` mints a waybill without RTS but is explicitly
  **"Support only non-marketplace order"** and Thai carriers only — no use for
  a Lazada order.

Verified 20 API checks against a hub that answers Pack with a clean
`resCode 200 / Success` and leaves the order Pending: it is retried 4 times and
stops, NOT ONE attempt is recorded as green, the real outcome is on the trail
with the hub's status and its answer, the order is flagged, a later pull does
not restart it, an order the hub really does pack still succeeds in ONE call
and is never flagged, one already Packed is not asked at all, Ready-to-Ship is
never called, and the floor reads the failure in words on the order.

### Ready-to-Ship at intake — the user's trade-off, behind a switch they hold

Once `PackOrder` turned out not to exist, the choice became explicit and was put
to the user: Packed (UpdateOrderStatus 5) is ZORT's own bookkeeping and mints no
waybill, so **the only way to have a label before picking is to declare the
parcel Ready to Ship before anything is in the box**. The cost was stated
plainly; the user chose it, and asked for a way to suspend it. So:

- **`store.rtsAtIntake`, OFF unless deliberately turned on.** Never a default.
  Turning it ON is a confirm that spells out what it means; turning it OFF asks
  **nothing** — suspending has to be frictionless, that is the point of it.
- **RE-READ AT SEND TIME**, so switching it off stops entries already queued
  rather than only affecting future orders.
- **LAZADA ONLY.** RTS requires `shipment`, and Lazada is the one channel with a
  documented default (`"lex"`, per the doc verbatim). Shopee and TikTok want
  "pickup" or "dropoff" — a business choice this system must not guess, so their
  orders are never RTS'd here (asserted).
- **THE RTS RESPONSE IS THE WHOLE POINT**: `detail.trackingno` and
  `detail.link` come straight back, so the waybill is filled in and the label
  fetched from the link the hub just handed us — no polling for what we were
  already given.
- **AN ORDER ALREADY MARKED PACKED IS STILL OFFERED**, both by the pull
  (`stw === 'packed'` while the switch is on) and by the arrange branch's
  early-return. Without this, everything arranged while the switch was off would
  sit packed and label-less for ever, and turning the switch on would look like
  it did nothing. Caught by the test, not by reading.
- **COMPLETION DOES NOT ASK AGAIN.** With this on, every order reaches
  completion already `waiting`; the push now treats `waiting`/`shipping`/
  `success` as already satisfied instead of retrying a refusal until it stalls —
  which would otherwise have happened on every single order.
- Audited under its **own** event (`sync_rts_at_intake`), never as a pack: the
  trail must say what was actually declared to the marketplace. Flipping the
  switch is audited too (`zort_rts_at_intake_changed`, with who).

Verified 20 API checks against a hub that behaves like the docs (Packed mints
nothing; RTS returns the tracking number and the label link): off by default and
nothing declared, on and the Lazada order is RTS'd with `lex` and gets both
waybill and label before any picking, Shopee untouched, completion asks nothing
more and leaves no stalled entry, and suspending stops it — plus 20 browser
checks on desktop and a Pixel 5 (off by default, the cost written on the form,
cancelling the confirm leaves it off, and switching it off never asks).

### The waybill was in ZORT and blank here (`ZORT_WAYBILL_CHASE_DAYS`)

Reported from the floor. Lazada mints the tracking number MINUTES after the
order exists, so an order pulled promptly arrives with none, and the pull's
backfill is what fills it in later. Two things stopped that happening, and both
left the client's portal showing a blank waybill against an order ZORT plainly
had one for:

- **A DONE ORDER WAS REFUSED.** The backfill skipped `status === 'done'`,
  reasoning that its label had already printed — but that conflates *do not
  OVERWRITE a printed label* with *do not fill in a BLANK*. On a fast-moving
  account the order is picked, packed and completed before the channel gets
  round to the AWB, which is the normal case, not an edge one; those orders
  stayed blank for ever. A blank is now filled whatever the status, and never
  overwritten. The on-demand `/waybill-now` path already worked this way — the
  two now agree, which is what made the inconsistency findable.
- **AN ORDER THAT LEFT THE WINDOW WAS NEVER RE-READ.** The sweep only sees what
  `updatedafter` (lastPullAt − 1 day) returns, so a tracking number assigned
  after that — or assigned without the hub bumping the order's `updated` — could
  never reach the backfill. A catch-up now runs at the END of each pull:
  orders on this store with a `zort_id`, no waybill, not cancelled, from the
  last `ZORT_WAYBILL_CHASE_DAYS` (14), capped at 100, read in **ONE**
  `getOrdersByNumbers` call via the `numberlist` header.
  - **ONE CALL PER PULL whatever the backlog** — the account is metered at
    50,000/day and this is the cheapest possible shape. Asserted.
  - Bounded by days AND by count so it can never become a sweep of the whole
    back catalogue: a channel that has not issued a tracking number after two
    weeks is not going to.
  - A failure here is caught and logged, never allowed to take the pull down —
    the orders it chases are already imported and correct but for a blank.
  - Audited `sync_waybill_backfilled` with `via: 'chase'`, and the inline path
    records `afterCompletion` when it filled one that was already done.

Verified 14 API checks against a hub that assigns tracking LATE: orders import
with no waybill, one is picked and completed before the channel issues it and
still gets it, two that have fallen outside the `updatedafter` window are
chased by number in a single request, a pull makes at most one catch-up call, a
waybill already held is never rewritten, and the trail says which path filled
each. The pre-fix code fails 6 of those, so the suite reproduces the report
rather than agreeing with itself.

**AND THE TRACKING NUMBER WAS READ SIX DIFFERENT WAYS.** Looking again after a
second report, there were SIX ad-hoc extractions with six different key sets —
and the one that mattered most, the IMPORT itself, read only `o.trackingno`.
An order whose tracking the hub reports under any other spelling imported blank,
and which later path (if any) rescued it was luck. `zortTracking(obj)` is now
the ONE reader: every documented and observed spelling, plus one level into the
containers their responses use (`detail`/`order`/`data`/`shipment`/`shipping`/
`delivery`) — the hub's own screen shows it as **Shipping → Tracking No.**, so a
nested shape is not hypothetical. All ten call sites go through it.

**THE LIST ROW MAY NOT CARRY IT AT ALL.** The catch-up assumed the `numberlist`
list response includes the tracking number; that assumption is NOT verifiable
from here, and `/waybill-now` reads it from the order DETAIL, where it
demonstrably works. So anything the list cannot fill is now read properly from
the detail — **bounded at `ZORT_WAYBILL_DETAIL_MAX` (10) per pull**, because a
detail read is one call PER ORDER while the list read is one call for a hundred.

**AND A BLANK NOW EXPLAINS ITSELF**, which is what turned this into a support
question twice. Three outcomes are told apart and reported on the store row:
- filled (`sync_waybill_backfilled`, with `via` saying which path);
- **the channel has not issued one yet** — normal, wait. Audited
  `sync_waybill_unavailable` with the hub's status.
- **the hub does not answer to that number at all** — retrying cannot fix it,
  so it is named (`waybillNotOnHub`) and the row points at 🔍 Find order.
If the row DID carry a tracking-ish field we failed to read, the KEY NAMES are
recorded (names only — a value could be personal data and the audit log is
permanent and emailed). That is the evidence to close an unknown-shape bug with,
instead of a silent blank.

Verified 16 API checks (the list-only order filled from its detail, the ghost
order named on the row, one list call for six orders, at most one catch-up call
per pull) plus 6 browser checks on desktop and a Pixel 5. The two NEW cases fail
against the build that shipped the first pass, so they are real coverage rather
than a restatement.

TEST GOTCHA: `/api/master/zort/stores` answers with a BARE ARRAY — reading
`.stores` off it gives undefined and the assertion proves nothing. Second time
this shape has cost a run; `/api/portal/orders` did the same.

TEST GOTCHA: these orders persist in db.json, so a re-run finds them already
carrying the waybills the previous run fetched and "it imports with no waybill"
fails against good code — reset with the server STOPPED (`wb-run.sh`).

### The hub pushes; we make ONE targeted read (`/api/zort/webhook/:token`)

The polling pull is what spends the 50,000/day: every enabled store, every
cadence, whether or not anything changed. `Webhook/UpdateWebhook` lets the hub
tell us instead.

- **THE PUSH IS A TRIGGER, NEVER THE TRUTH.** It says "something happened, maybe
  on order X"; we then make ONE targeted read of that order and act on the
  authoritative answer, reusing the paths that already exist (void, tracking
  backfill, collection close, returned/failed). Two reasons: the payload shape
  and whether ZORT signs it are **not verified from here** (the sandbox cannot
  reach zortout.com), so trusting the body would be building on a guess — the
  same mistake `Order/PackOrder` was; and a push carrying state would still have
  to be reconciled against ours, while a read is the thing we know works. **A
  wrong guess about the payload costs a wasted read, not a wrong order.**
- `pullZortStore(db, store, {onlyNumbers})` does the targeted read via
  `getOrdersByNumbers` (the `numberlist` HEADER, exact match), **one page** —
  paging a single-order lookup would spend exactly what this saves. Measured:
  one push = one `GetOrders` call carrying `numberlist`, with no `updatedafter`.
- **AUTHENTICATION IS THE TOKEN IN THE PATH.** ZORT's push signing is
  undocumented on the page we can reach, so the URL is the secret: 32 hex
  characters, per store, **regenerated on every register** (which is the only
  revocation the design has) and **never read back** by the info endpoint.
  Holding it can make us re-read an order and nothing else.
- **ACK FIRST, ALWAYS** — GET and POST both `res.json({ok:true})` before any
  work. A receiver that makes the caller wait is how a hub decides we are down.
- **A PUSH STORM IS NOT A CALL STORM**: `ZORT_PUSH_DEBOUNCE_MS` (20s) per
  (store, order), in memory. Five more pushes on the same order inside the
  window cost nothing and are logged `debounced`.
- **A TARGETED READ MUST NOT MOVE THE WINDOW.** `lastPullAt` is what the next
  sweep looks back from, so a webhook advancing it would make the safety net
  quietly stop catching anything. It stamps `lastWebhookReadAt` and
  `lastWebhookResult` instead, and never overwrites the store row's summary
  with "fetched 1". Audited as `zort_webhook_read`, kept apart from `zort_pull`.
- **THE SWEEP IS NOT SWITCHED OFF.** A missed push must never mean a lost order;
  the cadence is the operator's setting and is deliberately left alone rather
  than quietly lowered.
- Everything is logged to `db.zortPushLog` (capped 200) and shown on the ⚡ Push
  dialog: an unknown token, a push with no recognisable order, a debounce, the
  read and its outcome. `DELETE .../webhook` revokes — registering without a way
  back is a one-way door, and there are real reasons to close it.
- UI: **📡 Push** on each store row — reports the live state and what has
  arrived, asks for the public https address on the way on (only the operator
  knows what this deployment is published as), and offers to stop on the way
  back.

- **HARDENING, because the receiver is PUBLIC** (self-review; CodeQL's count did
  not move and is not evidence either way on new code):
  - **Constant-time token compare** (`crypto.timingSafeEqual`), the same
    discipline the Lazada/Shopee push signatures already use. A 32-hex token is
    not realistically timing-attackable over HTTP, but the cost of doing it
    properly is nil and the cost of being wrong is a valid push URL. Length is
    compared first, so a correct PREFIX is rejected too.
  - **The debounce Map is BOUNDED** (`ZORT_PUSH_SEEN_CAP` 2000, expired entries
    swept first). Its key comes from an external caller, so a push carrying many
    distinct order refs would otherwise grow it without limit. Losing a debounce
    costs one extra read; growing for ever costs the process.
  - **AN UNAUTHENTICATED CALLER MUST NOT COST A DISK WRITE.** The first cut did
    `readDb()` + `_zortPushLog()` + `writeDb()` for EVERY hit, including one
    carrying a token nobody holds — so anyone who found the URL shape could
    drive a database write per request. Now: a per-IP ceiling
    (`ZORT_PUSH_IP_MAX`, 120/min) checked BEFORE any db work, and unknown tokens
    counted in memory and persisted at most once a minute WITH THE COUNT — the
    operator still learns "70 pushes on a dead URL from this address", which is
    the fact that matters, without 70 writes. Both maps are bounded.
  - **THE TOKEN NEVER GOES ON THE TRAIL.** `logAudit('zort_webhook_registered')`
    recorded the FULL push URL — secret included — and `db.auditLog` is never
    wiped, is archived indefinitely, and the nightly backup is gzipped **and
    emailed**. So the secret that authenticates every push would have travelled
    by email and sat on disk for ever. `_redactPushUrl()` keeps WHERE we
    registered (which is the useful part) and drops the key. The operator who
    asked for it is still shown it once, in the response.
  - **A FORGIVING PARSER on this path only**, mounted before the global one:
    `strict: false` plus a 256kb cap. The global parser 400s a bare string or
    `null` before the route ever sees it — and since ZORT's payload shape is NOT
    verified, refusing an unfamiliar one would take the channel down over a
    guess. **A receiver that argues with the caller is one the hub stops sending
    to.** A body that is not JSON at all still reaches the route empty, is
    logged `no_order`, and is acknowledged.

HONEST CAVEAT: the exact field names `Webhook/UpdateWebhook` wants are NOT
confirmed from here, so the common shapes (`url`, `orderUrl`, `webhookUrl`, …)
are sent together and whatever the hub reads it reads; if it refuses, its own
words come back to the screen. The receiver itself does not care — it is
triggered by any push on the token.

Verified 27 API checks (registration refused without https, a 32-char secret in
the URL, the token never read back, an unknown token logged not dropped, ONE
`GetOrders` per push carrying `numberlist` and no `updatedafter`, five more
pushes costing nothing, a push with no order logged, an order found under
`data.orderid`, `lastPullAt` unmoved and the store row unchanged, and revocation
killing the URL), 22 hardening checks on the public endpoint (a one-character
miss and a correct prefix both rejected; null, a bare string, an array, a nested
value and a 5kb string all acknowledged without taking the server down; 300
pushes with distinct refs leaving it healthy; both log caps holding; 40 pushes
on a dead token adding ONE row carrying `count: 70` rather than 40 rows; the
full URL appearing NOWHERE in stored data while the trail still reads
`webhook/••••••••`) plus a
separate 3-check run at a deliberately low ceiling — the ceiling and the
write-amplification guard hide each other from one address, so each is measured
with the other raised out of the way (`ZORT_PUSH_IP_MAX`,
`ZORT_PUSH_BADTOKEN_LOG_MS`, test-only escape hatches like `ZORT_BACKOFF_MS`) —
and 9 browser checks on the Push dialog.

### Telling the hub when WE cancel (`store.cancelSync`, `tellHubWeCancelled`)

Cancelling an order here left the hub believing it was still live — so the
client's own ZORT screen, and every channel report drawn from it, went on
counting work nobody was going to pick.

- **OFF BY DEFAULT, and never a default.** A void on the hub is DESTRUCTIVE and
  cannot be undone from this side. Turning it on is a confirm that says exactly
  that, and flipping the switch is audited (`zort_cancel_sync_changed`) with
  who did it. Asking on the way ON only — suspending stays frictionless, same
  as `rtsAtIntake`.
- `Order/VoidOrder` IS on the v4 docs page, unlike `PackOrder`. `voidOrder()`
  added to lib/zort.js.
- **A 200 IS NOT A VOID** — the same lesson Pack and Ready-to-Ship each taught.
  The drain branch reads the hub BEFORE and AFTER; anything short of `voided`
  afterwards throws, so the entry retries and the reason reaches the row.
- Never sent for: work **done** here, an order the **hub itself** voided (that
  is telling them what they just told us), an order with no matching `zort_id`,
  or one already pushed (`state.zort_void_pushed_at`).
- **NEVER VOIDS SOMETHING THAT HAS LEFT.** Between our cancelling and the drain,
  the hub may have shipped it — voiding then would erase a real shipment from
  their books. Refused, stamped `shipped-meanwhile`, audited
  `sync_void_refused_shipped` AND raised in **System Outages**, because it means
  a parcel is in the post that we have written off.
- **The cross-check settle deliberately does NOT tell them** — that tool exists
  because the hub already said the order was handled elsewhere, so voiding it
  would contradict what we just read.
- Hooked at the office bulk-cancel and the client's own portal withdrawal.

Verified 15 API checks against a hub that accepts voids and refuses shipped ones
(off by default and silent; the switch saving and auditing who; cancelling
queueing and the hub genuinely moving to Voided; recorded only after the
read-back; a second cancel not sending twice; a shipped parcel refused, reported
and raised as an outage; and a void the channel reported never echoed back).

TEST GOTCHAS, all three of which cost a run: a mock helper that used an empty
query value to PEEK was setting the status to `''`; the audit log is never wiped
so every assertion needs a `T0` scope; and db.json persistence is deferred, so
reading the file the instant a request returns can miss what it just wrote.

### The MARKETPLACE cancelled it and ZORT's own status never moved (`handleMarketplaceCancel`)

Proven live (170217257037005, read back with 🔍 Find order, 26 Aug 2026):
Lazada showed the order cancelled on the 23rd, the floor packed it on the 24th,
and ZORT's own status word read **"success"** throughout — the hub does NOT
void its own record for a marketplace-side cancellation, so `handleZortVoid`
(which watches ZORT's `status`) can never catch one. The cancellation lives
only in **`integrationStatus`**, the marketplace's side of the record.

- **TWO OUTCOMES, deliberately asymmetric in risk.** An UNTOUCHED pending
  order is auto-cancelled exactly the way a hub void is (`unprocessed`,
  `unprocessed_at` stamped, reason naming the marketplace and its own word,
  reservation released) — acting is cheap, and the alternative is packing a
  parcel no courier will take. TOUCHED work (scanned / done / picked up) is
  **NEVER regressed**: `state.platform_cancelled` {at, status, via,
  local_status, scanned} is stamped, a solid-red **"⚠ Platform cancelled — do
  not ship"** chip appears on the office row (tooltip points at ↺ Reclassify),
  and it is audited `sync_marketplace_cancel_conflict`. A wrong warning costs
  a glance; a wrong un-completion costs real stock movements.
- **An order ARRIVING already marketplace-cancelled is never imported** as
  floor work — counted in `skippedByStatus['marketplace-cancelled']`.
- **The match is deliberately loose** (`ZORT_MP_CANCEL_PAT` = `/\bcancel/i` —
  "Cancelled"/"canceled"/"In Cancel") because the channels' exact strings are
  not verifiable from the sandbox; the WORD SEEN is recorded on the trail, and
  a row with no integrationStatus leaves the guard dormant. NOTE `in_cancel`
  (buyer requested) currently matches too — same rule as the direct-webhook
  handlers; if that proves too eager on live data, narrow it there.
- Never re-stamps the same word (re-pulls are no-ops); the same lazy-state
  trap as every hub writer (a fresh import has no state record). Checked FIRST
  in the existing-order branch, so a cancelled order is not arranged / label-
  chased / collection-closed in the same pass. Counted on
  `lastResult.marketplaceCancelled` / `.marketplaceCancelConflicts`.
- **🔍 Find order now prints BOTH statuses** (`hub status "success",
  marketplace "canceled"`), so the next such report carries its own evidence.
- The cross-check tool already showed `integration_status`; unchanged.

Verified 20 API checks against a hub whose own status never moves (the
already-cancelled arrival never imports; the untouched order cancels itself
with the reason and day stamped; the COMPLETED one — hub reading "success",
the exact reported shape — stays done and is flagged with the hub's own word;
lowercase and camelCase field spellings both read; the control order with no
integrationStatus untouched; both audit events present once; a re-pull
re-stamps nothing and the trail does not grow; the lookup carries both words)
plus a browser check that the chip renders solid red with the reclassify
pointer in its tooltip.

### Auto-cancel runs TWO clocks — no stock 10 min, insufficient stock 90 min

Per the user (27 Aug 2026). `applyNoStockAutoCancel` (5-min sweep, API orders
of stock-tracked clients only, untouched work only, exempt-once-reopened):

- **NO stock** (`orderStockStateSrv` = `none`, nothing coverable on the whole
  order) → cancelled after **10 minutes** (`AUTOCANCEL_DEFAULT_MINS`, was 60).
- **INSUFFICIENT stock** (`partial` — some lines covered, some not) now
  cancels too, after **90 minutes** (`partialMinutes`), reason naming exactly
  what it was short of: "Insufficient stock — short of BCD (0 of 1) —
  cancelled automatically". Two clocks (`no_stock_since` /
  `short_stock_since`); a state change between them restarts on the other
  clock's FULL wait, never inheriting time. Both editable on the Connections
  ⏳ panel; a manual purge's minutes override applies to both; 🔒 Keep clears
  both.
- **THE PILL SAYS WHO** — the amber chip reads "⚠ Short of BCD" (SKUs named,
  not "Short 1 of 2") — **and REMAINS on the cancelled row**, per the user,
  rendered from `auto_cancelled.short` FROZEN at cancel time
  (`cancelledStockChip`): a live verdict would drift to "Stock OK" once the
  reservation released or stock arrived, and read as a cancellation with no
  cause.

Verified 18 API checks across three phases (defaults 10/90; first sweep only
arms with the right kind per order; at 11 min the no-stock order cancels while
both partials hold; at 91 min the partials cancel with the shortfall named,
including a quantity shortfall "AC-ABC (1 of 2)"; the covered order untouched
throughout) plus 8 browser checks (live pills naming the SKUs on all four
shapes, and the frozen pills still on the Cancelled rows with the
at-cancellation tooltip).

### The parcel came back, or never got away (`noteHubException`)

`returned` and `failed shipment` are in `ZORT_IMPORT_SKIP_STATUSES`, so they are
never imported as fresh floor work — but nothing acted on them for an order we
ALREADY hold. A parcel the courier brought back went on reading as **shipped**,
on our screens and on the client's. That is the one thing this system must not
do: report an outcome that did not happen.

`noteHubException` records it on `state.hub_exception` `{status, label, at,
noticed_at, via, hub_status, local_status, store_id}` and **changes nothing
else**:

- **A DONE ORDER STAYS DONE.** It really was picked and packed, and the pick was
  not wrong because the courier failed.
- **THE COLLECTION RECORD IS LEFT ALONE.** A returned parcel DID leave, so
  un-picking it up would be a second false statement. Same for the fulfilment
  KPI: it was handed over on time, and the return is a later, separate event.
- **NO STOCK MOVES.** What physically came back has to be counted, and that is
  what Inbound is for — inventing a receipt from a status word would put units
  on the shelf nobody has seen.
- **API-ONLY GATE** (`zort_id` must match) and the usual lazy state creation —
  a fresh import has no state record, and the write would otherwise silently do
  nothing. Fourth time that trap has come up.
- **NEVER RE-STAMPS the same status**, so a re-pull cannot move the record; a
  status that CHANGES (failed, then returned) updates and is audited again, and
  the earlier event stays on the trail rather than being rewritten.
- **"THE HUB SAYS IT CAME BACK AND WE NEVER SHIPPED IT" is a different problem**
  — either the parcel was never ours or somebody shipped it outside the system.
  Audited `neverShippedHere: true` and said on the chip in those words.
- Audited `sync_order_returned` / `sync_order_shipment_failed`, counted on the
  store row (`hubExceptionCount`, `hubExceptions[]`), and worded in the
  Sync-activity dialog.
- **THE CLIENT IS TOLD, in our words** — a red `.p-exc` pill on their order plus
  a line saying what happens next ("The parcel has come back to us. We will
  count it in and be in touch."). An order that came back reading as delivered
  is exactly what a client finds out about from their customer instead of us.

Verified 24 API checks against a hub whose parcels come back (both orders import
clean; one is genuinely picked and completed here; the return is recorded with
its own wording and both timestamps; the work, the collection and the stock are
all untouched; a re-pull does not re-stamp; an order we never shipped is flagged
as such on the trail; a change to failed-shipment updates the record and keeps
the earlier event; the store row carries the count; and a hub that changes its
mind back does not erase what it told us) plus 12 browser checks on desktop and
a Pixel 5 (the chip, its wording, its red by computed style, the tooltip, and
the never-shipped-here case).

### ZORT order status — words, the import filter, and the cross-check tool

CONFIRMED against developers.zortout.com/api-reference/order (read 2026-08-11
via the GitBook MCP the user connected; the raw docs domain is egress-blocked):

- **The GetOrders REQUEST filter uses numbers; the RESPONSE carries WORDS**
  ("Pending", "Voided", "Shipping"…). The original void check
  `Number(o.status) === 2` could NEVER match live data — it only ever passed
  because the mock used numeric statuses. `zortStatusWord()` normalizes both
  shapes; every status comparison must go through it.
- Lifecycle: **Pending(0) → Packed(5) → Waiting(3, = RTS'd) → Shipping(6) →
  Success(1)**; Voided(2) / Returned(4) / Failed Shipment(7) / "Partial
  Transfer" sit alongside. "Waiting" comes AFTER Packed — it means Ready to
  Ship was pressed, not "new work waiting".
- **A 200 IS NOT A SUCCESS — `zortBodyError` (lib/zort.js).** ZORT reports
  business refusals INSIDE a 200 body (`resCode` ≠ 200: "shipment channel
  required", order not packable, already RTS'd). `zortRequest` only checked
  the HTTP status, so a **failed RTS was recorded as done**: outbox entry
  dropped, order stamped `zort_pushed_at` → green "↗ Channel told", hub
  unchanged, no label, and nothing anywhere saying why. Reported live (Prem
  Kumar, 2026-08-14). Every response is now inspected: a `resCode`/`success`
  verdict that is not success THROWS, so the entry retries and the reason
  reaches the screen.
  - **A RESPONSE THAT CARRIES DATA HAS SUCCEEDED — do not narrow this.** ZORT
    attaches `resCode: 100, resDesc: "API Request Limits (50000 requests/day)"`
    to READ endpoints as a routine quota notice, riding alongside the orders on
    every GetOrders. Judging by the code alone declared every successful read a
    failure and **stopped the pull dead within minutes of shipping** (caught
    live). So: any body with a data key (`list`/`order`/`detail`/`data`/`count`…)
    is success, code 100 is never a failure, and the verdict only decides when
    the body carries nothing else — which is exactly the shape Pack /
    ReadyToShip / UpdateOrderStatus answer with.
  - **AND A 200 FROM READY-TO-SHIP IS NOT A READY-TO-SHIP.** Reported live: the
    trail showed a green "Told the channel the order is ready" and the CLIENT
    still had to press Ready to Ship by hand before the courier could scan the
    parcel. `zort_completion_pushed` was logged the instant `readyToShip`
    RESOLVED — the identical overclaim `sync_arrange_not_taking` was written for
    at intake, fixed there and left standing here. The hub is now READ BACK
    afterwards: anything short of `waiting`/`shipping`/`success` throws, so the
    entry keeps its place in the outbox, retries on the normal backoff and the
    reason reaches the row's chip. Audited `sync_rts_not_taking` with where the
    hub actually stopped and its own words.
  - **AN EMPTY REPLY IS NOT AN ORDER WITH NO STATUS.** Per the v4 docs
    `GetOrderDetail` returns the order at the TOP LEVEL (id / number / status /
    list), so a body carrying none of those is not an order we failed to parse —
    it is the hub not answering. Seen live: every read came back as nothing but
    `resCode 100 — "API Request Limits (50000 requests/day)"`, which
    `zortBodyError` deliberately treats as routine (it rides alongside the
    orders on every GetOrders, and judging by the code alone once stopped the
    pull dead), so nothing threw and the empty object read as "status
    unrecognised" — and the order was Packed and Ready-to-Shipped against a
    status nobody had seen. **The distinction is DATA, not the code**: 100 WITH
    an order is routine, 100 with nothing at all is a hub that told us nothing.
    Reported with the hub's own notice quoted, and raised as a **System Outage**
    — every order behind it is stuck the same way, so it is not one order's bad
    luck. `zortBodyError` itself is unchanged; narrowing it again would repeat
    the outage it caused.
  - **HOW MANY CALLS A DAY — counted, not estimated.** ZORT meters at **50,000
    requests/day** and, when it stops answering, says so in a notice carrying no
    order; "are we near it?" was unanswerable from anything we held.
    `zortApi.getCallStats()` counts every call at the ONE place they all go
    through, per SGT day and per endpoint, and `/api/master/connections/health`
    reports it with the top consumers named. Counting only — a meter that can
    refuse work is a second failure mode. It resets on restart, so it is a
    FLOOR, not a total, and says so.
  - **THE METER READ 3 OF 50,000 AND THAT NUMBER WAS NOT TRUSTWORTHY.** The two
    label endpoints go out through a RAW fetch — they answer with PDF bytes, not
    JSON — so they never passed through `zortRequest` and were never counted,
    and the label wait loop was the single biggest consumer we had. Both are
    counted now. Any usage figure taken before that fix understates it, possibly
    by a lot.
  - **THE PROBE SAID EVERY ENDPOINT ANSWERS WITH THE SAME EMPTY ENVELOPE** —
    `{resCode:"100", resDesc:"API Request Limits (50000 requests/day)",
    detail:null}` — for `Merchant/GetMerchantProfile` and `Order/GetOrders`
    alike, so the list read fails too and there is no order to test the detail
    read with. That is not a per-order fault: **the account is refused at the
    gate**, and nothing on this side changes it. It is a question for ZORT about
    the account's daily usage and whether the key is throttled or suspended.
  - **🧪 Probe's FIFTH question: "is there actually a label?"** Asked repeatedly
    and previously answerable only with a Postman session. It calls
    `GetShipmentLabels` for the id the hub just returned and prints the raw
    reply WITH a verdict, because the two facts people conflate are "the call
    succeeded" and "there is a label". On Lazada the AWB is minted at
    Ready-to-Ship, so an order still Pending correctly returns an EMPTY list —
    that is not a fault and nothing here can produce one. Rows in Pdf/Url are
    ours to import (if the order has none, that IS our bug); any other Format is
    named and sent to the channel to print. Deliberately NOT routed through the
    probe's generic data check: an empty label list is a complete, correct
    answer, and the heuristic would mark it ✗ and say nothing useful.
  - **THE CONNECTIONS PAGE IS FIVE COLLAPSIBLE SECTIONS** (`.conn-sec`, native
    `<details>`). Reported as simply too long to work with — and most of it is
    set up once and never touched, so only **Channel Connections** (the store
    table) opens by default. Each summary carries a one-line purpose so a closed
    section is not a mystery. Which sections a person leaves open is a habit,
    not a setting, so it lives in `localStorage`, per browser. Measured: 1,050px
    collapsed vs 2,428px expanded on desktop, 1,345 vs 4,291 on a phone.
  - **🧪 Probe** (`POST /api/master/zort/stores/:id/probe`, admin or master,
    read-only, FOUR calls) asks the hub four questions and prints its raw
    answers: ValidateApi → GetMerchantProfile → GetOrders(limit 1) →
    **GetOrderDetail using the id the hub itself just returned**. That last pair
    is decisive: a hub that LISTS an order with id X and then returns nothing for
    that same X one call later is failing on its own side (most likely the key
    is not permitted to read order detail), and those two answers are the
    evidence to send them. If both work, the ids WE hold for the affected orders
    are the next thing to check. Credentials are never echoed back.
    **A REPLY THAT CARRIES NO DATA IS NOT A SUCCESSFUL READ** — the first cut
    ticked every step that did not throw, so GetOrders showed ✓ while answering
    with nothing. That is the same overclaim this whole thread is about, made by
    the tool built to diagnose it. A bare success CODE still counts for
    ValidateApi, which has no payload to give; the quota-notice envelope never
    counts, whichever endpoint returns it.
  - **AND IT WAS AIMED AT THE WRONG ENDPOINT.** The hub's own activity log
    (369,278 requests in 14 days, against a 50,000/day limit) is almost entirely
    label calls — and shows `Order/GetShipmentLabels` succeeding while every
    `Order/GetShipmentLabelFile` beside it answers `resCode 100 "Invalid ID."`
    or a 500 timeout. **`GetShipmentLabelFile` is not on the v4 docs page at
    all** — the same trap as `Order/PackOrder`, and from the same old Postman
    collection. We were trying it FIRST, so every label attempt cost two calls
    and the first could never work. The documented list endpoint now goes first;
    the undocumented one is a fallback, and a store that has refused it three
    times (`store.labelFileFails`) is never asked again — it is undocumented, so
    a store where it does not work is one where it never will. The counter is on
    the store record, so a restart does not relearn it by burning more calls.
  - **AND "GetShipmentLabels SUCCESS" IS NOT "WE GOT A LABEL".** Reported from
    the floor with the hub's log open: the documented call succeeds and no label
    appears here. `fetchLabelPdf` returned a bare `null` for every outcome, and
    the caller reported all of them as *"not generated yet"* — so a hub that
    HANDED US something we cannot import was waited on for ever, one request
    every few minutes. `Format` is documented as **Pdf, Html or Url** and there
    is no server-side way to render HTML (playwright is a DEV dependency only).
    So the two are now separated: an EMPTY list is a genuine wait and keeps the
    flat ladder; rows we could not turn into a PDF are a real fault that names
    what the channel offered (`sync_label_unusable`, "print it from the channel
    for now") and stalls instead of retrying for a day.
  - **WAITING FOR A LABEL WAS THE BIGGEST CONSUMER.** A flat 60s retry for up to
    a day is **1,440 calls per unlabelled order** — and on a morning when
    nothing reaches Ready-to-Ship, every one of those orders is waiting for a
    label that cannot exist yet. `ZORT_LABEL_WAIT_LADDER_MS` grows the wait
    (1m ×3, 2m, 5m, 10m, 15m, then 30m): **54 calls for the same 24 hours**,
    with the first minutes still quick because the common case really is a label
    appearing shortly after the order. The stall limit is now measured in
    ELAPSED time (`waitedMs`), since attempts and hours are no longer the same
    thing.
  - **WHEN THE HUB ANSWERS NOTHING, STOP ASKING** (`zortHubWentQuiet`,
    `ZORT_HUB_QUIET_MS` 5 min). Every call made while it returns the
    request-limit notice cannot succeed AND spends the limit that is blocking
    us, so the retries slow the recovery down. The store goes quiet and its
    entries are **HELD, not failed** — no attempt counted, nothing stalled,
    because the hub being down is not the order's fault. In memory on purpose: a
    live condition, not a setting, and a restart should re-test rather than
    inherit a pause. Shown on the health panel in words.
  - **ONE PASS NEVER SENDS MORE THAN `ZORT_DRAIN_MAX_PER_PASS` (25).** A backlog
    all coming due at once would otherwise fire hundreds of calls in one tick;
    the rest wait 30 seconds for the next pass, which nothing depends on.
  - **ONE READ, NOT TWO.** The arrange path fetched the same order detail twice
    per attempt (status, then shipment channel). `zortHubState` carries the
    channel fields and `zortShipmentFrom(state)` derives them, which halves the
    requests on the hot path — and when the hub is metering us, every retry we
    do not make is one the real work can have.
  - **A STATUS WE COULD NOT READ IS NOT AGREEMENT.** `zortHubStatus` returned
    `''` for both "no status we recognise" and "the read failed", and callers
    treated that blank as PENDING — which is how an order was Packed and
    Ready-to-Shipped against a status nobody had seen (the live trail literally
    read `hub was "unknown"`). `zortHubState` returns `{read, status,
    integration}`; an unreadable hub is reported as such and retried, never
    recorded as a success.
  - **ZORT'S STATUS AND THE MARKETPLACE'S ARE TWO FACTS**, so the order detail's
    `integrationStatus` is recorded alongside on the success entry. It is never
    conflated with ZORT's own word — that confusion once produced a false
    "the client RTS'd before packing" alarm.
  - **RTS IS ONLY LEGAL FROM PACKED** (Pending → Packed → Waiting). Asking a
    still-`pending` order to go ready-to-ship is refused, which is what happened
    to every order completed before arrange-at-intake began packing them. The
    completion push now reads the hub status first and Packs before RTS when
    needed (`zortHubStatus`); an "already packed" refusal on that Pack is not an
    error — it is the state we wanted.
  - **The re-push REPORTS WHAT THE HUB SAID, in a dialog.** It drains
    synchronously and returns `{sent, error}` — a tooltip is unreadable on a
    phone, which is where the floor works.
  - The refusal reason travels while **queued**, not only once stalled — the
    chip reads **⚠ Channel refused** with the hub's own words.
  - **`POST /api/master/zort/orders/:orderNumber/repush`** (admin or master)
    clears the stale stamp, requeues the completion push and drains at once.
    The push chip is CLICKABLE for exactly this — a green chip is a claim
    about the hub, so when the hub disagrees the floor can say "tell them
    again" from the row. (The row's other **Resend** button is the completion
    ALERT EMAIL — unrelated, and mistaken for this more than once.)
- **THE ZORT SCREEN's "Waiting for the transfer" IS NOT API STATUS `waiting`.**
  Verified live (2026-08-14, 🔍 Find order on 171347763939855): the Sale Items
  screen showed "Waiting for the transfer" while the API returned `pending` —
  the screen label describes the MARKETPLACE side (Lazada "To Arrange
  Shipment", waiting on the seller), not ZORT's own order status. Reading it
  as RTS'd produced a false "client RTS'd before packing" alarm once. Judge
  status ONLY from the API word (the lookup tool / cross-check show it).
- **Import filter** (`ZORT_IMPORT_SKIP_STATUSES` = success, shipping, returned,
  failed shipment): new orders in these states are never imported as floor
  work — the first pull's 7-day reachback once dragged in ~dozens of orders the
  client had fulfilled themselves, which sat as phantom pending backlog.
  Counted per status in `lastResult.skippedByStatus` + sampled in
  `skippedHandledSample`, shown as a blue "⤳ not imported (already handled)"
  line on the store row. **"waiting" is deliberately still imported** — during
  the handover period a client may RTS work meant for us; the cross-check tool
  is where that ambiguity is resolved by a human.
- **RECORD-ONLY CLIENTS** (`store.recordOnlyClients`, blue box on the store
  form next to `skipClients`): per the user, a client who fulfils from their
  own end may still need the record — *"the customer still needs to maintain a
  list of unable to be fulfilled orders"*. Their orders ARE imported (which is
  also what makes the dedup hold, so they can never re-import) but arrive
  already `unprocessed` with reason "Client fulfils from their end
  (record-only import)" — the SAME state shape as ⌫ Not ours, so display,
  reports and the portal treat both identically. Skipped for them: stock
  reservation, the label outbox, arrange-at-intake, and the New Work poke.
  `skipClients` remains the harder switch for clients who need NO record here.
  Both are matched on SKU attribution, after `clientForOrder` resolves.
- **🔍 Find order** (store-row button; `POST .../stores/:id/lookup`, read-only)
  answers "ZORT shows it and IdealOne never got it".
  - **IT SEARCHES TWICE BEFORE SAYING ANYTHING FINAL.** `numberlist` is an EXACT
    match on ZORT's OWN order number, and the number people read off the hub's
    screen is often the MARKETPLACE's order id, or sits in `reference` /
    `uniquenumber` / the tracking number. One exact-match miss was being
    reported as "the hub API does NOT return this order — it can never sync",
    which blamed the hub for a search we only tried one way. Reported live on a
    real order. `findOrderAnywhere` now pages the hub's own recent list (45 days,
    12 pages) and matches every identifier an order carries, handing back **the
    hub's own number** to act on.
  - **A LOOSE MATCH IS WORSE THAN NO MATCH.** The first cut also tried
    `want.includes(v)`, which let ZORT's numeric id `1` match the needle
    `169982235496068` and point at an unrelated order — in a warehouse, the
    wrong order picked. Now: exact on any field, or a one-directional contained
    match with a 6-character floor (`MIN_PARTIAL`). Caught by the test, not by
    reading.
  - **A SEARCH THAT RETURNED NOTHING IS NOT A FINDING.** Reported live: the
    wider pass said "45 days, 0 order(s)" — it had scanned nothing at all, on a
    store that pulls orders daily, so a long `updatedafter` window is the
    suspect (the daily pull uses ~1 day and works). It now tries the **plain
    paged list first, with no date filter**, then the window, and NAMES the
    shape that produced rows. When every shape comes back empty it says the
    search *could not look* — never "we looked and it is not there", which is a
    claim the search cannot support.
  - When it genuinely finds nothing it says **how far it looked** (days, orders
    scanned, whether it stopped early) and what to do now — key the order in as
    an upload to serve the client today, then ask ZORT why their API withholds
    it. "Not our problem" is not an answer when the client is waiting.
  - It applies **the same rules the pull uses** — status, the two skip lists, and the client the SKUs
  attribute to — because a tool that reports "would import" about an order that
  never can explains nothing, which is exactly the moment somebody reaches for
  it. It names the client it files to and how it was attributed, since the skip
  lists are keyed on that and it is usually the answer. Also distinguishes an
  order the API does not return at all (a question for ZORT, not for us) and one
  the hub returns with no product lines.
- **🔎 Cross-check** (store-row button; `POST /api/master/zort/stores/:id/
  cross-check`, read-only): asks the hub the current status of every open
  synced order here (GetOrders `numberlist` HEADER, 100 per call — a header,
  not a query param) and verdicts each: fulfilled-elsewhere / rts-elsewhere /
  voided / active / not-found, with the marketplace's own `integrationStatus`
  alongside. `POST .../settle {orders[]}` then marks the listed ones
  `unprocessed` ("Fulfilled outside IdealOne (ZORT cross-check)") — GUARDS:
  zero-scan orders only (anything the floor touched is refused BY NAME), done
  orders never touched, reservations released via the standing reconciler.
  Audited `zort_cross_check` / `sync_orders_settled_crosscheck`.
- **Pack/ReadyToShip `shipment` is REQUIRED for RTS** per the docs, and the
  order detail's `shippingchannel` is THE field (NOT `shippingname` — that is
  the recipient's name). Lazada fallback when blank, per the doc verbatim:
  `"lex"`. Shopee/TikTok want "pickup"/"dropoff" — a business choice, never
  guessed, left blank. `zortShipmentChannel()` implements this; the outbox
  drainer resolves it once per entry and caches it across retries.
- The RTS response returns `detail.trackingno` AND `detail.link` (label URL) —
  a future shortcut past the tracking/label polling. PackOrder is in the
  Postman collection but NOT on the docs site; its params mirror RTS.

## Client Portal — read-only self-service for 3PL clients (/portal)

`public/portal.html` + `portal.js`, served at `GET /portal`. Same architecture
as the Driver App: its OWN login (`POST /api/portal/login` {client, password})
against tenant-scoped records (portal credentials live on the client's
onboarding profile: `clientProfiles[].portal = {enabled, email, salt,
passwordHash}`), sessions namespaced `portal:<tenantId>:<client>` in the SAME
activeSessions map, and `requirePortalAuthMiddleware` re-establishing the right
tenant context per request. `/api/portal/` prefix is exempt from the global
requireAuth (like `/api/driver/`).

- STRICTLY read-only; every endpoint scoped to the logged-in client:
  `/api/portal/overview` (stock stats, open/done orders, inbound, quarantine),
  `/stock`, `/orders`, `/inbound`, `/grn/:id` (ownership-checked 404 for any
  other client's receipt).
- SECURITY — privilege-bleed guard: `requireAuth` SKIPS sessions whose key
  starts with `driver:` or `portal:` — a portal/driver token must NEVER unlock
  staff APIs (this was a real pre-existing hole for driver tokens, found and
  fixed when the portal's isolation test caught it). Never remove that skip.
- Admin management: Administrator → 🎉 Onboard Client → "🌐 Client Portal
  access" (enable, client email, set password — blank keeps current, min 6
  chars). Credentials are MASKED in `GET /api/master/client-profiles`
  (enabled/email/hasPassword only). Client name at login is case-insensitive.
- GRN emails: `sendInboundGrnAlert` also sends to the profile's portal email
  when set, so clients receive their proof-of-receipt directly.

### Portal presentation pass — real branding, dashboard, exports

The portal was originally 244 lines total and rendered as eight zero-tiles
above a screenful of blank white. It is the CLIENT-facing face of the
business, so it was rebuilt as a proper dashboard.

- **REAL BRAND ARTWORK, not a drawn substitute.** `public/icons/idealone-logo.png`
  (full lockup) and `idealone-mark.png` (barcode-in-scan-brackets icon) are
  extracted from the supplied artwork by `_mklogo` (scratch script; assets are
  committed, the script is not). The source PNG's "transparency" is a
  near-white (~247) checkerboard baked in as real pixels, so every pixel
  ≥228 on all channels is forced to PURE white — otherwise a faint grey box
  shows against the white card. Consequence: **the logo only ever sits on
  white surfaces** (login card, header bar, printed receipt note). Do not
  place it on the dark login background or any coloured panel.
  `portal-icon-192/512.png` are the installable-app icons (mark on white).
  Login shows the lockup + "Client Portal"; the header shows the mark +
  IDEALONE / CLIENT PORTAL, with the signed-in client as a chip that is
  hidden under 480px (the hero already names them in full there).
  An earlier hand-drawn SVG mark was removed. Worth remembering why it
  broke: **a `<linearGradient>` declared inside a `<symbol>` in a
  `display:none` `<svg>` does not resolve when instantiated via `<use>` in
  Chromium** — the square painted as nothing, leaving white shapes
  invisible on white. If a `<symbol>` is ever added here, solid fills only.
- **Overview is a dashboard**: time-aware greeting + a plain-English summary
  sentence that still reads correctly when every number is zero; 4 KPI tiles
  with sub-context; a "Needs attention" block (out-of-stock, low stock,
  receiving discrepancies, quarantine) that collapses to a single "All
  clear" line when there is nothing wrong; a 14-day shipping chart; last-30-day
  figures; a "replenish soon" list; and a recent-activity feed.
- **NO FABRICATED METRICS.** There is no promised/committed delivery date
  anywhere in this system, so the portal deliberately shows no on-time or
  SLA percentage. Same discipline as the driver Time/Avg-Speed tiles that
  were removed rather than faked. Only add such a figure if a real
  promised-date field is captured first.
- **Chart: bars in SVG, every label in HTML.** `trendChart()` draws with
  `preserveAspectRatio="none"` so bars stretch to the card width — that
  stretch also distorts SVG *text* (a label rendered several times its
  intended width and ran off the page). Day labels and the legend are HTML
  siblings. When the whole 14-day window is empty the chart is replaced by
  one compact line instead of a tall empty box.
- **Stock meter honesty**: the per-SKU bar plots available ÷ on-hand, which
  is 100% whenever nothing is reserved — so a nearly-empty SKU showed a
  FULL bar reading as healthy. The meter now renders only when
  `reserved > 0`; stock health is carried by the coloured number and the
  In stock / Low · min N / Out of stock pill.
- New endpoints: `/api/portal/order/:orderNumber` (line detail behind an
  expandable Orders row — ownership-checked 404) and
  `/api/portal/export/:kind` (`stock|orders|inbound` → XLSX, downloaded via
  fetch+blob because an `<a href>` cannot send the session-token header).
  `PORTAL_STATUS_LABEL` is shared by the screens and the export so wording
  can never diverge; exports use client-facing language ("Inbound shipment",
  "Held") not floor shorthand ("po", "KIV").
- Installable: `public/portal-manifest.json` (own `start_url`/`scope`
  `/portal`), same reasoning as `driver-manifest.json` — sharing the office
  manifest would put the office app on a client's home screen.
- Verified with real Playwright runs at Pixel-5 and 1280px: a populated
  account (43 checks), a brand-new EMPTY account (the state the real client
  was in — every empty state is written copy, no blank voids), XLSX contents
  parsed back with the `xlsx` lib, and cross-client isolation (another
  client's token sees 0 rows, gets 404 on a foreign order/GRN, and 401 on
  staff APIs). Also asserted: all 4 nav tabs fully on-screen at 393px, no
  horizontal overflow, and NO third-party/other-branch names anywhere in the
  rendered DOM.

### EVERYTHING a client sends waits for us — inbound as well as outbound

Per the user: *"whatever the client uploads at its end — inbound/outbound. office
will receive it duly after its approval then will process. its status will be
transferred back to client via portal."*

Outbound already worked that way. **A client ASN did NOT** — `POST
/api/portal/asn` created a LIVE `db.inbound[]` receiving job the moment the
client pressed send, which made an inbound submission the one thing that reached
the warehouse floor without anyone here agreeing to it. It now creates a
`clientSubs` record of `kind: 'inbound'` and waits in the SAME approval queue as
their orders.

- **`buildAsnLines(buffer, filename, client)`** is used BOTH at submission (to
  validate and preview) and at approval (to create the job) — one
  implementation, so what the office approves is exactly what gets created.
- An ASN has no second step (no waybills to attach), so sending it IS
  transmitting it: `transmitted_at` is stamped at submission and the approval
  clock starts there.
- **The SLA clock runs from the CLIENT'S submission, not our approval.**
  `asn_submitted_at` is carried onto the receiving job from the submission —
  our own delay in approving must never quietly buy us time on their promise.
- **The client can see where it is.** `/api/portal/inbound` prepends their
  pending and rejected ASNs ("Waiting for us to accept" / "Not accepted" with
  the reason). Without this a shipment simply vanished between pressing send
  and someone here approving it.
- A REJECTED ASN never reaches the floor, and the rejection reason is relayed.
- The office queue and its detail screen read it as an inbound shipment — 📥
  icon, "inbound shipment · N line(s) · Q pcs", and a preview of the expected
  lines rather than an empty orders table.

Verified 21 API checks (nothing on the floor before approval, the client sees
"waiting", the office sees it as inbound, approving creates the receipt with
their reference and name, the waiting row is replaced by the real receipt,
rejection reaches them with the reason and creates nothing) plus 7 browser
checks on the office approval screen.

### Client-submitted ASNs, the "New Work In" poke, inbound SLA, aging stock

Four connected features that make the portal two-way. NOTE: the portal is
otherwise strictly read-only — these add exactly TWO client writes, both
narrow: submitting an ASN, and setting their own aging threshold.

- **ASN template + upload.** `GET /api/portal/asn-template` builds an XLSX
  whose headers are EXACTLY the ones `parseInboundFile()` recognises
  (`ASN_TEMPLATE_HEADERS` — SKU / Description / Expected Qty / Batch No /
  Expiry Date) plus an Instructions sheet. Change one and you must change
  the other, or the file we hand out stops parsing when it comes back.
  `POST /api/portal/asn` (multipart) reuses `parseInboundFile` + the same
  same-SKU merge as the office upload path, then creates a normal
  `db.inbound[]` record — `type:'po'`, `status:'pending'`,
  `submitted_by_client:true`, `uploaded_by:'portal:<client>'`. It moves no
  stock; the floor still receives it through the existing flow. An
  unparseable file is refused loudly (never a silent empty job).
  `requirePortalAuthMiddleware` is invoked INSIDE the handler, after multer,
  for the usual reason (multer does not carry the AsyncLocalStorage tenant
  context, and this route sits outside the global auth middleware).
- **Pokes — `db.pokes[]`, `GET /api/pokes`, `POST /api/pokes/ack`.** "New
  work has arrived from outside." Written by `addPoke()` on a client ASN and
  by `addOutboundPoke()` at all THREE batch-creation sites (file upload,
  photo scan, store sync). Each carries client, direction, B2B/B2C
  (`clientChannel()`, from the onboarding profile — blank when unknown
  rather than guessed), line/piece counts and the SLA due day. Capped at
  `POKE_CAP` — this is a notification feed, `db.auditLog` remains the
  permanent record. UI: 🔔 New Work button in the office sidebar with an
  unread badge, `#pokeOverlay` list, tap a row to jump to Orders/Inbound.
  GOTCHA fixed: `initPokes()` runs at script-parse time, before login, so a
  plain `setInterval` left the badge blank for a full minute after signing
  in — it now polls every 2s until a token exists, then settles to 60s.
- **Inbound SLA — D+2 WORKING days from ARRIVAL, not submission**
  (`INBOUND_SLA_WORKING_DAYS`, `addWorkingDays`, `workingDaysBetween`,
  `inboundSlaBasis`, `inboundSla`). Per the user: *"expected inbound date + 2
  working days is the SLA, subject to arrival date of actual inbound."*
  `inboundSlaBasis()` picks what the clock runs from, in order:
  1. **actual arrival** (`arrived_at`) when it is LATER than expected — we
     cannot receive what has not turned up, so a late shipment moves the
     promise with it;
  2. **expected arrival** (`eta` on the ASN) — the normal case;
  3. **submission date**, only when neither is known (nothing better exists,
     and it is the tightest option so it never flatters us).
  The asymmetry in (1) is deliberate: actual arrival can only push the due day
  LATER. Goods arriving early do not shorten the promise, and our own slowness
  starting a receipt can never excuse a miss, because `arrived_at` records when
  the goods landed — set explicitly via `POST /api/inbound/:id/arrival` (which
  can also correct the ETA), NEVER inferred from when we began scanning.
  The due day is DERIVED, not stamped, so giving or correcting an ETA moves the
  target honestly instead of leaving a stale date behind. `sla.basis` is
  returned so both the portal and the office can say what the clock ran from,
  and `sla.notYetDue` suppresses "overdue" before the goods are even expected. Pills, per the user's spec:
  **GREEN = met, BLUE = missed** (not red — deliberate). While open the pill
  shows the due date instead of a verdict; there is nothing to judge yet.
  `inboundSla()` returns null when there is no `asn_submitted_at` (office-
  keyed or pre-feature records) — an SLA can't be judged against a clock
  that never started. Exposed to the client AND on the office
  `/api/inbound` list so the floor sees what's due. **No public-holiday
  calendar exists**, so a SG public holiday counts as a working day here:
  the promise is measured slightly tighter than reality, and adding a
  holiday list later only ever moves due dates later.
- **Aging stock.** `inventory.lastMovementBySku(clientId)` — ONE grouped
  query over `stock_movements`, deliberately EXCLUDING `reserve`/`release`
  (allocating stock to an order and releasing it moves no physical piece, so
  counting them would reset the aging clock on stock that never left the
  shelf). Threshold defaults to `PORTAL_AGING_DAYS_DEFAULT` = 15 calendar
  days and each client can set their own (`clientProfiles[].aging_days`, via
  `POST /api/portal/settings`, clamped 1–365). Yellow pill + "Aging" filter
  on Stock, an alert and a "Not moving" list on Overview, and columns in the
  stock export. A SKU with **zero** stock is never flagged — that is
  discontinued, not stagnant. The `inventory` table has a `last_moved_at`
  column but NOTHING writes it; `stock_movements` is the real source.
  Never-moved SKUs measure from `first_added_at` so a brand-new item is not
  instantly branded aging.
- **90 days on screen, 365 days by report.** `PORTAL_SCREEN_DAYS` /
  `PORTAL_EXPORT_MAX_DAYS`, both enforced server-side. Anything still OPEN
  bypasses the 90-day cut — a job we haven't finished must never fall off
  the client's screen. `/api/portal/export/:kind` takes `from`/`to` and
  REFUSES a wider span rather than silently clipping it (a partial file the
  client believes is complete is worse than an error). Stock is a live
  position so it ignores the range. The inbound report carries Submitted /
  SLA due / SLA / SLA detail columns.

Verified end to end against a running server plus real browser runs: the
template round-trips (download → fill → upload → parses), duplicate SKUs
merge, junk is refused, the office is poked with the right client/channel/
workload, the job sits pending with the same due day on both sides,
receiving it yields a green met pill, a backdated one yields a blue missed
pill, aging flags a 40-day and a 20-day idle SKU but not a 5-day one and
follows the threshold when changed, and the 365-day report limit is enforced
on both sides. Pill colours asserted by computed style, not by class name.

### Portal accounts — up to five per client, full or view-only, one place at a time

Per the user: an onboarded client gets **up to 5 logins**; each is either **Full
access** (send orders/waybills/ASNs, cancel their own unprocessed work, read
everything) or **View only** (read and download, send nothing in); the same
account may not be signed in from two places; and every account sees all the
status we hold on that client's orders.

- `clientProfiles[].portalUsers[]` = `{id, name, email, salt, passwordHash,
  access:'full'|'view', enabled, created_at, last_login_at}`, capped at
  `PORTAL_MAX_USERS = 5` **server-side** — the UI hiding the form is a courtesy,
  not the rule.
- **DELIBERATELY TWO LEVELS, not a permission matrix.** A matrix invites
  half-configured accounts nobody can reason about; the user asked for a toggle.
- **The original single credential is MIGRATED, not replaced.** `portalUsers()`
  folds `profile.portal` into the list on first touch keeping the SAME salt and
  hash, so a client's existing password still works — renaming the storage must
  never be a silent password reset. It becomes `id:'main'`, access `full`.
- **Access is what you may DO, never what you may SEE.** Both levels read the
  identical client-scoped payload; asserted by comparing the two responses
  byte-for-byte. Writes go through `requirePortalWrite` (403 + `viewOnly:true`):
  submit-orders, preview-orders, submit-labels, transmit, discard, remove
  labels, ASN, portal delete, aging settings.
- **Access is re-read on EVERY request**, so downgrading or switching an account
  off bites on their next action rather than at their next login — and a
  disabled account's session is deleted the moment it is saved.
- **ONE PLACE AT A TIME** (`livePortalSession`): a second login for the same
  account is **refused** (409 `inUse`) rather than silently kicking the first
  device off — nobody loses a half-finished upload without being told. Released
  automatically after `PORTAL_SESSION_IDLE_MIN` (15) idle minutes so a closed
  browser can never lock a client out of their own account, and the office can
  free it at once from the onboarding screen.
  - **UNLESS THE LOGIN IS GRANTED MULTI-DEVICE** (`portalUsers[].multi_session`,
    per the user: toggleable per login from Onboard Client → Portal logins —
    the "One device at a time / Multiple devices" dropdown under Access).
    Default stays one-seat. When on, each sign-in mints its OWN session key —
    `portal:<tenant>:<userId>@<6hex>|<client>` — so devices hold separate
    tokens instead of fighting over one; `parsePortalSessionKey` strips the
    `@device` suffix (a user id can never contain `@`), so every downstream
    reader sees the plain id. Capped at `PORTAL_MULTI_MAX` (8) live devices,
    refused with the count named; idle variants are swept at each login so
    persisted sessions cannot grow for ever. **Every teardown site goes
    through `deletePortalSessions`** (sign-out is per-device; switch-off,
    remove, ⏏ release, profile wipe and turning multi OFF kill ALL the
    login's keys — a variant that survives its login is the bug this helper
    exists to prevent). Turning the toggle OFF asks first on the office
    screen, signs every device out, and the next sign-in retakes the single
    seat. The row pill reads "● in use ×N". Verified 21 API + 6 browser
    checks, including the ninth-device refusal and the off-toggle teardown.
- Session key is `portal:<tenant>:<userId>|<client>`. The **pipe** matters: a
  client name may contain a colon, and a pre-existing session (no pipe) still
  parses as the legacy single account instead of taking the first word of the
  client name as a user id.
- Login is `{client, user, password}`. `user` matches id, email or name
  case-insensitively; a client with exactly ONE account may still leave it blank
  and log in exactly as before.
- **Passwords live on the accounts only.** `POST .../portal` now REFUSES a
  password (400) rather than writing one login no longer reads — the office
  would otherwise believe a password had been set.
- Office UI: Administrator → Onboard Client → **👥 Portal logins** — add,
  set password, switch off, free a stuck session, remove, and change access
  from a dropdown. Portal UI: a "Your login" field on the sign-in card, the
  account name as a chip (amber "· view only"), and the Send tab, ASN card and
  cancel ticks hidden for a view-only login.

Verified: 37 API checks (migration keeps the old password working, the cap
refuses a sixth, both levels see identical orders, every write refused for view
with a reason, the second device refused while the first carries on, sign-out
and admin release both free it, switching off ends the session at once,
downgrade bites on the next request, no hash or salt ever reaches the office)
plus 19 browser checks across the office screen and two client phones.

### What each LOGIN may SEE — `portalUsers[].visibility`, granted by us

Per the user: *"Client Portal: need to be able to toggle and set what they can
see, and what they cannot see unless granted. ie: reports etc."* — and then,
on seeing the first cut: *"THE ACCESSES should be per user level. not as a
group."*

Access (full / view) already said what one LOGIN may **do**. This is the other
question: which sections that login's portal carries at all.

- **PER LOGIN.** The first cut put ONE map on the client profile, reasoning
  that it was the arrangement with the account. The user overruled it, and was
  right: the same account holds a warehouse contact who needs Inbound and a
  finance contact who needs Reports, and one shared setting means granting the
  WIDER of the two to both. `portalUsers[].visibility`, set from that login's
  own 👁 panel.
- **THE CLIENT-LEVEL MAP IS STILL READ AS THE FALLBACK.**
  `portalUserVisibility(profile, user)` takes the login's own map, else
  `profile.portal_visibility`, else all-true — so a client configured under the
  first shape becomes each of its logins' starting point instead of being
  silently discarded. Saving on a login takes over from then on. There is no
  longer a route that writes the client-level map.
- **ABSENT READS AS VISIBLE, and so does an absent KEY.** No existing login
  changed the day this shipped, and a section added to `PORTAL_SECTIONS` later
  can never silently vanish for every login already created. Turning one off
  is always a deliberate act on the onboarding screen.
- Six sections: `overview`, `stock` (incl. their movement statement), `orders`,
  `inbound` (incl. GRNs and sending an ASN), `send`, `reports` (the ⬇ downloads
  — not a tab of its own).
- **AND WHICH REPORTS, WITHIN Reports** (per the user: *"also determine what
  reports they can see/download"*). `PORTAL_REPORTS` — Stock position, Orders &
  movements, What can ship, Inbound & receipts — each its own
  `report_*` key on the same map, so a login can have the stock position without
  the commercial detail in the orders workbook.
  - **`reports` is the MASTER and still wins**: off refuses every download
    whatever the individual ticks say (asserted).
  - **EVERY server-side kind that feeds a button is listed** in that report's
    `kinds`. The Orders workbook is `report` + `orders` + `cancelled` +
    `movements` + `transactions`, and all five are refused together — a download
    switched off on screen must not stay reachable by URL.
  - **An unknown kind falls back to the master alone**, never to "allowed".
  - `portalSectionForPath` returns an ARRAY for an export (the master AND the
    report); the middleware refuses on the FIRST key that is off and names it,
    so "Reports is not switched on" and "Orders & movements is not switched on"
    are told apart.
  - Office: the four ticks nest inside the login's 👁 panel and grey out when
    Reports is switched off — ticking a report that cannot apply is a
    configuration nobody can reason about later. The row summary counts them
    too, or a login with Reports "on" and three of four downloads gone would
    read as unrestricted.

### The report has to say WHAT moved, not just that something did

Per the user: *"movement report to include SKUs, description and quantity"*.
Orders and Cancelled were **one row per order** — "Lines: 1, Pieces: 3" and
nothing else — so a client could see that an order shipped and had **no way,
anywhere in the download, to see which products or how many of each**. The
Cancelled sheet is the worst case: it is the list a client re-places somewhere
else, and a piece count cannot be re-placed.

- **TWO SHEETS, NOT FOUR** — per the user: *"Order one sheet, Cancelled order
  one sheet"*. The per-SKU detail is IN the order sheets, one row per order ×
  SKU with the order's own columns repeated down its lines. Standard flat
  shape: it pivots and filters in Excel without anyone joining two tabs by
  hand.
  - **THE ORDER-LEVEL `Lines` AND `Pieces` COLUMNS ARE GONE, deliberately.** A
    row is no longer an order, so repeating an order's total on each of its
    rows would make that column sum to a multiplied figure — a wrong number
    arrived at silently, which is the exact trap this whole thread was about.
    Instead the sheet says, in words at the top: sum **Quantity** for pieces,
    count **distinct Order no** for orders. Asserted: the Quantity column
    totals what the portal SCREEN reports for the same orders (55 vs 55), and
    the distinct order count matches too.
  - **CANCELLED WORK KEEPS ITS OWN SHEET AND IS NEVER MIXED IN.** Raised by a
    client reading an earlier version (John Tang, MHM) and right: the workbook
    already separates them at order level, and summing a mixed Quantity column
    adds shipped and cancelled together with nothing saying so. Asserted both
    ways, on the standalone download and inside the workbook.
  - The Cancelled sheet's old comma-jammed `SKUs` cell is replaced by real
    SKU / Description / Quantity columns — it is the list a client re-places
    somewhere else, and a comma list of codes cannot be re-placed.
  - **AN ORDER WITH NO USABLE LINES STILL GETS A ROW** (blank SKU, "(no product
    lines on this order)"). Flattening onto the lines would otherwise make such
    an order vanish from the client's report entirely, which is a worse fault
    than a blank cell.
  - **ONE BUILDER, `portalOrderSheetRows()`.** The combined workbook and the two
    standalone downloads each had their own copy of the same loop — the
    workbook's comment claimed they shared code and they did not, which is how a
    column added to one could silently miss the others. Asserted: the workbook's
    tabs and the standalone downloads come out identical.
  - The catalogue's wording wins for the description (`description ||
    source_description`), so a line is never left as a bare code.

Verified 29 API checks against a client carrying BOTH shipped and cancelled
orders, plus 21 against a cancelled-only client. A check with no rows behind it
is SKIPPED out loud rather than passing on an empty sheet — which is how a
vacuous pass was caught twice here, once on a fixture with no live orders and
once when `/api/portal/orders` turned out to answer with a BARE ARRAY, so
reading `.orders` off it silently compared nothing.

**WHICH DATE THE PERIOD APPLIES TO IS NOW SAID ON THE SHEET.** Reported by a
client as *"last time the date range is based on Order Date, now the logic is
based on your completion date"* — half right. The filter has been
`st.endTime || o.date` since the FIRST version of this export (28 Jul 2026); it
never changed, and nothing in the line-detail work touched it. But his
observation was sound: the visible **Date** column is when the order was
PLACED, while the range filters a completed order on the day it was COMPLETED,
so rows legitimately appear whose Date sits outside the window — and nothing on
the sheet said so, which reads as a bug. Each order sheet now states its basis
in the title block (Orders → completed day, Cancelled → cancelled day, an open
order → its order date).

**DO NOT change the basis to order date without changing the SCREEN too.** The
portal's own day table and `orderDay()` bucket on the same rule; moving one and
not the other recreates the 15-vs-17 class of bug exactly.

**THE DOWNLOAD DIALOG NAMED THE WRONG REPORT** — found by screenshotting the
real portal rather than by reading the code. `openDownload(kind)` set its title
with an if/else chain whose last arm was "Download inbound report", and the
Orders tab asks for `'report'` (the combined workbook), which matched no arm —
so a client pressing ⬇ Report on Orders was told they were downloading the
INBOUND report. It is a `DL_TITLE` lookup now, which cannot fall through, and
an unknown kind says "Download report" rather than something wrong. The stale
`fulfillability` title went with it: that download was removed at the user's
request and its title was still here.

TEST GOTCHA: `POST .../portal-users` with a name and no id creates a SECOND
account, so a non-idempotent run left `mia-2`/`mia-3` behind — then logging in
by NAME bound to one account while the visibility check wrote to another, and
the refusal check "failed" against a perfectly good server. Reuse the login and
sign in by **id**.

- **ENFORCED IN THE ONE MIDDLEWARE EVERY PORTAL ROUTE GOES THROUGH.**
  `portalSectionForPath()` maps the request path to a section and
  `requirePortalAuthMiddleware` refuses it — so a route cannot be added that
  forgets to ask, and `requirePortalWrite` inherits it for free. Hiding a tab
  in the browser is the courtesy; this is the rule.
- **A REFUSAL SAYS SO** (403 + `hiddenSection`), never a silent empty payload —
  an empty list reads as "you have nothing" rather than "this is not switched
  on for you".
- **`/me` and `/notices` are never hidden.** The page has to know who it is, and
  we must always be able to tell a client something.
- **RE-READ ON EVERY REQUEST**, like access — switching a section off bites at
  once rather than at their next login, and nothing is stamped on their data, so
  switching it back on simply returns the tab.
- **A PORTAL SHOWING NOTHING IS A BROKEN LOGIN, NOT A CONFIGURATION**: at least
  one of `PORTAL_CORE_SECTIONS` (overview/stock/orders/inbound) must stay on
  **per login** (400, said in words). `send` and `reports` may all be off.
- Client side: `visible(k)` mirrors the same absent-reads-as-visible rule,
  hidden tabs and the four ⬇ buttons come off, `loadAll` does not even ASK for a
  section that is off (the refusals would fill their console for something
  working as arranged), and if the tab they were standing on has gone the page
  moves to the first one that is still there.
- Office: **Administrator → 🎉 Onboard Client → 👥 Portal logins**, a **👁**
  button on each login opening that login's own panel of ticks. Saved through
  the EXISTING `POST .../portal-users` (`{id, visibility}`) — one route for
  "change this login" — and audited under its own
  `client_portal_visibility_updated` event carrying the **user id**, not folded
  into the generic user-saved row. The row itself carries an amber
  "👁 no Reports" summary, so the table answers "who can see what" without
  opening six panels. A refused save re-renders from the server — ticks left
  showing a refused configuration read as a partial save.

Verified 44 API checks (everything open by default on every login and on the
login response and `/me`; Vera refused the download while Wes on the SAME client
still gets it; stock off takes the movement statement with it and inbound off
takes GRNs and the ASN template; `/me` and notices never hidden; all-off refused
per login with nothing changed; it bites mid-session; changing one login leaves
the other untouched; another client untouched; the trail names WHICH login) —
including a two-phase check that a client configured under the old client-level
shape still has it inherited and ENFORCED after a restart, and that saving on
the login takes over — plus 36 browser checks on desktop and a Pixel 5 (a panel
per login, closed until asked for, the save naming the person, the on-screen
refusal and its re-render, the row summary, and the two logins' portals showing
genuinely different tabs and buttons on the same client).

### Client order upload — THREE STEPS, and nothing reaches us until step 3

Per the user: *"step 1. upload order csv. completed then / step 2. upload
waybill pdf. match automatically / then its transmitted to Admin for approval"*.
The first cut had two INDEPENDENT uploaders side by side, each creating its own
`pending` submission — which meant a client's waybill PDF was matched at
approval time against LIVE orders, and the orders it belonged to were still
sitting unapproved, so it matched **nothing**. Doing the orders first is what
makes the waybill match possible at all.

- **`status: 'draft'`** is the new first state. Step 1 (`/api/portal/submit-orders`)
  parses and stores the file but raises **no poke, no audit "submitted" event,
  and the office queue filters drafts out entirely** — a client part-way through
  an upload has not sent us anything, and a 15-minute approval clock must never
  start on work nobody has sent. `age_minutes` is measured from `transmitted_at`,
  not `submitted_at`.
- **Step 2** (`/api/portal/submit-labels` with `for_submission`) matches the PDF
  against the orders IN THAT DRAFT via `matchLabelsAgainstDraft()` and stores a
  `match_preview`. `buildLabelMatchIndex()` was split so `buildLabelMatchIndexFor(orders)`
  can be pointed at any order-shaped list — ONE implementation, because a second
  one would drift and then the "12 of 12 matched" a client sees before sending
  would stop meaning anything. Unmatched pages are returned WITH whatever was
  read off them (tracking / order number), so an unmatched label is explainable.
  `for_submission` is optional: without it the file is a standalone draft with no
  preview, matched at approval against live orders exactly as before.
- **`summary.orders[]` now carries `waybill_number`/`issue_no`/`po_number`.** A
  courier label usually prints only the tracking number, so matching a draft by
  order number alone would have failed on real files.
- **Step 3** (`POST /api/portal/submissions/:id/transmit`) is the moment the
  package arrives with us: the draft AND its attached waybill file flip to
  `pending` together, **ONE** poke is raised naming both parts, and the clock
  starts. `DELETE /api/portal/submissions/:id` discards a draft; it refuses
  (409) once transmitted — from then on it is our decision to approve or reject,
  not the client's to withdraw. `DELETE .../:id/labels` swaps out the wrong PDF.
- **The office sees ONE row, not two.** `/api/client-submissions` filters out
  both drafts and any submission with a `linked_orders_id`; the waybills are
  shown INSIDE the parent row and on the approve screen, with the client's own
  match result. Approving processes them **after** `db.batches.unshift(batch)` —
  order matters, since `processLabelPdf` matches against live orders and running
  it first would match nothing every time. A label failure there is reported,
  never rolled back over: the orders are already live and must stay live.
  Rejecting the orders rejects the waybills with them.
- Portal UI is a 1 Orders → 2 Waybills → 3 Send stepper (`#sendSteps`), and the
  submissions list shows a draft as "Not sent yet" with Continue / Discard, so an
  abandoned upload is never stranded.

NOT BUILT, deliberately: the portal has no entry point for sending waybills for
orders we approved EARLIER — the server still accepts it (`for_submission`
omitted), but no screen offers it. Add it from an approved row if a client asks.

**Two parser bugs this exposed, both found in a real client file**
(`SO Ref | Waybill Ref | SKU | Qty`, reported as "WAYBILL —" after approval):
- `waybill_ref` was in no chain in `mapRow`, so the waybill number was DROPPED.
  Added, with `so_ref`/`order_ref`/`so_no`/`sales_order_no`, `tracking_ref`,
  `awb_no`/`awb_number`, `consignment_ref`.
- Worse: the AI column-scorer picked `waybill_ref` as the **description**, so
  every pick line would have read "LZSGD1015082878" where the product name
  belongs. `scoreDesc` now returns -99 for a header containing any of
  `DESC_NEVER_WORDS` (waybill, tracking, awb, airway, consignment, barcode, ean,
  upc, invoice, shipment). Matched on WHOLE WORDS of the normalised header, not
  as a substring — "Order Notes" (`order_notes`) is a perfectly good description
  and must not be caught by an `order_no` substring. Regression-checked against
  the plain SKU/Quantity/Description, Keyfields `d-` and GI Analysis shapes.

Verified end to end: 28 API checks (draft invisible to the office, no poke until
transmit, 3-of-4 auto-match against the client's own pending orders, one poke
naming both parts, clock starts at transmit, withdrawal refused after transmit,
approval files the waybills against the NEW orders, both records closed together)
plus 29 browser checks with the client on a Pixel 5 and the office on a desktop
— including that the WAYBILL column is now filled on the Orders tab instead of
showing a dash, and that all five portal tabs fit without clipping from 320px up.

### The office can open what the client sent, and re-match their labels

Per the user: client submissions must be downloadable BEFORE approval so the
office can check them, and the labels must be re-matchable from our end
afterwards — especially when the match came back short.

- **`GET /api/client-submissions/:id/file`** streams the original the client
  uploaded — the orders sheet or the waybill PDF — under THEIR filename, before
  or after approval. The bytes were always on disk (`CLIENT_SUB_DIR`); nothing
  served them. "29 order(s), 33 line(s)" is not the same as opening the sheet.
- Each file on an approval row gets a **⬇ file** button, and an approved
  submission gets **⚡ match again**, which jumps to the Labels tab with that
  import already open — the review screen where ⚡ Auto Match / ↻ Rematch All
  live. `label_import_id` is exposed on the submission for both the standalone
  `kind: 'labels'` case and the waybills linked to an orders submission.
- CONFIRMED, not assumed: a client-approved label PDF **does** appear in the
  Labels tab import history under the client's filename with all its pages —
  `processLabelPdf` runs at approval and `GET /api/label-imports` filters
  nothing. If one is ever missing, the approval threw and said so in the audit
  log as `client_labels_approve_failed`; the orders stay live either way.

Verified 17 API checks (both files download before approval under the client's
own names and the sheet parses back to its real rows; approval creates the job
and links the import; the import is in the Labels list with all 29 pages; a
re-match runs and reports what it matched) plus 8 browser checks on the buttons.

### Bulk deletion approval (Master) + client self-cancel (portal)

Two separate paths, deliberately different in who needs whose permission.

**MASTER BULK APPROVE** — `POST /api/master/pending-deletions/bulk` and
`/api/master/inbound-pending-deletions/bulk`, both `{action:'approve'|'reject',
targets|ids, note}`. The Pending Deletions tables gained a select-all tick
column and a bulk bar. One call, one `writeDb`, per-record outcomes returned
so genuine per-record refusals are reported while the rest still go through.
- **The done-check is re-run at APPROVAL time, not just at request time** — an
  order can be completed in the window between the two, and completed work is
  never deleted. Such a request is SKIPPED and deliberately LEFT in the queue
  (reported as "Completed since the request") rather than silently dropped;
  the Master rejects it. Verified with exactly that race.
- Bulk approve needs a typed `DELETE` confirmation (same guard as "Clear All
  Jobs"); cancelling or mistyping deletes nothing.
- SELECTION SURVIVES THE 15s POLL. The tables re-render on a timer, which
  replaces every row — so `wireBulkDeletions()` holds the selection in a Set
  keyed by `batchId|orderNumber` (or inbound id) and re-applies it after each
  render, dropping keys whose rows are gone. Without this, ticking 100 rows
  and pausing silently cleared the lot. Regression-tested by waiting out a
  real refresh.
- GOTCHA fixed: `const sel = picked()` inside `run()` shadowed the outer
  selection Set, so `sel.clear()` threw. The local is `chosen` now.

**CLIENT SELF-CANCEL** — `POST /api/portal/delete` `{kind:'orders'|'inbound',
items[], reason}`. Per the user: a client may select all and delete their own
records with NO administrator approval — *unless the job has been processed*.
- "Processed" is judged on ACTUAL STATE, never a flag someone could forget to
  set (`portalDeletable()`): status `done` → refused; status `processing` →
  refused; any scanned/received qty > 0 → refused; already in our approval
  queue → refused. `unprocessed` (cancelled) IS deletable — that is tidy-up of
  something we already agreed not to process, and is a deliberate choice.
- The SAME function drives the `can_delete` flag on `/api/portal/orders` and
  `/api/portal/inbound`, so the UI only ever offers a tick where the server
  has already said yes — it cannot show an action that would then be refused.
- Ownership is checked FIRST and reported as "Not found", so a client can
  never probe for another client's record ids.
- Every deletion is audit-logged (`portal_order_deleted` /
  `portal_inbound_deleted`, with client, lines and qty) AND fires a
  `client_deleted` poke — work must never silently vanish off the floor's
  list. Requires a typed `CANCEL` confirmation plus an optional reason.
- This makes the portal write-capable in a THIRD narrow place (after ASN
  submit and the aging threshold). It is still read-only for everything else.

Verified: 30 API checks + 20 browser checks, including cross-client isolation,
the completed-after-request race, part-picked refusal, the poke firing, and
that a tick never expands the order card it sits on.

### NO warning banners at the top of the screen — System Outages only

Per the user, explicitly: *"do not put error messages on the top banner. only
under Administrator, system outages"*. Three fixed bars used to pin themselves
to `top:0` — `#healthWarnBar`, `#storageWarnBar`, `#storageInfoBar`. All three
are GONE. Do not reintroduce a top banner for any warning.

- `deriveHealthIssues(h, storage)` turns the `/api/system-health` snapshot plus
  the boot storage snapshot into `{sev:'crit'|'warn', title, text}` rows.
- `renderSystemHealth()` paints them into `#sysHealthBlock`, which sits at the
  top of Administrator → System Outages, ABOVE the recorded-errors list. When
  nothing is wrong it says so in green.
- `refreshSystemHealth()` polls every 60s (first check 4s after load) and is
  also called by `outagesUI.load()`, so the panel is never stale when someone
  opens it.
- Discoverability without a banner: the **System Outages nav badge counts open
  recorded errors PLUS current health issues** (`outagesUI.refreshBadge()`), so
  an admin still sees a number and knows to look. `showStorageBanner()` is now
  just a setter that stashes the boot snapshot for the panel.
- Why this matters beyond tidiness: the amber bar ate two lines of every page
  on a phone, and being `position:fixed` above the scan overlay it painted over
  the order number, progress and carton badge while a packer was mid-pick.

TRADE-OFF STATED HONESTLY: the data-loss warning ("storage does not survive
restarts") is now also only in that panel, so nobody sees it unless they open
Administrator. The boot log still prints it loudly, and `/api/version` still
reports `storage.dataLostOnLastRestart` for an external check.

### A client-portal fault IS a System Outage — and the client never sees a stack

Per the user: *"client portal if error is hit, also notify via System Outage"*.
The portal reported **nothing**. The office app and the driver app both had a
reporter posting to `/api/errors`; `public/portal.js` had neither one nor any
error handler, so a client staring at a screen that would not load was
completely invisible to us until they rang.

**THE CLIENT GETS A SENTENCE, WE GET THE STACK.** The office/driver treatment
shows the trace and asks the person to send it to the tech team — right for our
own staff and our own drivers, wrong for a customer. The portal shows one calm
line at the BOTTOM of the screen ("Something didn't load. Our team has been
notified automatically."), dismissible, never a fixed bar across the top (the
standing no-top-banner rule) and never a trace. The 500 body is
`"Something went wrong at our end. It has been reported."` — asserted to leak
no internal detail.

**TWO REPORTERS, EACH COVERING WHAT THE OTHER CANNOT SEE.** Filing from both
ends would land one fault as two rows with different wording:
- **Server** owns 5xx. `app.use('/api/portal', …)` registers a `res.on('finish')`
  hook before every portal route, so it sees them all — including the multipart
  uploads — and knows the real error. It only OBSERVES; the response is
  untouched, so a bug here can never take the portal down on top of whatever
  already went wrong. **4xx is deliberately not recorded** — a 401 on an expired
  session or a 404 on someone else's record is the system working.
- **Client** owns what never reaches us: JS errors (`error` /
  `unhandledrejection`, skipping the opaque cross-origin "Script error." that is
  almost always a browser extension) and requests that never completed.
  De-duplicated per session so a render loop cannot flood us; the server counts
  recurrences on its own row anyway.

- **Grouped on the ROUTE PATTERN** (`/api/portal/grn/:id`), not the concrete
  path — a broken screen is one fault however many records hit it, and keying on
  the id would file a row per receipt and bury how often it is happening. The
  concrete path is kept as `page` so the exact request is still reproducible.
- **The app is part of the signature** (`_errSig`): the same wording from the
  portal and from the office is two faults in two systems, and merging them
  would hide a client-facing outage inside an internal one.
- **WHICH CLIENT is resolved from their session token** (`_errWho`), never taken
  from the request body. `e.clients[]` accumulates everyone affected, because
  "three clients cannot see their stock" is a different call from "one".
  `/api/errors` stays open (a crash can happen before login and error reporting
  must never need a session), so the lookup is best-effort and is a diagnostic
  label only — nothing is authorised on it.
- **A client-facing fault is its own health issue**, not one more row:
  `/api/system-health` returns `openPortalErrors` / `portalErrorClients` /
  `portalErrorLastAt`, and `deriveHealthIssues` raises a **crit** "Clients are
  hitting errors in the portal" naming them, at the top of System Outages. The
  list tags those rows **CLIENT PORTAL** in red and shows "Affected: …".
- **There was NO Express error middleware at all** — an uncaught throw fell to
  Express's default handler, a bare 500 with the stack swallowed and nobody told.
  One is registered last, after every route: it records the real message (which
  the portal finish hook picks up out of `res.locals`, so the outage row is
  diagnosable) and files non-portal throws as office errors.
- Every portal call now goes through the single `api()` funnel — it omits the
  JSON content type for `FormData` so the upload screens use it too, instead of
  bare fetches nothing watches.

Verified 29 API checks (a genuinely corrupt receipt makes a real route throw:
the client gets 500 with no internal detail, the office is told without anyone
reporting it, with the route, the client and the real TypeError; a repeat counts
on the same row; a 404 and a 401 are NOT outages; the same wording from two apps
stays two rows; resolving clears the health issue and a recurrence reopens it)
plus 17 browser checks on a Pixel 5 and a desktop. The test found a SECOND real
failure path off the same bad data — `/api/portal/inbound` breaks on it too —
which is the mechanism doing its job.

### Backorders die with their order — `pruneOrphanBackorders()`

A `db.backorders[]` row is a tracking record hung off an ORDER ("awaiting
stock"). When the order goes away the row is meaningless, but nothing removed
it — a deleted upload left **335 backorders pointing at orders that no longer
existed**, all showing as open work.

Orders disappear down at least seven routes: Master direct delete, single
approve of a deletion request, bulk approve, client self-cancel from the
portal, duplicate-order overwrite, whole-batch delete, the Master reset, and
the 12-month auto-archive. Hooking each one is precisely how the gap appeared,
so the fix RECONCILES instead: `pruneOrphanBackorders(db)` builds a Set of
every live order number and drops any backorder not in it, whatever removed
the order. Audit-logged as `backorders_pruned_orphaned`.

Called from: `GET /api/backorders` (so the queue can never render a stale row
even if a future removal path forgets), each deletion site (so other screens
are correct immediately), and once at boot (which is what cleared the original
335 — harmless to repeat, it is a no-op when clean).

Verified by seeding 335 orphans plus 5 genuine rows: boot cleared exactly the
335, deleting an order took its row with it, deleting a batch took all four of
its rows, and rows on live orders were untouched.

### Inbound files: tolerant headers, summary rows skipped, catalogue lookup

Real inbound lists carry only `SKU Code *`, `Barcode (EAN/UPC) *`,
`Inbound Quantity` — and a client's actual file exposed three bugs at once in
`parseInboundFile()`:

1. **It was rejected outright.** Header matching was exact-set only, so
   `skucode`, `barcodeeanupc` and `inboundquantity` matched nothing and the
   upload died on "Could not find a SKU column". Matching is now exact-first
   with a substring fallback (`pick()`), and a **barcode column is recognised**
   — a file identifying products by barcode alone is now usable, the SKU being
   resolved from the item master.
2. **A summary row became a product.** The sheet ended `["Total", "", 186]`,
   which was parsed as a line: the floor would have been asked to receive 186
   units of an item called "Total", and the shipment's expected total read
   **372 instead of 186** — a huge phantom shortfall at receipt.
   `SUMMARY_ROW_PAT` skips exact summary words only, so a real SKU like
   `TOTALIZER-99` is untouched.
3. **Quantities came through as 0** because the qty header did not match.

DESCRIPTIONS ARE ALSO FILLED ON READ (`fillInboundDescriptions`), not only at
upload: the receiving screen showed a blank Description column for a job whose
item master was loaded AFTERWARDS — a completely ordinary order of events
during onboarding — and upload-time enrichment alone can never recover from
that. The read-time pass touches only lines still missing a description and
loads each client's catalogue once per request. It also means jobs created
before this feature existed heal themselves.

`unmatched_lines` is returned per job and shown as an amber
"⚠ N not in item master" pill on the receiving screen, so a blank description
is always EXPLAINED. The usual cause is the master sitting under a different
client name — `MAYER` and `Mayer(Mistral)` are genuinely different clients
(case folding does not help here), so the item master must be loaded against
the same client name the inbound job carries.

`enrichInboundLines(lines, clientName)` is the STANDARD now, on both the office
upload and the portal ASN: for every line it fills from that client's item
master — SKU from barcode, barcode from SKU, and description from the product
name. A line with no match is kept and flagged `unknown_product` (an item we
were never told about is still received — routine — it just cannot be
described), and the upload response reports `matched`/`unknown` so the receiver
is told before they start counting.

Verified with the client's own two files: Product Master (254 rows) then their
inbound list — 36 product lines, all 36 matched, every line carrying SKU +
barcode + description, expected total exactly 186.

### Transport jobs die with their order too

Exactly the same shape as the backorder orphan bug, and found the same way:
the Transport tab showed **124 jobs against 3 live orders**. A job created from
an uploaded order (`channel: 'order-upload'`, `referenceId` = order number) is
downstream of that order, but nothing removed it when the order was deleted.

`pruneOrphanTransportJobs(db)` reconciles against the live order list — same
reasoning as `pruneOrphanBackorders`, and called from the same three places:
`GET /api/transport`, every order/batch deletion site, and boot.

TWO exclusions, both deliberate and both tested:
- **Any other `channel`** — a TMS import or a manually keyed delivery has no
  source order and must never be judged against one.
- **`delivered` or `in-transit`** (`TRANSPORT_PRUNE_KEEP_STATUS`) — a delivery
  that happened is real history and lives in Delivery History; one on the road
  is on a van with a driver. Removing either would erase or strand real work.
  Same standing rule as completed orders.

Verified with the reported shape: 124 jobs → 9. The 115 orphaned outstanding
jobs went; both delivered jobs, the on-road job, the TMS-imported job, the
manual job and all four jobs for still-existing orders stayed. Deleting an
order then removed its delivery in tandem.

### One client, one spelling — case-insensitive client identity

Files arrive from different sources spelling the same client differently
("BETIME" from one, "Betime" from another). Each spelling used to create a
SEPARATE client: its own sidebar row with its own count, its own orders
filter, and — because `invClientId()` is case-sensitive — potentially its own
inventory account, splitting one client's stock in two.

Three layers, all case-insensitive now:
- **Display** — `renderSidebarClients()` groups by lowercase key and shows the
  spelling that appears on the MOST orders, with the combined count.
- **Filtering** — `renderOrdersList()` compares lowercased, so picking
  "Betime" also returns orders filed as "BETIME".
- **Ingest** — `canonicalClientName(db, name)` adopts the spelling this client
  is already known by (onboarding profile first, then existing batches/inbound)
  rather than imposing a house style. Applied at all four record-creation
  sites: file upload, photo scan, store sync, inbound upload.
- **Existing data** — `normaliseClientNameCasing(db)` runs at boot and rewrites
  `client_name` across batches, inbound and backorders onto one spelling
  (profile's if there is one, else the most common). Audit-logged as
  `client_names_normalised`; a no-op once everything agrees.

- **Inventory** — `inventory.mergeClientCasing(canonicalNames)` folds duplicate
  stock accounts, called by `mergeInventoryClientCasing()` right after
  `inventory.init()`. It must run THERE, not with the db.json pass at the top of
  the file: `const inventory` is still in its temporal dead zone up there, so
  the call would throw into a catch and be silently skipped (a trap this file
  has hit twice — see `assertInventoryPath`).
  - Quantities are **summed, never overwritten**, in ONE transaction, so a merge
    cannot lose stock. `inventory` and `stock_by_location` sum on collision;
    `bundles`/`serials` keep one row (a duplicate serial is the same physical
    unit); everything else is a straight re-key.
  - The winner is the spelling the REST OF THE APP uses, even when no inventory
    row currently carries that exact casing. Getting this wrong is subtle and
    was caught by the test: stock ended up filed under "ACME PTE LTD" while
    orders said "Acme Pte Ltd", so `invClientId()` looked in the wrong account
    and found nothing.
  - Idempotent: a second run is a no-op.

Verified clean-slate: 5 batches across 3 spellings of 2 clients folded to 2,
their split stock merged (60+15=75, 30+12=42), no leftover accounts, and a
focused unit test proving sum-not-overwrite, move, untouched-third-party,
zero loss, preserved movement history and idempotency.

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

## Scan durability — the SAME three guards on ALL counted-scan paths

Per the user: every scanning function in IdealOne must be loss-proof, not just
outbound picking. There are exactly THREE paths where a scan increments a
count, and losing one means a wrong number on the floor:

| path | endpoint | client fn |
|---|---|---|
| outbound picking | `/api/scan/increment` | `handleItemScan` |
| IdealInbound receiving | `/api/inbound/:id/scan` | `inboundScan` |
| wave picking | `/api/waves/:id/scan` | `waveUI.scan` |

(The Orders-tab "Scan waybill number…" bar is a LOOKUP, not a count — losing
one costs nothing, so it is deliberately not in this list.)

All three now carry the three guards outbound had alone:

1. **eventId idempotency.** Minted CLIENT-SIDE at scan time and sent on the
   very first request — not just on replays. The server remembers the last 100
   ids per target (`state.scanEventIds` for orders and inbound,
   `wave.scanEventIds` for waves) and returns `{dedup:true}` for a repeat.
   Registered ONLY once a piece is actually counted, so a 404/409 refusal never
   burns the id for its legitimate retry. This is what stops "scan once, get
   2 pcs" when a response is lost but the write landed.
2. **Durable offline queue** (`is_offline_scans` in localStorage). ONE queue,
   three kinds: `{id, kind:'order'|'inbound'|'wave', targetId, raw, extra, at}`.
   Entries written before `kind` existed have none and are read as `'order'`,
   so a queue that survived the upgrade still drains. `syncOfflineQueue`
   dispatches per kind to the right endpoint. Inbound entries carry the
   `condition` in `extra` — replaying a damaged piece as plain "received"
   would quietly make it sellable.
3. **Crash journal** (`scan-journal.ndjson`). db.json persistence is deferred
   (`setImmediate`), so every counted scan is ALSO appended immediately.
   `journalInboundState` / `journalWaveState` join `journalOrderState`, each
   line tagged with `kind`; `replayScanJournal()` replays all three and
   truncates. Two rules worth keeping: a **completed/cancelled wave is never
   reopened** by a stale journal line, and wave counts take the HIGHER of
   (journal, db.json) since `picked_qty` only ever grows while picking.
   Inbound journal lines carry `conditionTotals` for the same reason as above.

Plus, mirroring the order rule: **End Receipt and Close Wave are refused while
that target has held scans** — closing over a hole would bank a short count as
final (and, for a receipt, record the shortfall against the supplier). The job
stays open and reopenable; the queue drains on its own.

### Every scan is BOUND to its target at scan time, never re-read later

A live crash from the floor:
`TypeError: Cannot read properties of null (reading 'order_number')` at
`enqueueOfflineScan`. The drain is async, so `closeScanOverlay` (which sets
`activeOrder = null`) can run while a scan request is still open; when the
request then failed, the catch called `enqueueOfflineScan`, which dereferenced
the now-null `activeOrder` and threw UNCAUGHT — **and the piece was lost**,
because the throw killed the very enqueue meant to save it. Reproduced exactly
against the deployed code (`entries=[]` proves the loss), then fixed.

The same code had a worse, quieter bug: `_drainScanQueue` read
`activeOrder.order_number` when BUILDING the request, so a piece scanned on
order A while the packer moved to order B was **posted against B**.

Fix, applied identically on all three paths: the target id is captured at scan
time and carried on the queue entry —
`_scanQueue.push({raw, orderNumber, eventId})`, `inboundScan`'s `jobId`,
`_waveScanQueue.push({raw, eventId, waveId})`. Nothing downstream re-reads
`activeOrder`/`activeInbound`/`currentWave` for identity. Every UI write is
gated behind an `onScreen()` / `stillOpen()` check comparing the captured id to
what is open now, and `enqueueOfflineScan(raw, eventId, orderNumber)` takes the
order explicitly and returns quietly rather than throwing if there is nothing to
attribute the scan to. A scan that lands while its screen is closed is still
recorded server-side; only the repaint is skipped.

Verified: 8 checks (no TypeError when the overlay closes mid-scan, the piece is
still saved against the RIGHT order, it drains once the network returns, on
phone and desktop) + 2 checks that a mid-flight order switch still posts to the
order the scan was taken on + 10 regression checks. The crash test fails 6/8
against the pre-fix code, so it genuinely reproduces.

TEST GOTCHA: typing a SKU with `delay:3` on a busy desktop page makes the gaps
exceed `QTY_BURST_GAP_MS` (140ms), so the qty-burst detector splits the code and
the assertion reads a TAIL fragment (`"-1011"`) — the harness, not the app.
Click the scan input first and type at ~15ms.

### Two real defects this audit turned up (both were losing pieces)

- **Wave scanning dropped scans silently.** `waveUI.scan` guarded concurrency
  with `if (_waveScanBusy) return`. A gun fires faster than the round trip, so
  with the endpoint slowed to 700ms a burst of **5 scans recorded 1**, with no
  error shown. Now queue-and-drain (`_waveScanQueue`), and on a network failure
  the whole remaining burst is handed to the durable queue rather than held in
  a variable a refresh would wipe.
- **The scan overlay opened without taking focus.** `_globalScanKeydown`
  deliberately passes keystrokes through when focus is inside some OTHER input
  (so typing in a search box isn't hijacked). But nothing moved focus when a
  scan screen opened, and on a phone `focusActiveQty()` skips touch devices on
  purpose (focusing pops the on-screen keyboard over the list). So a packer who
  had tapped the waybill lookup bar and then hit "Scan →" had every gun
  character go into that bar — now hidden behind the overlay — and **the scan
  was lost with no error**. `attachGlobalScanCapture()` now BLURS a foreign
  input on attach: blurring dismisses the keyboard instead of summoning it, and
  with focus on `<body>` the capture's own redirect path takes over. Applies to
  all three screens at once. Proven load-bearing: removing just this blur makes
  the order path fail all three of its offline checks again.

### Verified

- **6 idempotency checks**: same eventId twice counts once on all three paths;
  a different id does count; the damaged/KIV condition survives.
- **7 crash checks** (`kill -9`, SIGKILL — untrappable, so no graceful flush):
  the journal captured all three kinds, all three recovered, the recovery was
  logged, the journal was truncated, and a second restart changed nothing.
- **6 deterministic replay checks**, because the kill test is racy — the
  deferred write often lands first, so the journal is never consulted and
  proves nothing for that path. Journal lines are hand-written with counts
  ABOVE db.json (exactly what a crash leaves) and replayed: all three kinds
  recover, a pre-`kind` line still replays, the condition breakdown comes back,
  and a completed wave is NOT reopened by a stale line.
- **11 browser checks**: a scan taken with the network down is held on each of
  the three screens with the operator told, End Receipt and Close Wave are both
  refused while held, all three kinds are held simultaneously, the queue
  survives a full page reload, drains by itself afterwards, and each piece
  lands server-side EXACTLY once.
- **14 regression checks** on phone and desktop: order scanning still lands
  (with focus deliberately parked in the waybill bar first), inbound still
  registers, a wave burst of 4 is fully counted, unknown codes still give an
  inline error, and the capture is still released on tab change.

TESTING GOTCHAS worth not rediscovering: `pkill -f "PORT=xxxx"` matches its own
command line and kills itself — kill the spawned process group by pid instead.
A leftover server from a failed run will happily re-persist over a freshly
copied data dir and make the next run measure the wrong process; the harness
asserts `/api/version`'s `bootedAt` moved on every boot. And `page.fill` on the
login form after a reload times out because the session survives in
localStorage — the overlay is present but hidden, so check visibility, not
existence.

## Personal data is erased 3 months after an order completes

Required by the marketplace's ISV programme and decided by the user: once an
order is done, personal data may be kept for at most three months and must then
be permanently deleted.

**NOTHING IS ERASED WITHOUT SOMEONE SAYING SO** — per the user, "always prompt
to confirm before executing". Erasure is irreversible and the first sweep takes
the whole back-catalogue at once, so the daily schedule COUNTS what is due and
waits. `db.piiPolicy.mode`:

- **`prompt`** (default) — the schedule reports what is waiting (stashed on
  `db.piiDue`, said in the boot log) and touches nothing. An operator erases it
  from Administrator → System → **Personal data retention**.
- **`auto`** — the schedule erases unattended. Turning this on is ITSELF a
  confirmed action (type `AUTO`), so the prompt happens once instead of daily.
- **`off`** — not even counted.

`PII_PURGE_ENABLED=true` is still honoured as the STARTING mode for a
deployment that already set it, mapping to `auto`; the stored policy wins once
anyone sets it on screen. **While it is in `prompt` and nobody presses the
button, the retention promise it backs is not being met** — the count on the
card is what says so.

- **`GET /api/master/pii-purge`** is a LIVE dry run, never a stored count — the
  number someone confirms against has to be the number that actually goes.
  Reading it three times changes nothing (asserted).
- **`POST /api/master/pii-purge/run`** needs the typed word `ERASE` **and** a
  reason of 6+ characters — same discipline as a hand stock adjustment, and for
  the same reason: this is a change with no document behind it, so the trail is
  all there is. Audit-logged `personal_data_purge_confirmed` with who, why and
  how many.
- **`POST /api/master/data-retention/purge-now`** (the older marketplace-only
  route) demands the same word — it predates the gate and would otherwise be a
  way around it.
- **THE TWO PASSES OVERLAP AND THE SCREEN MUST NOT ADD THEM UP.**
  `purgePersonalData` clears name/address/phone on EVERY completed order; the
  marketplace pass (`lib/pii-purge.js`) clears a WIDER field set (tracking,
  email) on the SUBSET of them that came from a sales channel. With both windows
  at the default 90 days the marketplace figure is PART of the first, so the
  response carries `marketplaceSubset` and the card words it as "including".
- `lib/pii-purge.js`'s `purgeBatches`/`purgeAudit` take `{dryRun}` — that is
  what makes the preview possible without a second implementation of the rules.
- These routes sit ABOVE the global auth middleware (master-key gated), so
  `req.userId` is never populated — `_tokenUserId(req)` resolves the signed-in
  staff user from the token, or the trail names nobody. The pre-existing
  `marketplace_data_purge_manual` had exactly that bug.

**THE ORDER SURVIVES, THE PERSON DOES NOT.** `purgePersonalData(db)` blanks only
the fields that identify a human — `customer_name`, `delivery_address`, `tel`
(`PII_FIELDS`). The order number, SKUs, quantities, dates and tracking number
stay, so billing, stock history and dispute records remain reconcilable;
deleting whole orders would tear holes in figures we are separately obliged to
keep for 12 months.

- **The clock runs from COMPLETION** (`state.endTime`), not upload — an order
  still being worked has not started it.
- **Irreversible by design**: the fields are overwritten in place, never moved.
  A purge you can undo is not a deletion.
- Stamped `pii_purged_at` so a second run is a no-op; audit-logged
  `personal_data_purged` with the counts.
- `scheduledRetentionSweep()` runs 2 minutes after boot and daily thereafter,
  alongside the two archive jobs, and runs BOTH purges together so "what is
  waiting" and "erase it" can never disagree about scope.

Verified 34 API checks (previewing three times changes nothing; no word, the
wrong word and a non-reason are each refused with the data untouched; the old
route refuses too; confirming erases and the ORDER SURVIVES with its number,
SKU and quantity; a recent order and a still-open order are both left alone; the
marketplace order loses its tracking number as well; the trail names who and
why; unattended mode is refused without `AUTO` and going back to prompt needs
nothing) plus 17 browser checks on desktop and a Pixel 5 (cancelling the prompt
erases nothing, the wrong word is refused on screen, the mode snaps back, the
card updates itself and the button goes dead once there is nothing left, and no
banner is pinned to the top of the screen).

CARRIED OVER, NOT SOLVED: nightly gzip backups (kept 14) still contain the
personal data until they rotate out, so full erasure completes ~14 days after
the purge. Say so if asked rather than claiming instant deletion.

## "Deploy Crashed" emails — the app never crashed; PID 1 did not forward SIGTERM

Three days of Railway "Deployment crashed" emails, each ~90s after a push and
NONE in between: every one was the OLD container's teardown at redeploy, not a
crash. The graceful-shutdown handler (exit 0 on SIGTERM) never ran because the
start command put a shell/npm wrapper at PID 1, which does not forward SIGTERM
to node; Railway SIGKILLed the container and read the kill as a crash.

- **`railway.json` → `deploy.startCommand: "exec node server.js"`** — the shell
  replaces itself with node, node IS PID 1, receives SIGTERM directly, exits 0.
  Do not remove this file or revert the start command to bare `npm start`.
- **Crash forensics are real, not decorative** (commit 6a33999): every clean
  shutdown drops `.clean-shutdown.marker`; a boot that follows a previous boot
  WITHOUT it files a recurring "Server restarted without a clean shutdown" row
  in System Outages and counts `uncleanStops` on `/api/version`. So: crash
  email + no Outages row = platform noise; crash email + row = genuinely dying
  (suspect OOM in label OCR first).
- Verified by deploy: the first push after railway.json produced ZERO crash
  emails (checked in the actual inbox), where every prior push produced
  exactly one.

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

### `e.key` is not guaranteed — normalise it before reading `.length`

A live crash from the floor: `TypeError: Cannot read properties of undefined
(reading 'length')` at `_globalScanKeydown`. Android soft keyboards, some
scanner keyboard apps and IME composition all deliver a `keydown` with NO `key`
property, and `e.key.length === 1` threw on it — which popped the full-screen
tech-error dialog at a packer mid-scan.

The handler now normalises ONCE at the top
(`const key = typeof e.key === 'string' ? e.key : ''`) and uses `key`
everywhere, so a keyless event is simply nothing to buffer. For a real
KeyboardEvent `key === e.key`, so there is no behavioural change to scanning.
It also stops the literal string "undefined" being appended to `_scanBuf`.

Proven both ways with the scan overlay genuinely OPEN (the capture is only
attached then — an earlier version of the test silently proved nothing because
the listener was not even installed): the pre-fix code throws exactly the
reported TypeError and shows the dialog; the fixed code does neither, real
keystrokes still buffer ("5603"), and a keyless event fired MID-scan leaves the
scan intact ("56" + stray + "03" = "5603").

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
- PRINTED CARTON LABEL (`printCartonLabel`, 🏷 on the carton bar, and the
  primary button on the mandatory label prompt). Per the user: *"we want to
  print the cartons labels + order information instead of writting"*.
  - **PRINTING IS THE CONFIRMATION.** The packer has produced the label and is
    sticking it on; a second "I've done it" tick would mean nothing. **Written
    by hand stays** as the fallback so a dead printer never stops a pick, and
    the box is only marked labelled if the print actually reached the dialog —
    a blocked pop-up must not tick it for them.
  - **THE BARCODE IS THE CARTON ID (`24944949-01`), NOT the order number.**
    Scanning a box has to identify THAT box; two cartons of one order are
    otherwise indistinguishable. (The packing slip deliberately still barcodes
    the ORDER — it answers a different question.)
  - Carries every identifier the order actually has — client, customer, GI,
    waybill, PO, job code — and prints only the ones that exist, because a
    label of empty captions is harder to read than a short one.
  - **AN EMPTY CARTON PRINTS NO CONTENTS TABLE.** The label goes on the box
    BEFORE it is packed (carton 1's prompt fires as the order opens), so there
    is nothing to list; it states the order total and says to reprint once
    packed. 🏷 then reprints it with the real contents.
  - 100×150mm page (the common thermal label) with an A4 fallback.
  - `/api/scan/carton-slip/:orderNumber` gained `issueNo`, `waybill`, `poNo`,
    `pickTicket`, `jobCode`, `orderedTotal`, `packedHere` and `labelText` — one
    endpoint feeds both the slip and the label so they cannot drift.
  - GOTCHA: the prompt's any-key dismissal is CAPTURE-phase on `document`, so
    Enter on a focused Print button dismissed the prompt before the click ever
    fired. It now ignores keys whose target is inside the overlay.
  - **EACH CARTON'S LABEL PRINTS WHEN THAT CARTON CLOSES.** The user's final
    spec, verbatim: *"when individual carton closes, label to be out
    automatically. ie: an order of 3 ctns — carton #01 will be printed when
    user scans a few products then opens another carton. until the last, user
    will complete the order, final carton label will be out as # of #."*
    - `+ New Carton` closes the current box → its label auto-prints with its
      REAL contents and piece count, carton number alone (**no "of X"** — the
      total is not a fact mid-order, and the user accepted that only the final
      label carries it).
    - Completion closes the last box → its label auto-prints as **"n OF n"**.
      Called with NO carton number, deliberately: completion drops an empty
      trailing carton server-side, and a stale client-side count would 404 —
      the slip endpoint's default is the last REAL box.
    - A single-box order prints its one label at completion, "1 OF 1", with
      contents.
    HISTORY, so nobody relitigates it: print-at-OPEN was built first ("label
    the box before packing") and the floor rejected it — a label before
    packing reads "0 pcs" and can claim no total (Yvonne, betime). An
    all-at-completion run was built next; the user then specified per-close.
    Nothing prompts at order-open. `showCartonLabelPrompt`/`showSealFinalCarton`
    are dead definitions (the INBOUND flow's own prompt pair is separate and
    untouched). 🏷 (reprint current, with "OF m" once done) and 🏷×N
    (pre-print a strip) remain.
  - **A FRESH PRINT IFRAME PER PRINT, never a rewritten one.** The print fires
    from the written document's `window.onload`, and whether `load` re-fires on
    a document.write into an already-loaded frame is exactly the kind of
    behaviour that differs between headless and desktop Chrome — a silent
    no-print on every label after the first. The old frame is removed first, so
    the page still holds ONE frame.
  - **IT PRINTS ITSELF, INCLUDING CARTON 1** (per the user). The prompt fires
    and the label goes to the printer without anyone pressing anything —
    printing is how this label gets onto a box, so a button in front of it only
    ever cost time. Printing IS the confirmation, so the prompt then closes;
    if the print never happened the prompt STAYS UP saying so, with **Written
    by hand** still there for a dead printer. Fires once per prompt, so a
    reopen never produces a second copy.
  - **PRINTED FROM A HIDDEN IFRAME, NOT `window.open`.** A pop-up outside a
    click handler is blocked by every browser, so the auto-print silently did
    nothing — found in the browser test, not by reading. The frame is reused
    (ten cartons must not leave ten frames), positioned OFF-SCREEN rather than
    `display:none` (an unrendered frame lays out as nothing and Chrome prints a
    blank page), and `focus()`ed before `print()` or the TOP document goes to
    the printer instead.
  - **THE ORDER REFERENCE IS THE SECOND-BIGGEST THING ON IT**, carrying the
    CUSTOMER — per the user, the block someone reads across a bench. The GI
    leads when there is one (it is the reference on the client's paperwork)
    with the order number beneath it; the carton id still leads overall,
    because scanning a box has to identify THAT box.
  - **QUANTITY IS STATED, not derived.** "3 pcs in this carton · 6 on the
    order" — adding up the contents table is not a thing anyone does on a
    loading bay. Stated ONCE: the empty-carton line used to repeat the order
    total and now just says how to get the contents on later.
  - **"CARTON n OF m" IS PRINTED ONLY ONCE m IS TRUE.** How many boxes an order
    takes is NOT knowable when the first one is labelled — it depends on the
    goods, the cartons to hand and the packer's judgement. The label printed
    `CARTON ${cartonNum} OF ${cartonCount}` unconditionally, and `cartonCount`
    is how many boxes exist RIGHT NOW, so on a four-box order the first label
    read **"CARTON 1 OF 1"** and told a receiver the consignment was complete
    with three more boxes behind it. Worse than saying nothing. The carton-slip
    endpoint now returns **`cartonTotalFinal`** (`state.status === 'done'` —
    completion closes every carton and drops an empty trailing one, so that is
    exactly when the number stops moving) and the label states the carton
    number ALONE until then. A 🏷 reprint after completion carries the real
    "OF 2".
  - **PRE-PRINTING A STRIP FOR A BIG ORDER** — 🏷×N on the carton bar, per the
    user, for an order that will take several boxes.
    - **NEVER AUTOMATIC AND NEVER A GUESS ON THE PACKER'S BEHALF.** Nothing in
      the system can know the box count up front (`orderedTotal` says 20
      pieces, not how many cartons those need), so it ASKS. A packer who
      already knows a job is four boxes takes the next three.
    - **IT PRINTS PAPER AND NOTHING ELSE.** No carton is created — `+ New
      Carton` is still the only thing that brings a box into existence — so a
      label that ends up unused is torn up and leaves no phantom carton on the
      order. Asserted: the run leaves the order on exactly one carton.
    - Numbered from **highest + 1**, which is what `+ New Carton` creates, NOT
      current + 1: a packer may have switched back to an earlier box.
    - Each label is identical to what that carton's own label says the moment
      it is opened — empty, with the order total on it — so nothing is
      invented. Capped at `PREPRINT_MAX` (20) so a fat finger cannot send 500
      pages, and the confirm names the exact ids first.
  - **REPRINT FROM THE ORDERS LIST, COMPLETED INCLUDED** (🏷 Carton Labels on
    the Orders bulk bar, `printCartonLabelsForOrders` in app.js). Per the user:
    select orders on the Orders tab — completed ones included — and get their
    carton labels again. Rides the carton-slip endpoint, which deliberately
    never checks `state.status`: a done order reprints every box with its real
    contents and the final "CTN n / m"; an open one prints what is true now
    (number only). ONE print run for the whole selection with a confirm stating
    the real label count first; archived orders are excluded (their batch is
    off the live db, the endpoint 404s). **WAREHOUSE has this too** (per the
    user): non-admin logins get the tick boxes and a REDUCED bulk bar carrying
    ONLY 🏷 Carton Labels + Clear — the admin group actions are absent from
    their DOM, and every role-gated route stays enforced server-side anyway.
  - **ONE LABEL BODY, `cartonLabelBody(data)`.** The single print, the
    auto-print and the pre-print run all render through it, so a change to the
    label can never reach only some of them. The barcode `<svg>` went from an
    `id` to a `class` (`svg.bc`, `data-code`) because a run holds several, and
    `printCartonLabelDoc` loops over them; `.lbl-page` carries the page break.
  Verified 22 browser checks driving a real pick — the label printing itself on
  open with nothing pressed, reaching the print dialog, the prompt closing
  itself, the reference and customer sized above the identifier rows and below
  the carton id, neither duplicated in the table below, and the same box
  reprinted after packing showing 3 pcs and both SKU lines. Plus 14 API checks
  on the "OF m" rule (an open order claims no total; a second box is opened and
  it STILL claims none — the moment the old code printed "OF 1" on a two-box
  order; completion makes it final and both boxes then reprint "OF 2") and 20
  browser checks on desktop and a Pixel 5 on the pre-print (it asks rather than
  guessing, says plainly that it creates nothing, renders three sequential
  labels each with its OWN barcode, all blank, none claiming a total, one per
  page — and the order still holds exactly one carton afterwards).

  Verified 14 browser checks driving a real THREE-box pick end to end —
  nothing at open; closing carton 1 auto-prints "CARTON 1 · 2 pcs" with its
  own SKUs; closing carton 2 likewise; completion prints "CTN 3 / 3" (the short form, on the right) and
  only that one carries the total — plus 3 on a single-box order printing
  "1 OF 1" at completion with contents. (The superseded print-at-open and
  all-at-completion suites were updated alongside.)

  TEST GOTCHA, cost three runs: resetting the order needs the server STOPPED
  first (a running one re-persists its in-memory db over the file) AND
  `scan-journal.ndjson` deleted — the journal replays at startup and takes the
  HIGHER count, so a seed that only rewrites db.json is silently overwritten by
  the previous run's scans.
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

### The Inbound list on a phone is a card, not a sliced table

Reported as showing almost nothing useful on the device the floor works from.
It hid columns with `nth-child`, which had TWO problems:

- **The indices assumed no tick column.** An ADMIN gets one (mass receive), so
  every index was off by one and the WRONG columns were hidden for exactly the
  people who use the screen most. Class-driven now, so nothing can shift it.
- **Even when it worked it left a serial and a button** — no way to tell what
  the receipt was, whose it was, or how far along.

Same card treatment `.orders-tr` already had: serial and status on the first
line, reference beneath, a one-line summary (`.inb-mobile-sum` — type · client ·
counted/expected pcs · cartons · date) carrying what the dropped columns said,
a status stripe down the left edge, and Receive as a full-width 46px target.
The summary line is phone-only — on desktop every column it repeats is on
screen, so showing it there would be noise.

GOTCHA, the same one the Orders card hit: `> td { display: block }` beats a
short `.inb-tr > .inb-actions`, so the actions cell never became a flex
container and the main button stayed at its natural width. The selector has to
be the long `#inboundList .orders-table > tbody > tr.inb-tr > td.inb-actions`.

Verified 26 browser checks at 393px, 320px and desktop: the serial, status,
reference and summary all on screen with the real columns not duplicated, the
stripe coloured by status, Receive 330px wide and 46px tall and fully on
screen, no sideways scroll at any width, the admin tick present and a real tap
target, and the summary line absent on desktop where the columns are.

## The topbar page heading — "which screen am I on?" (`#ctTabTitle`)

Per the user: the tab name must be readable at a glance, on phone AND desktop.
It was `.9rem/700` in the topbar, which read as a breadcrumb — at arm's length
you could not tell Orders from Inbound without reading the content below.

- `#ctTabTitle` is an `<h1>` (there was no h1 on the page at all) containing
  `#ctTabIcon` + `#ctTabText`. **`switchTab` writes into `#ctTabText`, never the
  wrapper** — `ttEl.textContent = …` on the wrapper would delete the icon span
  with it.
- The icon is COPIED from the now-active `.tab-btn .tab-icon`, so the heading
  can never show an icon the sidebar has since changed.
- 1.4rem/800 on desktop, 1.2rem on phone (the bar is only 52px tall), with a
  4px `--primary` left rule so it reads as a page heading rather than a label.
  `min-width: 0` + ellipsis on `.ctt-text` means a long title can never widen
  the bar.
- PHONE ONLY: the topbar's `IDEALONE` wordmark is hidden (`.bc-word`) — at 393px
  the bar was hamburger + mark + wordmark + title, leaving the title 182px. The
  barcode mark stays, and the sidebar still shows the full lockup. Knowing which
  SCREEN you're on beats the wordmark on a phone, which is the point of the
  change. Desktop keeps the wordmark; there is no space pressure there.
- **Two in-page `<h2>`s that merely repeated the tab name are hidden** —
  `#tab-inbound` ("Inbound") and `#tab-waves` ("Wave Pick") — because one
  prominent title reads better than a big one plus a small one. DIRECT-child
  selectors on purpose: `#tab-waves` has another `.section-header` inside
  `#waveDetailWrap` whose h2 is `#waveDetailTitle`, **the wave's own name**,
  which must stay. Every other tab's heading says something the bar doesn't
  ("Upload Jobs", "Import Shipping Labels", "Operational Reports", Inventory's
  3PL note) and was left alone. The buttons beside the hidden headings are
  untouched.
- Verified 22 checks across all 8 tabs at 393px and 1440px: correct text and
  icon, ≥19px at weight 800, fully on screen, never ellipsised, no page
  h-scroll, the two duplicates hidden with their buttons still visible, and the
  wave detail's own name still rendering.

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

### The Driver App is its OWN installable app, not a page inside this one

`/driver` used to `<link rel="manifest" href="/manifest.json">` — the SAME
manifest the office app uses, whose `start_url`/`scope` are both `/`. A
driver "installing" it from their phone would have gotten the OFFICE app's
name/icon on their home screen, and tapping it would have opened the
office login, not their own — the install would have silently pointed at
the wrong app.

Fixed with a dedicated `public/driver-manifest.json` (`name: "IDEALONE
Driver"`, `start_url`/`scope: "/driver"`), which `driver.html` links to
instead. `driver.html` also now registers the same no-op-but-installable
`/sw.js` the office app uses (a registered service worker is one of the
PWA installability criteria Android/Chrome checks before firing
`beforeinstallprompt` — `driver.html` never registered any SW at all
before this, so on Android the install button may never have appeared).
`driver.js` gets its own copy of the install-hint bar logic
(`initInstallHint`, mirroring app.js's implementation), with its own
dismissal key (`driver_install_hint_dismissed`) so a driver dismissing
this hint doesn't affect the office app's hint on a shared device, and
vice versa. Verified with real Playwright + Chromium (not just code
review): a spoofed iOS user agent produces the correct "tap Share, then
Add to Home Screen" text; a synthetic `beforeinstallprompt` event produces
a real Install button that calls `e.prompt()` and hides the bar on click.

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

### Real distances — OneMap geocoding + road routing (server.js + lib/onemap.js)

The old distance engine mapped a postal code only to its 2-digit district
CENTROID (`SG_SECTOR_TO_DISTRICT`, 28 points for all of Singapore), so every
Jurong address (sectors 60–64 → one district D22) collapsed to a single point
and two of them read as **~0 km apart** — reported from the floor: 609216 →
648331 showed 0.7 km when the real road distance is ~4.6.

- **`lib/onemap.js`** (Singapore Land Authority, free, no billing): `geocode()`
  resolves a full 6-digit postal code to a building-accurate lat/lng (public,
  no token); `route()` returns real ROAD distance + drive time (token-gated,
  `getToken()` from a free email/password, ~3-day token).
- **`db.geocodeCache`** holds coordinates once resolved; `transportPostalCoords`
  uses them, so the district centroid is now only the FALLBACK for a
  not-yet-geocoded code or when OneMap was unreachable. `ensureGeocoded(zips)`
  fills the cache on demand. `roadLegKm(a,b)` returns cached road distance with
  a straight-line×1.4 estimate fallback — never blocks, never throws.
- The **client geocodes every stop's postal code before route planning**
  (`POST /api/transport/geocode` → `window._geocodeCoords`), and
  `getPostalCodeCoords` prefers the real coordinate over the district pixel — so
  the map and the plan's distances stop treating two Jurong stops as identical.
- Token cached in `db.config`, credentials via `POST /api/master/onemap/config`
  or env `ONEMAP_EMAIL`/`ONEMAP_PASSWORD` (env wins). CAVEAT: the sandbox can't
  reach onemap.gov.sg, so live calls are unverified — `ONEMAP_BASE` overrides
  the host and the fallback keeps distances sane until credentials are set.
- **UI + a directly-pasted token.** The `GET/POST /api/master/onemap/config`
  routes are **admin-or-master** (`requireTransportAdmin`, same guard as the
  geofence Save beside them — warehouse gets a real 403, not the office red),
  so the credentials live on a **"🗺️ Road distances (OneMap)"** panel inside
  the Zones & Drivers modal rather than needing the master key. Three ways in:
  OneMap email+password (auto-refreshes), OR **paste a routing token** (the
  short-lived `eyJ…` a OneMap account hands out — its `exp` is read straight
  out of the JWT so `onemapToken()` knows when it goes stale; WITHOUT
  email+password it **cannot** auto-refresh and the panel says so). A **Test
  distance** button hits `/api/transport/road-distance?from=609216&to=648331`
  and reports the km + whether it was real road routing or the estimate.
  Geocoding (which fixes the Jurong 0 km collapse) needs **no** token — only
  road routing does.

### Geofencing — five zones, driver ⇆ days, before AI routing

Per the user: assign drivers to zones (North/South/East/West/Central) for chosen
days of the week BEFORE the AI route generation; multiple drivers may share a
zone.

- **`regionForZip`** classifies a postal code into N/S/E/W/C via a default
  district→region map (`REGION_BY_DISTRICT`) — a sensible default an operator
  sanity-checks on screen (each zone lists its districts); moving a district
  between zones is a follow-up, not baked policy. `GET /api/transport` now
  returns `region` on every job.
- **`db.geofence.assignments`** = `[{id, region, driverId, days:[0-6]}]` —
  multiple rows per zone = multiple drivers; a driver on two zones = two rows;
  days are 0=Sun..6=Sat. `GET/POST /api/transport/geofence`
  (`requireTransportAdmin` to save; warehouse 403).
- **UI**: Transport → 🧭 Zones & Drivers (`#geofenceModal`) — one block per
  zone, each driver with a Sun–Sat day row; ticking a driver defaults to the 5
  weekdays.
- **Wired into `autoAssignDrivers`**: each route goes to a driver who covers its
  MAJORITY zone on the plan's day-of-week (round-robin among the eligible, still
  limited to "Today's Drivers"); falls back to plain round-robin for a zone
  nobody covers that day or when no geofence is set. A deeper zone-first
  re-clustering of stops is a possible follow-up; today it steers driver
  assignment, not the stop grouping.

Verified: 6 OneMap checks (geocode both codes, 609216→648331 is a real 4.62 km /
11 min not 0.7, flagged real-not-estimated, cached), 7 geofence API checks (five
zones, Jurong is West, invalid region dropped, multiple drivers per zone each
with own days, warehouse 403, persisted) and 6 browser checks (editor opens, 5
zones × 2 drivers, weekday default, multi-driver save).

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

## Wave Picking — order-state integration, "Needs Closing" pill, cancellation

Wave Picking (lib/wave-pick.js, the "Wave Pick" tab) originally only
tracked its own pick-list state — completing a wave never touched a real
order's `scanned`/`status`, so the packer still had to re-scan everything
through Scan & Check afterward, defeating half the point. Closes the loop:

- **`applyWaveToOrders(db, wave, req)`** (server.js, called from `POST
  /api/waves/:id/complete`): for every FULLY-picked line (`picked_qty >=
  total_qty` — a still-short line is left for the packer to finish via the
  normal Scan & Check flow, not silently credited), writes each order's
  share into the SAME fields `/api/scan/increment` writes —
  `state.scanned[sku]`, `addToActiveCarton`, `appendScanLog`,
  `journalOrderState` — via `findBatchForOrder`. Stamps `state.wave_id =
  wave.id`. Never touches an order already `'done'` (skipped and reported
  separately as `skippedDone` — this codebase's standing rule). The
  `/complete` response includes `appliedOrders`/`skippedIncomplete`/
  `skippedDone` so the caller knows exactly what happened.
- **"🌊 Wave Picked — Needs Closing" pill** on the Orders list: shown
  whenever `order.wave_id` is set AND `scan_status !== 'done'` — i.e. a
  wave touched this order's scanned state but the packer hasn't
  individually completed it yet. Disappears the moment the order is
  completed normally (no explicit clearing needed — the pill's own
  condition just stops matching). Admin-clickable → prompts for a reason +
  password → `POST /api/waves/:id/cancel-request`.
- **Cancellation — two tiers, mirroring the order/inbound deletion
  pattern**: `POST /api/waves/:id/cancel` is instant for a wave that hasn't
  been completed yet (nothing was ever applied, nothing to undo). A
  **completed** wave needs Master approval — `POST
  /api/waves/:id/cancel-request` (admin role + the admin's own password
  re-confirmed, same reasoning as inbound deletion: 403 not 401 on a wrong
  password, since the session token itself is still valid) sets
  `wave.pending_cancellation`; `GET/approve/reject
  /api/master/wave-pending-cancellations` mirror the existing
  pending-deletions endpoints exactly, including the nav badge being the
  SUM across all three pending-request tables now (orders, inbound,
  waves). Administrator → Pending Deletions gained a third table ("Wave
  Cancellation Requests") below the existing two.
- **`reverseWaveFromOrders(db, wave, req)`**: runs `applyWaveToOrders`
  backwards on approval — subtracts what was added, per (order, sku).
  Skips (and reports as `skippedDone`) any order that became `'done'` in
  the meantime. **Reverts `state.status` back to `'pending'` ONLY if the
  order's TOTAL scanned qty across ALL its SKU lines is genuinely back to
  zero** — an order with scans from OUTSIDE the wave (a packer's own
  manual scan on the same or a different line) correctly KEEPS its
  `'processing'` status instead of being wrongly reset. Verified directly:
  an order with a wave-applied qty of 2 plus one extra manual scan (total
  3) reversed to 1 remaining and correctly stayed `'processing'`, while a
  sibling order with only wave-applied scans correctly reverted to
  `'pending'`. Also clears `state.wave_id` on the reversed order so the
  pill can't reappear for a cancelled wave.

### Scan picking — `POST /api/waves/:id/scan` + `matchScannedSku()`

Wave picking used to be tap-"Pick"-and-key-a-number per line, which is not
how anyone works a pick face. Now one scan = one piece, the same convention
as order scanning, so a gun works with no typing at all. The per-row "Pick"
button stays for keying a whole line at once (a full carton off a pallet).

- **`matchScannedSku(rawInput, sku, items, getSku, clientId)`** (server.js,
  just above `/api/scan/increment`) is the resolution chain EXTRACTED from
  that endpoint and now shared with wave scanning. ONE implementation
  deliberately: a barcode that counts against an order line has to count
  against the same product on the wave pick list, and two copies would drift
  the first time either learned something. The STEP ORDER is the documented
  rule and must not be rearranged — exact SKU (leading-zero tolerant) → NP
  suffix equivalence → packer-taught aliases → item-master barcode lookup.
  `resolveBeTimeCode2` still runs BEFORE it (official CODE2 listing, then
  learned barcodes); `matchScannedSku` takes both the raw and resolved value.
- `POST /api/waves/:id/scan` `{code, qty?}` — qty defaults to 1. Matches
  against the rows that still need pieces, **in walk order**, so a SKU
  stocked at two locations fills in the order the picker walks rather than
  arbitrarily. Caps at `total_qty` (never overshoots), flips `created` →
  `picking`, audit-logs `wave_pick_scanned` with BOTH the raw code and the
  SKU it resolved to.
- THREE distinct refusals, because they mean different things on the floor:
  404 `notInWave` (not on this pick list), 409 `alreadyComplete` (an extra
  piece in hand for a finished line — routine, and must NOT read as an
  unknown barcode), 409 `waveClosed` (completed/cancelled wave).
- Client: `#waveScanBar` on the wave detail, hidden once the wave is
  completed/cancelled. Uses the SAME global scan capture as the order and
  receiving screens — `_scanTarget` gained a third value `'wave'`
  (`_SCAN_INPUT_IDS` maps target → input id) so a gun firing while focus has
  drifted still lands. `openWave()` attaches it; **`backToList()` AND the
  `switchTab` hook (`waveUI.leaveDetail()`) both detach it** — miss either
  and the capture leaks into whatever screen opens next. The switchTab guard
  uses `window.waveUI?.` and not the bare const: `typeof` on a `const` still
  in its temporal dead zone throws rather than yielding "undefined".
- Feedback is an inline `.scan-feedback` line, never an `alert()` — a picker
  holding a gun must not have to dismiss a dialog between pieces.
- Camera scanning works here too: `openCameraScanner('wave')` +
  `dispatchCameraScan` routing, same pattern as inbound. Both trigger
  buttons wrap the call in an arrow function (passing the function directly
  would hand the click's MouseEvent in as the target argument).
- **QUEUE, NEVER DROP** (`_waveScanQueue` + `_drainWaveScans`). The first
  version guarded concurrency with a plain `if (_waveScanBusy) return`, which
  SILENTLY DISCARDED any piece scanned while the previous request was still
  open — a gun fires faster than the round trip, so with a 700ms endpoint a
  burst of 5 scans recorded **1**. No error was shown; the count was simply
  short. Now every scan is enqueued and drained in order, exactly like
  `handleItemScan`/`_scanQueue` on the outbound side. The drainer PEEKS rather
  than shifts, so a network failure leaves the piece in the queue, says
  "N scan(s) held, retrying…" and retries every 4s — the picker is never told
  to rescan something the system already has in hand. Proven both ways: the
  pre-fix code fails all 5 loss checks, the fixed code passes all 5 (5 rapid
  scans → 5 counted, screen and server agreeing; a failed scan held, not
  counted, then draining to 6 on its own once the network returns).
- Verified: 16 API checks (one scan = one piece, lowercase/NP tolerance,
  unknown → 404, cap at total, already-complete → 409, closed wave → 409,
  bad input → 400, auth required, audit type intact, **plus two regression
  checks that order scanning and teach-on-scan still behave after the
  matcher was extracted**) and 25 browser checks across phone and desktop
  (typed scan, gun burst with focus elsewhere, inline error with no dialog,
  rejected scan changes no count, capture released on tab change).

## Product Master (lib/product-master.js) — ULD_Product_Master_Template.xlsx

Adopted the client's real onboarding spreadsheet format as the Inventory
tab's rich-data schema, rather than inventing a separate format.

- `inventory.db`'s `inventory` table gained 21 columns (barcode, brand,
  model, unit/carton L×W×H + weight, fragile/contains_battery/
  serial_tracked flags, six Platform SKU cross-reference columns, storage
  remarks) — `PRODUCT_MASTER_COLUMNS` in `lib/inventory-store.js`, added via
  `ALTER TABLE` on `_open()` so an inventory.db that predates this template
  gains the columns without losing any row already in it (migration
  verified: a pre-existing row survives with correct new-column defaults).
- `lib/product-master.js`: `PRODUCT_MASTER_FIELDS` maps the EXACT Excel
  header text (e.g. `"Barcode (EAN/UPC) *"`) to the internal column name,
  matched by normalized header (lowercased, non-alphanumerics collapsed) so
  a re-saved copy with slightly different spacing/casing still parses.
  Y/N columns become 1/0; SKU + Product Name are the only truly mandatory
  fields — a missing Barcode is NOT an error (this app already has a
  no-barcode QR-substitute flow elsewhere, so a blank barcode is a normal,
  supported case, not a data problem).
- `GET /api/inventory/product-master-template` downloads a blank template
  (client's own sample row + the same Instructions sheet) generated by
  `buildProductMasterTemplateXlsx()` — byte-structurally identical to what
  the client already has, so round-tripping (download → fill in → import)
  always parses.
- `POST /api/inventory/import-product-master` (multipart XLSX, `upload.
  single('file')` + `tenantMiddleware` re-applied after multer — same
  reason every other multipart route in this app needs that: multer does
  not reliably propagate the AsyncLocalStorage tenant context) — parses,
  then upserts each row through the normal `inventory.upsert()`, so
  existing stock/reserved/pricing data on a SKU already in the catalog is
  never blanked by a Product Master re-import (only the columns present in
  the uploaded row are touched; `upsert()`'s defaults fall back to
  whatever's already on disk for that SKU, not the schema default, unless
  the SKU is brand new).
- Inventory tab UI: Barcode/Brand columns added to the list table; "⬇
  Product Master Template" / "⬆ Import Product Master" buttons next to the
  existing plain CSV import (unrelated — CSV import is `sku,name,category,
  stock_qty,...` for quick manual entry; Product Master import is the rich
  client-facing onboarding format).

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
at the depot) so the XLSX report and this tab can never disagree —
verified directly: seeded a driver with two delivered jobs at real Singapore
postal codes and confirmed the tab endpoint and the XLSX report compute the
IDENTICAL 16.4 km / 5 cartons / 2 delivered. `GET /api/drivers/performance`
(no date range = all-time) feeds the tab.

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

One driver identity, replacing an earlier broken predecessor and a second
disconnected driver-management surface (both fixed together — see below).

- **`db.drivers[]`** (the SAME roster Transport → Driver Details and
  `/api/drivers` use) gains an optional PIN: `pinHash`/`pinSalt` (hashed like
  any password), set via a "Driver App PIN" field on the shared Add/Edit
  Driver modal (blank on edit = keep current). `GET /api/drivers` never
  returns the hash — `hasPin: true/false` only; both Transport's and
  Administrator's driver lists show a 📱 badge when a driver can log in.
- **Real sessions, not a parallel auth scheme.** `POST /api/driver/login`
  `{id, pin}` verifies against `db.drivers`, then issues a token through the
  SAME `activeSessions` map every other login uses — namespaced
  `driver:<tenantId>:<driverId>` so it can never collide with a staff user
  id. One active device per driver, same rule as `/api/auth/login`.
  `requireDriverAuthMiddleware` does the token→driver lookup for every
  other `/api/driver/*` endpoint — the `/api/driver/` path prefix is exempt
  from the global `requireAuth` middleware (`AUTH_PUBLIC`), so each handler
  checks its own token.
  **Multi-tenancy gotcha fixed here**: `db.drivers[]` is tenant-scoped data
  (unlike `users[]`, which is global with its own `tenant_id` field), so a
  driver id alone doesn't say which tenant it belongs to — the app's
  general tenant-resolution middleware (which looks up a token's owner in
  the global `users[]` store) silently can't find a driver there and falls
  back to the default tenant, regardless of which tenant the driver
  actually belongs to. `POST /api/driver/login` searches every tenant's own
  `db.drivers[]` for the id (no tenant context exists yet at login) and
  encodes the resolved tenant directly into the session key,so
  `requireDriverAuthMiddleware` can re-establish the CORRECT tenant context
  for every later request with no repeated search (verified directly: two
  same-shaped drivers created in two different tenants only ever see their
  own tenant's jobs, never each other's).
- **Jobs come straight from `db.transport`** — no separate job store.
  `GET /api/driver/jobs` filters to `assignedDriver === <this driver>` and
  `status !== 'cancelled'`, keeps today's delivered stops visible for
  reference, sorts by `routeNum`/`stopSeq` (the planner's route order), and
  returns the SAME status wording/colors as the office UI
  (`driverStatusLabel()` — Staging/On the road/Delivered/Delivered w/
  Remarks).
- **Accept step.** A newly assigned job (`status:'confirmed'`, no
  `driverAcceptedAt`) shows as "🆕 New — Tap to Accept" in the app.
  `POST /api/driver/jobs/:id/accept` stamps `driverAcceptedAt` — a separate
  acknowledgment layer, NOT a status transition (status stays `'confirmed'`
  so it never interferes with the existing status lifecycle the office
  UI/reports depend on). `POST .../pickup` refuses (409) until a job has
  been accepted — a real gate, not cosmetic.
- **ePOD (electronic proof of delivery) — photo + GPS, both real.**
  `POST /api/driver/jobs/:id/photo` (multipart, `capture="environment"` on
  the client's file input triggers the phone's camera directly) stores the
  photo to `DATA_DIR/pod_photos/<jobId>/<photoId>.<ext>` — bytes never go
  into db.json, same reasoning as every other photo feature in this app.
  `POST .../deliver` REFUSES (409) until at least one ePOD photo exists —
  proof of delivery is a real requirement here, not optional. GPS is
  best-effort: the client calls `navigator.geolocation.getCurrentPosition()`
  right before sending the deliver request and attaches
  `{lat,lng,accuracy}` if it succeeds, but a denied/unavailable permission
  does NOT block the delivery — a hard block on a phone permission issue
  would strand a real delivery over something outside the driver's
  control, worse than a record with a missing coordinate. Stored as
  `job.podLocation = {lat,lng,accuracy,capturedAt}`.
  `GET /api/driver/jobs/:id/photo/:photoId` serves the photo to EITHER a
  driver (their own upload) or staff (office visibility) — a combined
  auth check re-resolves tenant correctly for a driver token the same way
  `requireDriverAuthMiddleware` does, since a plain `requireAuthOrToken`
  would hit the same tenant-resolution gotcha above. The office Transport
  delivery-detail modal (`openDeliveryDetail`) shows photo thumbnails and
  a "View on map" link for the captured coordinates whenever present.
- **Two more actions, ownership-checked server-side** (a driver can only
  move their OWN assigned jobs — 403 otherwise): `POST
  /api/driver/jobs/:id/pickup` (confirmed→in-transit, requires
  `driverAcceptedAt` set) and `POST /api/driver/jobs/:id/deliver`
  `{remarks,lat,lng,accuracy}` (→delivered; non-empty remarks = "Delivered
  w/ Remarks"). Both refuse to regress an already-delivered/cancelled job.
- **No embedded map.** `driver.html` has no map SDK — "Navigate" is a plain
  `https://www.google.com/maps/search/?api=1&query=` deep link (opens the
  phone's own installed maps app, no API key) and "Call Consignee" is a
  `tel:` link.
- **Administrator → Drivers is unified onto `db.drivers` too.** The old
  Admin-only "Add Driver" form and its `/api/master/drivers*` CRUD (a
  disconnected `users[role=='driver']` store nothing else ever read) are
  REMOVED entirely. "+ Add Driver" opens the SAME `#addEditDriverModal`
  Transport → Driver Details uses; the list re-fetches `/api/drivers`
  (`loadDrivers()`) and shows the same hasPin badge. Any driver added from
  either surface immediately can log into the Driver App and gets picked up
  by route planning — one identity, reachable from Admin, Transport, and the
  bulk CSV user import (see "Bulk CSV import" — a driver row's `password`
  column IS their PIN, validated 4-8 digits, and creates NO `users[]` record
  at all, only the `db.drivers[]` profile with a PIN).
  **Gotcha fixed along the way**: `#addEditDriverModal` used to be nested
  INSIDE `#tab-transport` — invisible (ancestor `display:none`) whenever the
  Administrator overlay was opened from any tab other than Transport. Moved
  to body level (like every other global modal).
- **`GET /api/drivers/export`** — the full roster as an XLSX (never includes
  `pinHash`/`pinSalt`, only a Yes/No "Driver App PIN Set" column).
- **Still separate, NOT unified**: the TMS Management → Drivers section is a
  third driver-management surface whose backend hasn't been audited —
  flagged here so a future pass folds it into `/api/drivers` too.

## Team inbound — split a receipt, finish it together

Per the user: before starting, a supervisor can mass-select lines and hand them
to colleagues, splitting again and again; everyone then scans, and the aim is to
finish the inbound as a team.

- **ASSIGNMENTS, NOT SKUs.** The same SKU arrives on several pallets and can go
  to several people — *"each inbound line split even if its same SKU is
  unique"*. So counting happens against `rec.assignments[]`
  (`{id, line_id, sku, qty, done, assignee, events[], notice}`), not against a
  SKU. **`state.scanned[sku]` REMAINS the derived per-SKU total**, so End
  Receipt, stock posting, the GRN, discrepancies and the client portal are all
  untouched: the split is a work-allocation layer, not a second source of truth
  for quantities.
- `POST /api/inbound/:id/split {assignee, items:[{line_id}], password}` —
  **ALLOCATION IS BY LINE, not by quantity**: a ticked line goes to one person in
  full (the endpoint reads a missing/zero qty as "everything still free on this
  line"). Repeatable, never over-allocates; a fully-allocated line is refused
  and shown as `assigned` rather than as a leftover number.
  `DELETE .../split/:assignmentId` undoes one, refused once pieces are counted.
  SAME-SKU MERGE — DECIDED, DO NOT "FIX": `parseInboundFile` merges same-SKU
  rows, so two pallets of one SKU arrive as ONE line of the combined qty, and
  by-line allocation sends both pallets to the same person. The user was offered
  the alternative (stop merging, so each file row becomes its own assignable
  line) and **chose to keep the merge**. The team still covers it the way the
  feature was designed to: anyone can scan anything, a colleague's piece still
  counts, and the owner is notified. So a merged line landing on one person is
  WORKING AS INTENDED — do not split the merge apart later thinking this is a
  bug.
- **PASSWORD + LEADER.** Splitting hands someone else responsibility for another
  person's goods, so the splitter re-enters their OWN login password
  (`verifyAdminReconfirm(req, {role:null})` — any signed-in user may lead, not
  just admins; the Administrator key also works). **403, never 401** — the
  session is valid, only the second check failed, and a 401 would trip the
  client's session-expired handler. Whoever splits first becomes `rec.lead` and
  owns the allocation from then on; anyone else is refused BY NAME. Audited as
  `inbound_lead_assigned`.
- **SCANNING fills the scanner's OWN outstanding assignment first**, then a
  colleague's — counted either way, because the point is to finish as a team,
  not to stop someone holding a box. A cross-scan appends to `assignment.events`
  and sets `assignment.notice` for the owner. Per the user this is a
  NOTIFICATION ONLY: the piece is already counted and nothing waits on
  acknowledgement (`.../assignment/:id/seen` is just a read receipt).
- Assignments fill ONE AT A TIME in order, so many pallets of the same SKU count
  incrementally and can never double-credit each other.
- **The one-receiver claim lock is relaxed ONLY when a job has assignments** —
  otherwise the second person to scan got a 409 and team receiving was
  impossible. An unsplit receipt is still protected.
- **`line_id` is assigned when the job is READ**, not as a side effect of
  calling `/split` — that side-effect version meant a client fetching the job
  first never saw an id and its first split always failed with "Unknown line
  undefined".
- SERIAL / BATCH / EXPIRY are optional on the scan. No inventory schema change
  was needed — `placeStock` already takes `lot_number` + `expiry_date` and there
  is a `serials` table; this was about CAPTURE. A serial is registered against
  the client immediately (waiting for putaway would lose which piece it was).

### Durability for team scans

`journalInboundState(id, state, assignments)` now carries a compact
`[{id, done, notice}]` snapshot. Assignments live on the RECORD, not on
`state` — without this a crash recovered the per-SKU totals but LOST who had
counted what, and a colleague would then be asked to scan pieces already
received. Replay takes the HIGHER count (same rule as wave picks: `done` only
grows) and caps at the assignment's qty, so a stale line can neither roll
progress back nor invent pieces.

The offline queue needs NO assignment id: the server resolves the allocation at
apply time and own-first is driven by the token's user, so a held scan replayed
later still lands on that person's own assignment. Verified — including that a
replayed `eventId` is deduped and double-counts neither the assignment nor the
SKU total.

Verified 38 API checks in total: 16 on split/team scanning/capture/audit, 10 on
the password + leader rules, 6 on crash replay (progress and the cross-scan
notice both survive; a lower or oversized journal line is ignored), and 6 on
offline replay attribution.

### The screens — split modal, colleague picker, and the strip the pill lives on

- **Split modal** (`#splitInboundOverlay`, 👥 Split button on each Inbound row):
  tick lines → choose a colleague → your password. Repeatable; shows "Who has
  what" underneath, and the leader is shown as a ⭐ pill on the list row.
- **The assignee is a PICKER, not free text** (`#splitAssignee`, a `<select>`
  fed by `GET /api/team`). The first cut was an `<input list=…>` with an empty
  datalist, so a typo'd id created an assignment nobody would ever see.
  `/api/team` is deliberately NOT master-gated — the people who split a receipt
  are warehouse staff, and the master-gated `/api/master/users` would be a 403
  for them. It returns `{id, name, self}` ONLY (no roles, features, hashes or
  salts), excludes drivers, and sorts the caller last. The client also rejects
  anything not on that list before sending.
- **TEAM STRIP** (`#inboundTeamStrip`, under the meta pills on the receiving
  screen). This is where the cross-scan pill the user asked for actually has to
  appear — the first cut only rendered it inside the leader's Split modal, i.e.
  never on the screen the person being notified is standing in front of. Shows
  "Your lines" first with `SKU done/qty`, then each colleague's totals, and an
  orange pill "<who> counted N for you ✕" that dismisses to `.../seen`.
  Only rendered when the receipt has assignments — an unsplit receipt looks
  exactly as it did before.
- **`GET /api/inbound/:id/team`** is a deliberately small poll target
  (`{assignments, lead, me, scanned, status}`) run every 6s WHILE the receiving
  screen is open and only for a split receipt — that poll is what makes the
  other person's pill appear by itself rather than at their next scan. It also
  carries the receipt's running `scanned` totals, because on a shared job the
  Received column is only correct if a colleague's pieces show up too (the strip
  read 3/4 while the table below it still said 2). It does NOT overwrite the
  table while that device is holding offline scans — the server doesn't know
  about those yet. Stopped on back, on End Receipt, and whenever the open job
  changes.
- **BUG FOUND BY THIS TEST — the cross-scan message was being overwritten.**
  `inboundScan` wrote "counted for <colleague>" into the feedback line, then a
  few lines later the generic `else showFeedback('success', 'N received')`
  clobbered it, so the person who picked up someone else's item was never told.
  The note is now held in `crossMsg` and APPENDED to whichever outcome line
  fires (normal, damaged/KIV, cross-dock).

Verified 24 browser checks with TWO REAL BROWSERS receiving the same split
receipt at once (whguy on desktop, demo on a Pixel 5): simultaneous scans each
fill their own line, a cross-scan still counts and raises exactly one notice,
whguy is told whose it was, the pill appears on demo's phone by itself, so does
the updated Received column, dismissing is a read-receipt that moves no count,
demo can finish whguy's line, an extra piece never pushes an assignment past its
qty, and the ten pieces scanned across both browsers all reconcile. Plus 18
checks on the picker (only real colleagues offered, self marked "(you)", no
made-up id can even be set on the control, wrong password refused without a
reload) and 11 regression checks (an unsplit receipt shows no strip and no team
wording; a held offline scan survives the poll and drains to exactly one piece
on the right assignment).

### Correcting a received count — editable until End Receipt

Per the user: *"allow editing of qty, unless one closes it."* `POST
/api/inbound/:id/setqty` — the Received figure on the receiving screen is an
input, not text, for as long as the receipt is open.

**End Receipt is the one hard boundary, and it is the right one**: that is the
moment the units become sellable stock, the discrepancies are frozen onto the
record and the GRN goes to the client. Before it, nothing downstream has been
told anything, so a correction is free; after it, three things would disagree.

- **ABSOLUTE set, not an adjustment** (same as outbound's `/api/scan/setqty`) —
  the receiver reads a number off the screen and types what it should say.
- **Everything that must agree with `state.scanned` moves by the DELTA**: the
  condition breakdown, the carton breakdown, the team assignments, and any
  serials captured in error. `applyCartonDelta` spreads a reduction over the
  most recent cartons — calling `addToActiveCarton` with a big negative would
  clamp at zero inside ONE carton and silently leave the breakdown short.
- **`condition` changes what the number MEANS, deliberately.** Without it, `qty`
  is the TOTAL and the change lands on the good count; damaged/KIV are
  photo-gated evidence and a plain total edit must never quietly erase them, so
  a reduction below them is refused with the numbers named. WITH it, `qty` is
  that bucket's absolute value and the total is re-derived — "set damaged to 1"
  is what someone means; making them compute a new total to get there would be a
  puzzle, not a correction.
- **SERIALS are only unwound on a genuine contradiction** — when the serials
  captured for a SKU outnumber the corrected total. 3 serialised units among 14
  is consistent, and removing one would be inventing a fact about which physical
  unit left. `inventory.removeSerials()` (new) never touches a serial already
  **shipped**: that unit really left the building.
- Refused while the device holds **offline scans** (the number on screen is not
  the number being corrected — same reasoning as End Receipt), and behind the
  same claim lock as scanning. Audit-logged `inbound_qty_corrected` with from,
  to, delta, condition and reason.
- The client commits on **blur/Enter, never on input** — typing "40" over a "2"
  would otherwise fire a correction to 4 on the way past (asserted: one request,
  and it lands on 40).

**An over-receipt no longer reads as a finished line.** `received >= expected`
took the same `status-done` green as a correct count, so 11 of 10 looked exactly
like a job well done — reassuring at the one moment it should not. It now has
its own amber `.inb-over` row and a "+N over" pill.

Verified 33 API checks (the correction reaching cartons/conditions/assignments/
serials, the damage refusal, a barcode fired into the box, the split-receipt
case where an assignment must follow the count down and back up, a shipped
serial left alone, and the close-then-refuse boundary) plus 15 browser checks on
desktop and a Pixel 5.

### An over-receipt is told at the SCAN, not discovered at End Receipt

The discrepancy used to surface only at End Receipt, by which point the pallet
is broken down and nobody can say whether it was a miscount or the supplier
genuinely sent more. `/api/inbound/:id/scan` now returns `over` — `{expected,
scanned, by, justCrossed}` — whenever a line passes its expected quantity.

- **NEVER BLOCKED.** Receiving more than the paperwork says is routine, and
  refusing the scan would push people into not scanning at all, which is a
  worse number than a wrong one. The piece is counted either way (asserted).
- **`justCrossed` is the scan worth interrupting for.** After that the receiver
  already knows, so the line drops to a quiet "⚠ 2 over the expected 3"; a
  repeated shout is noise. The crossing warning holds for 12s rather than the
  default 3.5s, since a receiver mid-carton will not have read it otherwise.
- **A LINE THAT LANDS EXACTLY IS NOT AN OVER-RECEIPT**, and a SKU that is not on
  the paperwork at all is a different thing entirely — already reported as an
  extra, and calling it "over" against an expectation of zero would be
  nonsense. A RETURN has no expected list, so nothing there can ever be over.
- This is IN ADDITION to the End Receipt discrepancy prompt, not instead of it
  (asserted: End Receipt still 409s naming the line).

Verified 18 API checks (nothing at 1, 2 and exactly 3 of 3; the fourth flagged
as the crossing scan with both numbers and still counted; the fifth flagged but
no longer crossing; a keyed qty of 5 against an expected 2 crossing in one go;
an unlisted SKU and a return both exempt; End Receipt unchanged) plus 20 browser
checks on a Pixel 5 and desktop (the loud line, its wording, its error styling,
the Received box really reading 4, the row's `inb-over` class and its "+1 over"
pill, and the quieter fifth).

TEST GOTCHA, cost a run: resetting a receipt by writing db.json under a running
server does nothing — it holds the db in memory. Reset through the API
(`/setqty`), and re-authenticate first, since one active device per user means
the browser signing in as demo invalidates the harness's token.

### Mass receive — accepting the paperwork, and saying so

Per the user: an admin can select receipts and receive them in one go, with the
GRN generated and made available. `POST /api/inbound/mass-receive`
`{ids[], end, reason}`.

**A MASS RECEIVE IS NOT A COUNT, and the system never pretends otherwise.**
Every line is set to the quantity the PO declared; nobody has handled those
pieces. So it is recorded as `state.declared[sku]`, the GRN prints
**"Accepted as declared"** (or "Part scanned, part declared") against those
lines, and it is audit-logged under its own event `inbound_mass_received` with
who, why and how many. A GRN that presented an accepted figure as a scanned one
would be a document that cannot be trusted, which is the opposite of its job.

- **ADMIN OR MASTER**, enforced server-side (`requireInboundAdmin`) — accepting
  stock nobody counted is a commercial decision, not floor work. Warehouse gets
  a real 403 and the ticks are not rendered for them.
- **Never reduces a line.** A SKU already counted ABOVE its declared quantity
  keeps the higher figure — a real over-receipt is not erased by accepting the
  paperwork.
- **Completed receipts are refused**, the standing rule.
- **The claim lock is OVERRIDDEN, but never silently.** An admin's normal case
  is "the crew counted part of it, accept the rest", and the lock stays warm for
  20 minutes after anyone's last scan, so obeying it would make the feature
  unusable exactly when it is wanted. Whoever held it is named in the response
  and on the audit trail (`takenFrom`), and the claim is handed over.
- **Ending is still a separate step**, and it goes through the REAL
  `/end-receipt` route one job at a time rather than a second copy of that
  logic — so the compulsory-photo rule and every other guard apply exactly as
  they do to a hand-received job. A refusal is reported against that receipt,
  not swallowed. (In practice a clean mass receipt has no discrepancy, so no
  photo is demanded.)

### The GRN — who received it, when, and a blind Location column

`grnData()` gained `receivers[]`, `generated_at`, and a per-line `via`:

- **`received_by` alone was wrong on a split receipt** — it is whoever pressed
  End Receipt, one name out of several. `receivers[]` lists everyone who counted
  a piece with their piece count and first/last touch, taken from the scan log
  that already recorded it. Both are shown: "Received by … · Closed by …".
- `started` / `ended` were already captured; they are now stated on the printed
  sheet and the download in SGT, alongside when the document itself was made.

**`GET /api/inbound/:id/grn/export`** is the downloadable worksheet the putaway
crew carries: the header block above, every line, and **Location (write in) /
Qty put away / By / Time left BLANK**.

THE BLANK COLUMN IS THE POINT. It is a fallback for a flat phone or a bin label
that will not read, and pre-filling it with the system's SUGGESTION would
produce a sheet that says where goods ARE when it only ever said where they
might go — and someone would later file it as evidence of a putaway that never
happened. Anything written on it still has to go through the Putaway screen to
move stock: this sheet is a worksheet and a receipt, never a posting document.

UI: an admin-only tick column on the Inbound list with a select-all, a
mass-receive bar that states what it does before you press it ("nobody counts
these pieces"), and a ⬇ GRN button on every closed receipt. The selection is
held in a Set and re-applied after each render — same reasoning as the
bulk-deletion tables, since the list refreshes on a timer. `authDownload` needs
the filename passed in: it builds a blob URL, which carries no name, so the
server's Content-Disposition is lost and the crew would collect a folder of
"download.xlsx".

Verified 23 API checks (warehouse 403s and changes nothing, lines set to the
declared figure, a part-counted line reads as part declared, the GRN names
everyone who handled it, started/ended both present and the right way round, the
sheet's Location cells all blank, a closed receipt refused, the audit trail
carrying who and why) plus 16 browser checks on desktop and a Pixel 5.

## Stock is allocated at INTAKE and depleted at COMPLETION — on every path

Per the user: orders arriving by upload OR by sync must allocate the SKU's
quantity; a shortfall must ask the client to drop those orders or abort; ground
locations are depleted before racks; and the units sit **Reserved** until
scanning completes, with the record visible in outbound reporting on both the
office and client sides.

### One gate, four doors

`checkIntakeStock(clientId, orders)` and `reserveIntakeOrders(...)` are used by
ALL FOUR ways an order can arrive — file upload, photo scan, store sync, and an
approved client-portal submission. Four copies would drift, and the first thing
to drift would be whether stock was reserved at all.

**TWO OF THOSE PATHS PREVIOUSLY RESERVED NOTHING.** A photo-scanned picking list
and an approved client submission both created their batch with no
`inventory_tracked` flag, so they reserved nothing at intake and — because the
deduction is gated on the same flag — deducted nothing at completion. They
looked identical to a tracked order on the Orders tab and moved no stock for
their whole life. Both are wired now.

`checkIntakeStock` reserves NOTHING; it reports what a reservation *would* do,
so the answer shown before approving is the answer the reservation gives.
Availability is judged **cumulatively across the file**: two orders for the same
SKU compete for one pool, and a per-order check would pass both and then short
the second at reserve time.

### The shortfall prompt — drop, or abort

`/api/upload` returns 409 `{needsStockDecision, shortOrders[], okCount,
shortCount, unknownSkus[]}` naming each order and, per line, what it needs
against what is free. The uploader chooses:
- **drop** (`stock_action=drop`) — the short orders are removed and the rest
  goes through; the response carries `droppedShortOrders` and the client says
  which were left behind BY NAME, because a silent drop looks like the file
  simply had fewer orders in it. Audit-logged `upload_short_orders_dropped`.
- **abort** — the client simply doesn't resend. Nothing was reserved, so the
  account is exactly as it was.
- `stock_action=proceed` exists as a deliberate override; the shortfall still
  becomes a backorder so it stays visible.

A SKU not in the item master is created at zero rather than being skipped — the
old behaviour let such an order go untracked, which is the gap being closed.

### Picking priority — ground before racks, but rotation first

`binLotsForSku` orders lots by:
1. dated lots before undated, nearest expiry first (**FEFO — not a preference**)
2. **ground before rack** (`wl.tier`)
3. pick face before bulk
4. oldest received first

The user's instruction was *"always deplete from ground first … IF THERE IS A
CHOICE"*, and that last clause is the design. FEFO leads because sending a
later-expiring floor unit ahead of a sooner-expiring rack unit ships the wrong
lot and eventually ships expired stock. For ordinary non-perishable goods every
expiry is NULL, so step 1 ties and the FLOOR genuinely wins — the case this was
asked for. Under FIFO the received date leads, for the same reason.

### Reserved → depleted, and where the record lives

Reserving moves units from available into reserved; **on-hand is unchanged**
until `/api/scan/complete` runs `deductOrder`, which deducts the stock and
releases the reservation together (guarded by `state.inventory_deducted` so an
offline replay cannot double-deduct). Cancelling releases instead.

`inventory.outboundMovements(clientId, {from, to})` reads the reserve / release
/ outbound rows from `stock_movements` — the ledger those three write to — and
is shared by:
- **Office**: `GET /api/master/report/outbound-stock` (in `ADMIN_REPORT_KINDS`)
  — an "Outbound Stock" sheet of every move plus a "By Order" sheet that
  reconciles reserved − released − shipped = still reserved.
- **Client portal**: `GET /api/portal/movements` on screen and
  `/api/portal/export/movements` as XLSX, in the client's own words ("Reserved
  for your order", "Shipped — stock deducted") with a line explaining what
  Reserved means.

Verified 22 + 18 checks: an ordinary upload reserves silently, the ground bin is
picked before the rack, a short order stops the upload naming the numbers,
aborting reserves nothing and creates no order, dropping uploads only the
covered ones, two orders competing for one pool flag only the second, completion
depletes on-hand and releases the reservation, a photo scan and an approved
client submission now both reserve and deplete, and both the office report and
the client's own record reconcile.

GOTCHA: `outboundMovements` joins `inventory`, which ALSO has a `client_id`, so
an unqualified `client_id` in the WHERE clause made the whole query ambiguous
and SQLite refused it. The `catch` around it was silent, so the report came back
empty — indistinguishable from a quiet month. It now logs.

## Put away by file — a whole stock position from a spreadsheet

`POST /api/putaway/import` (multipart + `client`) takes the shape a warehouse
already exports — **SKU / Location / quantity**, e.g. the client's own
`MAYER_INVENTORY_AS_ON_300726.xlsx` (`S/No, SKU, Packing, Description,
Location, Barcode, AVailable LHU`) — and bins the lot in one action instead of
keying it bin by bin. Used for opening stock at onboarding and for a stock-take
correction afterwards. Headers are matched loosely (`pick()`), so `Available
LHU`, `Qty`, `On hand` and `Balance` all resolve.

- **BY DEFAULT IT PROPOSES, IT DOES NOT WRITE.** Per the user, the locations in
  the file are *reflected into the open inbound job*: the bins are filled into
  the Putaway form on the matching staging rows and the lines are ticked, with a
  banner saying how many were filled and that nothing has moved. The crew then
  **completes the putaway** (which increments the bins, through the same
  `/api/putaway/bulk` the manual path uses — one receipt at a time, over-put
  guard and all) or **aborts**, which clears the form and does nothing. A SKU in
  the file that is not waiting to be put away is reported, never silently
  binned. `apply=positions` is the explicit opt-in for OPENING STOCK, where
  there is no inbound job to reflect into.
- **THE QUANTITIES ARE ADDED**, per the user — a putaway file is a delivery
  being binned, not a stock-take. `mode=set` still exists for a genuine
  stock-take and is what the old default was.
- **THE CLIENT IS PICKED FROM A DROPDOWN, NEVER TYPED** (`GET /api/putaway/clients`,
  which lists the names actually in use with what each already has). "Mayer" and
  "Mayer2026" are DIFFERENT accounts — case folds, a suffix does not — so a
  typed name is exactly how a whole delivery ends up in a phantom client whose
  stock no order can ever find.
- Because adding makes a double-upload expensive, **the same FILE re-sent is
  caught by content hash** (`db.stockImports`) and confirmed rather than waved
  through: "This exact file was already put away for X on <date> (186 pcs).
  Uploading it again ADDS those quantities a second time." A genuine second
  delivery just confirms. A bin is TOPPED UP rather than growing a lot row per
  upload.
- **Bins named in the sheet are CREATED** if they do not exist — the racking is
  physically there and the sheet is what tells us about it — but the count comes
  back (`binsCreated`) so a typo reads as "47 new locations" rather than
  vanishing into the map. Tier is stamped from the grammar as usual.
- SKUs missing from the item master are created from the sheet, taking the
  description and barcode with them.
- **`reserved_qty` is left alone.** A reservation belongs to an order, not to a
  stock count; clearing it would un-promise units already sold.
- ADMIN OR MASTER (`requireInboundAdmin`): this rewrites a client's whole shelf
  position in one action. Audit-logged `stock_positions_imported`.

Verified against the client's real file: 37 rows, 36 SKUs, 186 units, 8 bins
created, each SKU landing in exactly the bin the sheet names with the barcode
and description carried across; re-sending the same file is refused and changes
nothing, confirming it adds to 372 in one lot row per bin, `mode=set` puts the
position back; and an order against that stock then reserves 2, points its pick
list at the bin the sheet put it in, and on completion deducts on-hand AND the
bin lot while releasing the reservation. 27 API checks + 13 browser checks, plus
16 API + 11 browser checks on the propose-then-complete-or-abort flow (nothing
moves until Put away is pressed; aborting clears the form and leaves all 10 pcs
waiting; completing bins them into exactly the bin the file named).

UI GOTCHAS worth keeping: the import banner is a SIBLING of the list, so
`render()` does not remove it — abort has to take it out explicitly or it
outlives what it describes. And a file input whose `value` is never cleared
fires NO change event when the same file is picked again, so a second upload of
the same sheet silently never armed the button.

### Undoing a stock upload that bypassed Inbound (Inventory tab)

Reported: staff loaded stock straight in from **Inventory → ⬆ Upload stock
file** instead of receiving it through Inbound, and there was no way back.
Correct — that is a DIFFERENT route from the mass putaway upload
(`/api/inventory/import-file`, not `/api/putaway/import`), and it kept **no
snapshot and no transaction record at all**, only an audit line with counts.
The harder-to-reach uploader had a 3-day reversal; the easier one had nothing.

- It now writes the SAME kind of `db.stockImports` record, tagged
  `source: 'inventory'`, with a per-SKU before-snapshot and the same 3-day
  window — so `reverseStockPositions` undoes it with no second implementation.
  `cells: []` because this route writes on-hand figures directly and never
  touches bins; the reverser restores exactly what it finds.
- **THE LEDGER MARK IS TAKEN AFTER THE WRITES, NOT BEFORE.** Taking it early
  made the import count as its own movement, so every undo asked to skip every
  SKU it had just touched. (`setStockPositions` had this right; the new code
  had to match it. Caught by the test, not by reading.)
- **The list sits directly under the uploader** (`#invImportsRecent`), not on
  the Putaway tab — that is where the mistake is made and where somebody will
  look for the way out. It follows whichever client is loaded.
- **Finish-supersede refuses these** — that action rebuilds a position from the
  bins a sheet named, and this upload named none. Said in words rather than
  doing something odd.
- A SKU the upload CREATED is removed again on undo (existing
  `reverseStockPositions` rule), so the catalogue is not left with phantom rows.

**AN UPLOAD MADE BEFORE ANY OF THIS STILL HAS TO BE UNDOABLE** — the one the
floor is actually asking about already happened, so a fix covering only future
uploads does not answer the question. It is not lost: each SKU the uploader
topped up wrote a `type='upload'` movement carrying **the delta**, so the ledger
itself says what to give back. `ledgerUploads()` groups those by minute (one
upload writes its rows within a second or two) and `reverseLedgerUpload()`
hands each back with its own compensating movement, so the ledger keeps both
halves rather than pretending the upload never happened.
- **NEVER BELOW ZERO**: a SKU that has shipped since floors at what is left, and
  the shortfall is reported by name (`added` vs `could_take`).
- **HONEST LIMIT, REPORTED NOT HIDDEN**: a SKU the upload CREATED went in
  through `upsert`, which writes no movement row, so the ledger cannot say how
  much of its stock came from that upload. Those are NAMED for a human to set,
  never guessed at.
- Shown as a dashed row marked "(before uploads were tracked)", so the rougher
  recovery is never mistaken for the exact one.

**THE SAME GOODS BOOKED TWICE — receipt AND upload.** Reported next: on hand
went to double, "one set from our upload, and another from the inbound". Both
are real postings and either could be the one to keep, so the list shows BOTH
kinds and the administrator removes whichever is the duplicate:
- **File uploads** grouped by minute (one upload writes its rows within a
  second or two and has nothing else to key on).
- **Inbound receipts** keyed by the receipt itself — `Receipt IB-260817-01`,
  which the End-Receipt posting already writes as the movement reason. Better
  than a timestamp: it names the job the stock came in on.
- **IT BACKS OUT A STOCK POSTING; IT DELETES NOTHING ELSE.** An inbound receipt
  really happened — the goods arrived and were counted — so the receipt record,
  its GRN and its trail are left exactly as they are, and the note says so. What
  is being corrected is the stock having been booked twice. (Asserted: the job
  is still there and still `done` afterwards.)
- Admin or master; warehouse gets a real 403 and changes nothing.

**BOTH POSTINGS WERE TAKEN OFF AND THE CLIENT LANDED ON ZERO.** Reported from a
live screen: on hand **0**. Each undo was individually correct — it gave back
exactly what its own posting added — but nothing stopped the second one and
nothing offered a way home. Both halves of that were the bug:
- **ONCE PER POSTING.** `db.undoneLedgerPostings[client|kind|key]` records the
  take-off; asking again is refused (409) naming **when and by whom**, and the
  row is shown on the list as "already taken off" rather than offering a button
  that must not be pressed. Giving a posting back twice removes stock that was
  only ever booked once.
- **A TAKE-OFF IS ITSELF UNDOABLE.** `reverseLedgerUpload` now captures a
  before-snapshot and the route stores it as its own `db.stockImports` entry
  (`source: 'ledger-undo'`, 3-day window), so it appears on the same list with
  **⎌ Put the stock back**. An undo with no way back is a one-way door, and the
  floor walked through two in a row.
- **A TAKE-OFF MADE BEFORE ANY OF THIS IS STILL RECOVERABLE.** The live site was
  already on zero when the snapshot shipped, so there was no put-back record —
  but a take-off writes a compensating NEGATIVE adjustment per SKU, which is all
  that is needed. `ledgerUploads` surfaces those as a `takeoff` kind, matched on
  the reasons this system writes (never on negative adjustments in general: a
  hand correction someone made on purpose is not something to offer to reverse).
  **No sign flip** — the rows are already negative, so reading them as they
  stand makes the same code add the stock back; a flip was tried first and
  silently took MORE off.
- **PUTTING IT BACK RE-ARMS THE POSTING IT UNDID** — the marker is cleared (for
  a pre-snapshot take-off, by parsing the key back out of the reason it wrote),
  so the correction is not a dead end. Without this the stock would be restored
  while the posting stayed marked as given-back, and the double could never be
  fixed after one wrong move. (Asserted end to end: take off → refused twice →
  put back → takeable off again → lands on the right figure.)

**REMOVING A ROW FROM THE LIST** (`DELETE /api/putaway/imports/:id`) is
housekeeping, not a stock action — the stock is untouched and the AUDIT LOG is
never what gets tidied.
- **THE TRAP IT GUARDS**: while a record is still reversible it is the ONLY
  route back — its before-snapshot lives on it and nowhere else. Deleting one in
  that state is refused unless the caller says plainly that is what they want
  (`force: 'yes'`), and the trail records `gaveUpUndo`.
- **THE LEDGER ROW IS DEDUPED AGAINST REAL UPLOADS ONLY.** A take-off record
  landing in the same MINUTE as the upload it undid was hiding that upload from
  the list — precisely the row somebody needs to see. Found by rendering the
  page and reading it, not from the API, which was correct all along.
- **A LEDGER ROW IS HIDDEN, NEVER DELETED** — it is derived from
  `stock_movements`, and erasing rows out of the ledger to tidy a list would be
  destroying the record. The dismissal is stored beside it instead.

**TWO MOVEMENT TYPES WERE UNCLASSIFIED** and turned up while looking at this —
`upload` and `quarantine_release`. Both are account-level and were counting in
client statements with nothing saying what they were. Classified. That is
`unclassifiedMovementTypes()` doing exactly the job it was built for.

Verified 18 API checks on the new-upload path (a txn id and a stated window, is
listed and tagged, undoes back to the exact prior figures, deletes the SKU it
invented, refuses a second undo, on the audit trail), 18 on the ledger recovery
(the transaction record genuinely removed first, so it is the pre-tracking case:
the ledger still finds the 250 pcs, gives them back, names the created SKU
instead of guessing, floors a shipped-since SKU at zero and reports the
shortfall by name) plus 14 browser checks on desktop and a Pixel 5.

TEST GOTCHA: one active device per user — a browser signing in as `demo`
invalidates an API token held by the test harness, so a seeder that runs
between browser contexts must re-authenticate.

### Mass ADD / SUPERSEDE / REDUCE — preview-confirm + 3-day reversal

Per the user: uploading inventory, new account or old, is a CHOICE — add on
top, supersede the position, or reduce (write-off list) — with errors flagged,
a confirm before anything moves, a 3-day window to reverse cleanly, and an
audit trail that reads as the mass action it was, with who did it.

- The upload overlay has FOUR radio modes: fill-the-putaway-job (the old
  propose flow, still default), mass ADD, mass SUPERSEDE (`mode=set`), mass
  REDUCE. Supersede/reduce force the direct path (`wantsDirect`).
- **SUPERSEDE MEANS THE FILE IS THE POSITION — the whole position.** Reported
  live: 740 pcs uploaded as a supersede and the screen still read **844**. The
  old `mode=set` cleared only the (sku, bin) **cells the file happened to
  name**, so stock in any other bin, and every SKU the file did not mention,
  survived untouched. That is not superseding anything; it is a per-cell
  overwrite wearing the word. A supersede is a stock-take, so now every SKU the
  client holds is cleared first: those in the file are filled from it, those
  absent go to **zero** and are **reported by name and quantity**
  (`out.zeroed`, `out.zeroedUnits`) — a count that quietly leaves stock behind
  is worse than no count.
  - **THE SNAPSHOT COVERS EVERYTHING IT CLEARS**, not just the named cells, or
    the 3-day reversal would have a hole exactly where the behaviour is most
    destructive. Asserted: reversing restores the full 844 including the SKU
    the file never mentioned.
  - **THE PREVIEW STATES THE ARITHMETIC** — `currentTotal → afterTotal`, plus
    the SKUs about to be zeroed listed by code. "740 pcs" reads as an addition;
    without the before/after the missing 104 is a surprise, which is exactly
    how this was found.
  - **ADD is untouched** and still additive (asserted) — a delivery being
    binned is not a stock-take.
  - **FINISHING A HALF-DONE ONE WITHOUT THE FILE**
    (`POST /api/putaway/imports/:id/complete-supersede`, admin or master). Per
    the user: *"adjust it now without any reuploading."* A supersede run under
    the old rule left the rest of the position standing, and the sheet is long
    gone — but the transaction's snapshot recorded exactly which cells it
    touched, so `supersedeRowsFromSnapshot()` rebuilds what the sheet said from
    those cells as they stand now. It then runs the ORDINARY corrected
    supersede against them, so this is not a second way to write stock: same
    preview, same confirm, same reporting, same 3-day reversal, and its own
    entry on Recent stock uploads.
    - **`whole_position: true` marks supersedes run under the corrected rule.**
      Their snapshot covers everything they cleared rather than just the named
      cells, so rebuilding from it would mean something entirely different —
      they are refused ("already replaced the whole position") and the button
      is not rendered for them. This distinction is the whole reason the marker
      exists; without it the feature would silently do the wrong thing to every
      supersede made from now on.
    - **STOCK THAT MOVED SINCE IS REAL WORK, NOT LEFTOVER** — a receipt or a
      pick after the upload is legitimately outside the sheet. `movedSkusSince`
      names those SKUs in the confirm, because this will overwrite them.
    - Runs once (`completed_at`), audited `stock_mass_supersede_completed`.
    - UI: **↻ Finish supersede** on the Recent stock uploads row.
- **PREVIEW-CONFIRM**: without `confirm_apply=yes` the route answers 409
  `{needsApplyConfirm, preview}` computed by `inventory.previewStockPositions`
  — rows/units/SKUs, new SKUs and bins that would be created, ERROR rows
  (missing fields; on reduce also unknown SKU / missing bin), and reduce
  SHORTFALLS (bin holds less than the sheet subtracts — floored at zero,
  never negative). The client confirms against those numbers, which are
  computed the same way the write computes them.
- **REDUCE never invents**: an unknown SKU or missing bin is an error row,
  not a create-then-subtract-from-zero.
- **3-DAY REVERSAL** (`STOCK_IMPORT_REVERSE_HOURS` = 72):
  `setStockPositions` returns a before-`snapshot` (each touched (sku,bin)
  cell's exact lot rows + each SKU's on-hand + `asOfMovementId`, the ledger
  high-water mark when the import finished). Stored on the `db.stockImports`
  txn with `reversible_until`; `pruneStockImportSnapshots` drops expired /
  used snapshots so db.json never carries them forever.
  `POST /api/putaway/imports/:id/reverse` restores the snapshot —
  import-created SKUs are deleted again only if nothing else gave them stock.
  **CLEAN means clean**: `movedSkusSince` (reserve/release excluded — they
  move no piece) refuses 409 naming SKUs that physically moved since;
  `skip_moved=yes` reverses the rest and leaves those exactly as they are.
  Past the window → 410, permanent. Already reversed → 409.
- **AUDIT names the act**: `stock_mass_added` / `stock_mass_superseded` /
  `stock_mass_reduced` / `stock_mass_upload_reversed`, each with `by`.
- UI: Putaway → "Recent stock uploads" (`#paImportsRecent`) — one row per
  mass upload with mode, client, file, units, who, and a ⏌ Reverse button
  showing hours left; reversed rows say when and by whom.

Verified 30 API checks: preview writes nothing and flags the bad row, add
lands and reverses to exactly nothing (created SKU removed), supersede
replaces only listed bins, reduce subtracts with unknown-SKU error +
shortfall flag, a hand adjustment after the upload makes the reversal refuse
BY NAME then skip_moved preserves the adjusted figure, double-reverse
refused, and all four audit event types present with the operator's id.

## A text field must never render a raw JavaScript Date (`textVal`)

From a photo of the scan screen: a BETIME line showed
**`Lot Sat Oct 28 2028 00:00:00 GMT+0000 (Coordinated Universal Time)`** where a
lot code belongs, with the correct `Exp 2028-10-28` right beneath it.

XLSX parses a date-formatted cell into a **Date object**, and `mapRow` wrapped
every text field in a bare `String()` — so `String(someDate)` put the full JS
date string in front of a packer. The GI Analysis export's `BatchNo/LotNo`
column is date-formatted on some lines, which is how it surfaced; but the
exposure was in all 17 text fields, not just that one.

`textVal(v)` replaces `String(v)` throughout `mapRow`: a Date becomes a plain
`YYYY-MM-DD`, everything else is trimmed as before. Note `expirydate_lot1` was
NEVER in the batch chain — the column name containing "Lot" was a red herring;
the date really was in the batch column.

The screen also stopped repeating itself: a **Lot badge is suppressed when it
only echoes the expiry**, which is both noise on a phone-width row and how one
value came to be shown twice, once mangled.

**THE WORK ALREADY ON THE FLOOR IS HEALED TOO.** Fixing the parser only helps
the NEXT upload, so `repairStoredDateStrings(db)` runs at boot and rewrites any
stored field holding a JS date toString to a plain calendar day, across order
lines and inbound lines. Deliberately conservative — it matches only the
unambiguous `Www Mmm DD YYYY HH:MM:SS GMT±ZZZZ` shape, so nothing a human typed
can be caught. Audit-logged `stored_dates_repaired`; a no-op once clean
(verified by restarting: 0 repairs on the second boot).

Verified 9 checks on the exact failing shape (a Date in BatchNo/LotNo becomes
`2028-10-28`, the expiry still reads right, a normal lot code like `W0492A` is
untouched, and no field on the row leaks a `GMT+0000` string) plus 11
regression checks on the client's real 283-line export and a plain
SKU/Quantity file — same 283 lines, same 93 orders, every expiry a calendar
day, every lot intact. Plus 8 checks on the boot repair against a seeded copy
of the live state: the mangled lot becomes `2028-10-28`, the expiry and the
rest of the line are untouched, a real lot code (`W0492A`) and human-typed
remarks are untouched, inbound lines are repaired too, and no `GMT+0000` string
survives anywhere in the database.

## A pick list must never ask a bin for more than it holds (`newPickClaim`)

Reported from the floor: SKU `FS1605XXXXBKML` sat 24 in `AA-013-003-A` and 6 in
`AA-015-002-A`, and the wave pick list **asked AA-013-003-A for 28** while the
second bin was never visited.

**`allocatePick` IS STATELESS.** It reads `bin_lots` and decrements nothing, so
every call starts again from the full pool. Any caller that calls it more than
once for one SKU in a single planning run promises **the same physical units
twice**. Reproduced exactly: two calls for 24 then 4 both returned
`AA-013-003-A`, totalling 28 against a bin holding 24.

Three callers did exactly that:
- `enrichWaveWithBins` — one call per wave pick row, and a SKU printed at two
  locations becomes two rows.
- `allocatePickLocations` — one call per order LINE, so a batch with the same
  SKU across many orders over-promised the same bin to all of them. **This one
  affected every order pick list, not just waves.**
- the bin-empty re-allocation — one call per line of the SKU being re-picked.

`inventory.newPickClaim()` returns a `Map(lot_id → units already promised)`;
`allocatePick(..., claimed)` starts each lot from `qty − claimed` and adds what
it takes. One ledger per planning run, threaded through all three callers.
**Per RUN, not global** — planning still decrements nothing, so the next run
sees the real shelf; a stale ledger could never strand stock.

Verified 11 unit checks (the reported 24+4 splits correctly and the second bin
is finally used; 34 wanted against 30 on the shelf over-asks nothing and
reports an honest shortfall of 4; ten orders planned in one run allocate all 30
units exactly once; a fresh run plans from the full shelf again; and a single
call with no ledger behaves exactly as before) plus 10 end-to-end checks
through the real upload → wave → pick-list endpoints, asserting the wave AND
the per-order pick list both ask 24/4 and never exceed what a bin holds.

### A row with a bin is NOT an unlocated row (`waveLocationStats`)

Reported from a photo of the wave screen: "**6 line(s) have no location**" in
amber, with a bin printed on every one of the six rows.

`buildWave` (lib/wave-pick.js) counts `stats.unlocatedLines` from
`line.location` — the location PRINTED on the order line, which is blank for
every order that arrives without one. `enrichWaveWithBins` then resolves the
real bins into `row.bin_location`/`row.bins` (which is what the screen renders)
**and the count was never revisited**. So a wave with every row binned still
announced that none of them were.

`waveLocationStats(wave)` recounts: a row is unlocated only when it has NEITHER
a resolved bin NOR a printed code. Called at the end of `enrichWaveWithBins`
**and on every READ** (`GET /api/waves`, `GET /api/waves/:id`) — derive-on-read,
same discipline as `collection_due` and `fulfilmentSla`, so waves created before
this fix heal themselves instead of needing a migration.

Verified against the reported shape: 3 rows, 2 with resolved bins and 1 with
genuinely nothing → 1, not 3, on both the detail and the list.

### The scan row leads with the PRODUCT BARCODE, not the bin

Per the user, from a photo of the scan screen: *"return the product barcode not
the location"*. The row showed only `📍 AA-013-003-A ×1`. The bin answers "where
do I walk"; the **barcode answers "is this the right item in my hand"**, which is
the question the Scan & Check screen exists to settle — so it leads, in green,
before the bin pill.

`barcode` is now filled at READ time in `globalOrdersWithState` from the
client's item master, memoised per (client, SKU) for the call. Upload-time
enrichment alone misses every order uploaded before that client's catalogue was
loaded — the same reason inbound descriptions are filled on read. Suppressed
when the barcode equals the SKU (nothing gained by printing it twice).

## Whose system holds this client's stock (`stock_tracking`)

Per the user: a 3PL client's item master is worth having for its NAMES and
BARCODES even when their stock is counted in their own WMS — the pick lines
need real descriptions, the scanners need barcodes, and their store needs a
catalogue. But loading a master was an all-or-nothing act: `clientHasItemMaster`
returns true the moment a client has any inventory row, so the master switched
stock allocation ON, every quantity read 0, and the next upload met "not enough
stock" on every order.

`clientProfiles[].stock_tracking` (a tick on the onboarding screen, **default
true** — absent reads as true, so no existing client changes) separates the two.

- **`clientStockTracked(clientId)`** = has an item master AND the profile allows
  tracking. THAT is what the four intake paths ask (upload, photo scan,
  approved client submission, store sync) — reserve nothing, deduct nothing,
  invent no SKUs at zero. `clientHasItemMaster` keeps answering the literal
  question and is what tells the two cases apart.
- **THE TWO REASONS MUST NOT READ THE SAME.** "No item master is loaded" is a
  gap someone should close; "their stock is held in their own system" is the
  arrangement. `/api/preview` returns `kind: 'no-item-master'` or
  `'stock-elsewhere'` and the Confirm modal words each properly — neither ever
  calls it a shortage.
- Turning it back on re-arms the gate immediately; nothing is stamped.

Verified 15 checks: the catalogue loads, the notice reads as the arrangement,
the upload goes through untouched with both orders landing, the pick lines carry
the REAL product name and the barcode the scanners need, **nothing is reserved
and no phantom SKU is invented**, switching it back on returns the stock
judgement, and a client saved without the field stays tracked.

## The catalogue LEARNS from the orders that pass through (`harvestCatalogueFromOrders`)

Per the user, from a screenshot of the scan screen: a client with NO item
master showed a full product description on the pick line — the order file
carries it — while the store push had nothing to send. *"If my order scanning
can have description, the store can have it too — make it a permanent method."*

Every batch that enters (all FOUR intake doors — file upload, photo scan,
approved client submission, store sync) now teaches the client's catalogue, and
`backfillCataloguesFromOrders()` runs once at boot so months of live orders
already on the books teach it too (in the inventory TDZ zone next to
`mergeInventoryClientCasing`). Idempotent — a second boot learns nothing and
logs nothing.

- **CREATE only for untracked clients** (`!clientStockTracked`). For a tracked
  client, inventing rows would change what the stock gate says about their next
  upload; their unknown SKUs are already the intake gate's business (created at
  zero there, a standing rule).
- **HEAL on any client**: a row whose name is blank or equals its own code (the
  legacy name-from-SKU placeholder) takes the file's wording. A REAL name is
  never overwritten — the catalogue stays the master, so the learned name is
  the FIRST wording seen, not the last (a client renaming a product in their
  WMS will not update it; that is the price of "catalogue wins" and is
  deliberate).
- **LEARNING NEVER FLIPS STOCK ALLOCATION ON.** When the first learned rows
  bring a master into existence, `stock_tracking` is pinned OFF on the profile
  (created if needed) and audit-logged `catalogue_learned_tracking_off` —
  quantities were never given. Turning it on stays a deliberate act on the
  onboarding screen.
- **Not everything in a description column is a name**: the SKU echoed back,
  strings under 3 chars, and pure numbers/dates are refused.
- The file's wording is read from `source_description` FIRST — once a
  placeholder name exists, `enrichLinesFromCatalogue` moves the file's words
  there and puts the placeholder in `description`, so reading `description`
  would learn the placeholder back.
- Audit: `catalogue_learned_from_orders` {client, source, created, healed,
  barcoded} per intake that learned anything.

Verified 16 checks on a seeded copy of the reported shape plus a tracked
client: boot teaches the catalogue the exact description off the scan screen,
junk is refused, tracking is pinned off with zero quantities, an upload still
lands with no prompt and teaches the new SKU as it passes, the store push
queues the whole learned catalogue with nothing nameless and the mock store
shows the real name, later different wording does NOT overwrite, a tracked
client's code-as-name row is healed, and a second boot changes nothing.

## A client with NO item master is not a client who has run out

Reported from the floor as *"orders unable to upload"*: a 93-order BETIME GI
Analysis file was refused outright with **"Every order in this file is short on
stock — there is nothing left to upload."** Reproduced with the client's own
file: **not one line was actually short.** BETIME has zero rows in their item
master — their stock lives in their own WMS and we pick, pack and scan for them
— so all 94 SKUs came back `unknown`, `checkIntakeStock` put all 93 orders in
`shortOrders`, and the drop path then had nothing left. A regression introduced
with intake reservations: before that feature the file uploaded fine.

- **`clientHasItemMaster(clientId)`** gates all FOUR intake paths (upload, photo
  scan, approved client submission, store sync). No catalogue → `noItemMaster`,
  the gate is skipped, the batch is **untracked**, and — critically — the
  "create every missing SKU at zero" block is skipped too. Inventing 94 SKUs
  from a picking list would fabricate a stock position nobody gave us and then
  deduct against it at completion. Audit-logged `upload_untracked_no_item_master`.
- **UNKNOWN SKU ≠ SHORT ON STOCK.** They are different problems and must never
  share wording — one is a shortage to wait out, the other is a product nobody
  registered. The 409 now carries `onlyUnknown` and says so in plain words;
  the client heading switches between "SKUs NOT IN THE ITEM MASTER" and "NOT
  ENOUGH STOCK".
- **THREE WAYS OUT, NOT TWO.** The prompt only offered drop-or-abort, and
  dropping every order is a dead end (the 409 above). It now offers drop /
  upload anyway / abort, and when `okCount === 0` it offers only
  proceed-or-abort — never an action that cannot work. `stock_action=proceed`
  already existed server-side; nothing in the UI reached it.

**SAID BEFORE APPROVING, NOT DISCOVERED AFTERWARDS.** An untracked upload looks
identical to a tracked one on the Orders tab, so `/api/preview` returns a
`stockNotice` and the Confirm-Upload modal renders it (`#confirmStockNotice`):
grey **ℹ No stock to allocate** when the client has no item master ("nothing
will be reserved and nothing will be deducted when they complete"), amber when
real orders cannot be covered ("you will be asked what to do when you approve").
**Silence when all is well** — a fully covered file shows no notice at all.
Never a block: Approve stays enabled, and the notice reserves nothing itself
(asserted — previewing three times left `reserved_qty` unchanged). The upload
result carries `noItemMaster` so the success line says WHY nothing was reserved
rather than the bare "not tracked in Inventory", which sent people hunting for a
setting they had never turned off.

Verified 16 checks against the client's real file: it uploads (200, was 409),
all 93 orders land, **no phantom SKUs are created**, a client we DO hold stock
for still reserves exactly as before, a genuinely short order is still stopped
and still called a shortage, an unregistered SKU is flagged separately with
correct wording, and uploading anyway works. Plus 17 checks on the notice (right kind and
wording for each of the three cases, none when covered, nothing reserved by
previewing) and 7 in the browser (rendered on the Confirm screen, neutral grey
by computed style, Approve still enabled).

### Label OCR: the budget has to fit the file

Same report, second screenshot: **86 unmatched** on a Shopee label PDF. Same
cause as a 29-page Lazada AWB the user sent: these files have **no text layer at
all**, so every page needs OCR at ~2.5s, and `OCR_PREVIEW_MS_BUDGET` was a flat
**45s** — both stopped ~18 pages in and reported the rest "unmatched" when those
pages had simply never been read.

- The allowance now scales: `OCR_PREVIEW_MS_PER_PAGE` (4s) × pages needing OCR,
  floored at 45s and ceilinged at 10 minutes, with `OCR_PREVIEW_PAGE_CAP` raised
  to 300. Measured on the real 29-page AWB: **29/29 pages read in 47s**, every
  tracking number correct (was ~18).
- **`ocrSkipped` was being dropped** by `processLabelPdf` and by the route, so
  the office screen had no way to distinguish "not read yet" from "failed". It
  is returned now and rendered as a blue **"⏳ N still being read…"** badge
  instead of counting toward the amber unmatched figure — a half-finished import
  no longer reads as a broken one.

## Portal orders — Cancelled counted, and every figure BY THE DAY

Reported from a client's own screen: the Orders tiles read "5 in progress / 75
completed / 121 pieces" with the **Cancelled** filter selected — no cancelled
figure anywhere, and three lifetime totals that did not move whatever was
filtered. A client whose whole reason for the tab is *"maintain a list of orders
that could not be fulfilled"* could not see how many there were, let alone when.

- **A FOURTH TILE: Cancelled**, red when there is anything to see and grey at
  zero, so an account with none does not look like it has a problem. `.strip.s4`
  shrinks the number a little; all four fit a **320px** phone with no sideways
  scroll (asserted).
- **A DAY-BY-DAY TABLE under the tiles** — Day / In progress / Completed /
  Cancelled, newest first. One lifetime total says nothing about whether things
  are getting better or worse; three cancellations yesterday and none since is a
  different conversation from three every day.
- **WHICH DAY AN ORDER BELONGS TO DEPENDS ON WHAT HAPPENED TO IT**
  (`orderDay()`): a cancelled order counts on the day it was CANCELLED — that is
  the day the client has to re-place it — a completed one on the day it was
  FINISHED, and one still being worked on the day it ARRIVED, which is what
  makes a backlog visible.
  **THE OFFICE DID NOT USE THIS RULE, AND THE TWO DISAGREED IN PUBLIC.**
  Reported live as *"shows a total of 15 orders. but client portal shows 17"* —
  1+11+**3** against 1+11+**5**. The office (`orderDay` in `renderOrdersList`,
  and the same predicate in `/api/orders`) bucketed a `done` order on `endTime`
  but EVERY other status, `unprocessed` included, on `uploadedAt`. So an order
  uploaded days earlier and cancelled today was filed under the day it
  ARRIVED, and **the Cancelled tab under "Today" could not answer "what was
  cancelled today"** — the one question that view exists for. Settled by the
  client's own downloaded report: of five cancellations stamped 21 Aug, three
  were on orders dated 21 Aug and two on orders dated 17 and 18 Aug. Exactly
  the missing two. Both call sites now read `unprocessed_at || uploadedAt`.
  - **THE CHEAP PRE-FILTER SHAPE HAD TO GAIN THE FIELD TOO.**
    `globalOrdersWithState(keep)` hands the range predicate a small object
    (order_number / scan_status / endTime / uploadedAt) to skip enrichment on
    orders it will discard. `unprocessed_at` was not in it, so the fixed
    predicate read `undefined` and fell back to the upload date — the OLD
    behaviour, silently, with no error. Anything the predicate buckets on must
    be in that shape.
  - Verified against the reported shape: 5 cancellations, 3 on today's uploads
    and 2 on uploads from 3 and 4 days ago. The pre-fix code returns **3** (the
    reported number) and the fixed code returns 5, with both stragglers listed
    and neither counting as yesterday's — plus 4 browser checks on desktop and
    a Pixel 5 reading the Cancelled sub-tab's own count off the screen.
- **AND THE DAY RULE ALONE DID NOT CLOSE THE GAP — there were THREE defects,
  not one.** After the bucketing fix shipped, the office still read 3 against
  the portal's 5. I had called the second cause "ruled out" on the strength of
  the order dates lining up; both causes predict a delta of exactly 2, so that
  was never proof. The other two:
  - **A WITHDRAWAL THE CLIENT MADE WAS UNREACHABLE FROM THE OFFICE.**
    `/api/orders` filtered `client_cancelled` orders off the everyday list, and
    `public/app.js` never asks for `?cancelled=1` — so an order the client
    withdrew was in neither Active nor Cancelled nor anywhere else, and our
    Cancelled count sat permanently below theirs. They are `unprocessed`, so
    STATUS already keeps them out of the Active list; the extra filter only
    ever hid the cancellation. They now show in the Cancelled view with a
    **`.chip-client-withdrew`** amber "👤 withdrawn by client" pill (amber, not
    red — the ✕ chip beside it already says cancelled; this one says who).
    `?cancelled=1` still narrows to JUST those for an admin review.
  - **THE WITHDRAWAL NEVER STAMPED `unprocessed_at`.** `POST /api/portal/delete`
    set `status` and `client_cancelled` and nothing else, so even once visible
    it had no cancellation day to bucket on and fell back to the upload date.
    Now stamped — and every day-bucket reads `unprocessed_at ||
    client_cancelled.at`, so withdrawals stored the OLD way heal on read
    instead of needing a migration.
  - **AND A FOURTH, which is the one that was actually biting Mayer2026: THE
    MARKETPLACE VOID HANDLERS NEVER STAMPED A CANCELLATION DATE.**
    `handleLazadaCancel`, the Shopee equivalent and `handleZortVoid` set
    `status = 'unprocessed'` and `updated_at` and nothing else. The portal's
    chain happened to end in `|| st.updated_at`, so it dated them from that and
    counted them today; the office's did not, so it had nothing to read and
    fell back to the upload date. A Lazada order voted void by the channel is
    exactly what these two were. All three now stamp `unprocessed_at`.
  - **ONE CHAIN, `cancelledAtOf(state)`** — `unprocessed_at ||
    client_cancelled.at || updated_at` — used by the order object, the range
    pre-filter, `/api/portal/orders` and BOTH export sheets. Five call sites had
    grown three different fallbacks between them, which is the whole reason two
    screens could disagree about the same day. `updated_at` stays as the last
    resort so records already stored heal on read; it is the day we touched the
    order, which is not exact but beats the day it arrived by a mile.
  Verified 12 API checks on a seeding of every shape (three plain, two on older
  uploads, one client withdrawal, one legacy withdrawal with no timestamp, and
  two marketplace voids carrying only `updated_at`): the office counts all
  nine, none counts as yesterday's, a withdrawal carries who and when while one
  we made does not, a marketplace void is not mistaken for something the client
  did, `?cancelled=1` still isolates the client's own, and not one appears as
  active work. **Each fix was proved against the build it replaced** — the day
  fix alone returns 5 of 7, the withdrawal fix 7 of 9 — so the tests catch real
  behaviour rather than agreeing with themselves. Plus 14 browser checks on
  desktop and a Pixel 5.

  LESSON, since it cost three round trips: on a screen fed by many writers,
  "why do these two numbers differ" is rarely ONE cause. Each fix here removed
  a real defect and the visible number did not move, because another was hiding
  behind it. Seed every shape that can produce the symptom before believing a
  count.
- **SGT calendar days** (`sgDay()`, `en-CA` + `Asia/Singapore`) — never
  `toISOString()`, which puts anything before 08:00 SGT on the previous day.
  Same standing rule as everywhere else.
- **A ZERO IS A DASH.** The eye should land on the days something actually
  happened, especially the cancellations.
- **TAPPING A DAY FILTERS THE LIST**, and it composes with the status chips
  (Cancelled + a day = exactly that day's cancellations). **A filtered list says
  so in words** — a `.day-note` reading "📅 Showing 15 Aug only — 0 in progress,
  3 completed, 2 cancelled" with a Clear day button, the same rule as the office
  KPI tiles; a day holding one order removes almost every row and would
  otherwise read as "nothing here". Tapping the same day again clears it.
- Client-side only — `/api/portal/orders` already returned `date`,
  `completed_at` and `cancelled.at`. 14 days on screen, with a muted line
  pointing at ⬇ Report for the full period (the standing 90-day screen /
  365-day export split).
- The listeners are **delegated on `document`**: `#orSummary` is rebuilt on
  every render, so a bound listener would be thrown away with it.

Verified 51 browser checks across desktop, a Pixel 5 and a 320px screen against
an account with orders spread over three days: four tiles with the right
figures, no sideways scroll, one row per active day in the right order,
cancellations red by computed style, a dash where a day has none, tapping a day
narrowing the list to exactly its orders, the note naming what is shown, Clear
restoring everything, and the day and status filters composing.

TEST GOTCHA: portal accounts are **one place at a time**, so a multi-viewport
Playwright run must free the seat (`.../portal-users/:id/release`) or sign out
between contexts — the second browser gets a 409 otherwise.

### Damage at receiving — already an event chain; the write-off was the gap

Asked from the floor: two units were adjusted out as damaged during an inbound,
the balance is right, "how do I include that so the client knows". Most of the
answer is that the system ALREADY does it, provided the pieces are scanned with
the **damaged** condition:

- `good = scanned − damaged − kiv` on a PO, so damaged units **never become
  sellable stock** — the balance is right without anyone adjusting anything.
- **End Receipt REFUSES to close until the damage is photographed**, naming the
  SKU. Damage is a claim against a supplier and a deduction on a client's
  account; the evidence is not optional.
- A **quarantine row** is raised per SKU×condition, `status: 'open'`, awaiting a
  disposition (release to stock / dispose / return to client).
- The client's inbound row shows a red **"2 damaged / held"** pill, the GRN
  carries damaged/KIV **per line**, and Overview raises a held-stock alert. The
  receipt still says all 10 arrived — both facts, not one.

**THE REAL GAP: a write-off done any other way was invisible to the client.**
`outboundMovements` selected only `reserve`/`release`/`outbound`, so damage found
AFTER a receipt closed — or corrected by hand — left no trace on their side. It
now includes `adjustment` and `quarantine_release`: it is their stock, a change
to it is their business, and the reason typed at the time is what explains it.
- The screen and the export both carry **direction and reason**. Without the
  direction a write-off and a correction upward look identical; without the
  reason "Stock adjusted, 2" tells the client nothing they can act on.
- The export gained an `In / Out` and a `Reason` column, and a line explaining
  what an adjustment is — a note referring to a column that does not exist is
  its own bug.

### RECORD DAMAGE AGAINST A CLOSED RECEIPT (`POST /api/inbound/:id/damage`)

Per the user: make it **attributable** — recorded against the receipt it happened
on, reflected in inventory, and an event the client can see. Scanning with the
Damaged condition stays the right answer while a receipt is OPEN (an open one is
**told so**, 409, rather than quietly accepted); this is for the case that cannot
use it.

It writes the SAME records that path writes, so nothing downstream needs to know
the difference: `conditionTotals` on the receipt (which is what the client's
pill and the GRN read), a quarantine row **naming the receipt serial**, and a
stock movement whose reason names the receipt too.

- **"HAS IT ALREADY BEEN TAKEN OFF?" IS ASKED, NEVER ASSUMED** — the floor's own
  case was stock already corrected by hand, and deducting again would double the
  correction. That is the exact trap that put a client on zero earlier the same
  day. `already_adjusted: true` attributes it and leaves stock alone, and the
  response says which it did.
- **COUNTED, OR NEVER COUNTED? Two different facts, and the numbers cannot tell
  them apart.** Reported from the floor: *"supposed to be 638, we already taken
  2 out"* — the 636 on the receipt was the count AFTER the damaged pieces were
  pulled aside, so those 2 never entered it. Recording them the ordinary way
  carves them OUT of the 636 and reports good 634, which understates the
  sellable stock and misstates what arrived.
  - **counted** (default) — of the N received, X were damaged. Received stays,
    good falls, and the pieces come off stock because they were added to it.
  - **`beyond_received`** — X MORE arrived and were never counted. Received
    rises (636 → 638), good stays, and **nothing is ever deducted**: units that
    were never counted in were never added to stock, so taking them off would
    remove good pieces. `beyond` implies "already off" by construction.
  The operator is asked, because only they know which happened. The line then
  reads over the paperwork, which is the honest tally.
- **A RECORDED WRITE-OFF CAN BE TAKEN BACK OFF** (`POST
  /api/inbound/:id/damage/undo`, admin or master, reason of 6+). The two modes
  are easy to pick the wrong way round and without a way back the GRN is stuck
  saying it. It reverses exactly what the entry did — the condition total comes
  down, a never-counted entry takes its units back off what arrived, and
  anything it deducted is given back (only what it ACTUALLY took, never the
  quantity it claimed). The entry is KEPT on the record marked `undone_at/by/
  reason` — a write-off made and withdrawn is part of this receipt's history —
  but stops being quoted on the GRN, on the client's row and on the office row.
  Its quarantine row is marked `withdrawn`. UI: the red **⚠ N damaged** pill on
  the Inbound row is clickable for an admin.
- **NEVER MORE THAN ARRIVED.** Attributing 5 damaged units to a receipt that took
  3 of that SKU is not a correction, it is a different event (409, with both
  numbers).
- **EVIDENCE, OR AN EXPLANATION OF ITS ABSENCE.** Same rule as End Receipt: a
  photo for that SKU, or a `no_photo_reason` recorded on the trail — for a
  receipt closed days ago the goods may be gone, and a hard block would just push
  people back to the silent hand adjustment this exists to replace.
- Reason floor of 6 characters (same as a hand adjustment), admin or master,
  audited `inbound_damage_recorded_late`, and `rec.late_damage[]` keeps a dated
  entry saying it was recorded after the close rather than pretending it was
  found at the dock.
- A short deduction (fewer units still on hand than the damage) is **reported by
  name**, never silently floored.
- UI: **⚠ Record damage** on any closed receipt's row, admin only.

Verified 23 checks on the scan-time path (the photo gate refuses and then admits
the close, only the 8 good units land, the quarantine row is raised, the client
sees the damaged pill and the per-line GRN, and a hand write-off afterwards
appears on their movements AND in their download reading "Out / 2" with the
reason) plus 25 on the after-the-fact path (an open receipt refused, the photo
gate, the already-adjusted case NOT deducting twice, the receipt/quarantine/trail
all carrying it, the client's row and GRN updated, the over-attribution ceiling,
a fresh write-off genuinely coming off inventory, and warehouse 403 with nothing
changed).

### Cancelled orders are opt-in; aging is not a client's business

Two things asked for on the floor.

- **CANCELLED ORDERS ARE NOT IN THE DEFAULT VIEW.** A client opening Orders was
  landing on a wall of red pills, which describes the exception rather than the
  relationship. "All" now means in-progress + completed, **completed first**
  (newest first within each group). They keep their own chip, their own tile and
  their count in the day table — they just do not lead.
  - **A LABEL THAT QUIETLY EXCLUDES SOMETHING IS A TRAP**, so when there ARE
    cancellations the screen says so (`.cx-note` — "6 cancelled orders are not
    shown here", with a **View cancelled** button that switches the chip). The
    note steps aside once you are in that view.
- **AGING IS GONE FROM THE PORTAL** — the chip, the pill, the threshold editor,
  the Overview "not moving" alert, the per-SKU "last moved" line, and the two
  aging columns in the stock export. How long a client's stock has sat here is
  an operational and billing concern of OURS; on their own screen it reads as a
  judgement on their inventory, which is not ours to publish. Still computed and
  still on the office side — `portalAgingDays` and `lastMovementBySku` remain, so
  turning it back on is a UI change, not a rebuild. The `stFilter === 'aging'`
  branch is kept as a no-op so a stale saved filter cannot empty a stock list.

Verified 20 browser checks on desktop and a Pixel 5 against an account with 5
completed, 6 cancelled and 2 open: not one cancelled order in the default view,
completed leading, the note naming what is hidden, one tap showing exactly the
cancelled six, and the word "aging" appearing nowhere on Stock or Overview.

### The Guide is written to be handed to a client

Per the user: the portal has to be good enough to give a client without
apology. The screens were already there; the Guide was the gap — a client meets
a dozen coloured pills and had nowhere to look any of them up.

- **"What the labels mean" is SERVED, not written into the HTML**
  (`GET /api/portal/glossary`, never hidden by section visibility — it explains
  the tabs they DO have). It is built from the SAME constants the pills are:
  `PORTAL_STATUS_LABEL`, `portalPickup`'s wording, `pickupPolicy().cutoff` and
  `INBOUND_SLA_WORKING_DAYS`. A hand-written list would be wrong the first time
  anyone edited a label, and **a glossary that disagrees with the screen is
  worse than no glossary**.
- Four groups — Your orders, Collection, Your stock, Shipments in — 19 labels,
  each shown as the REAL pill beside plain English. Seeing the actual pill is
  what makes it findable when they meet it on another tab; the tone names a
  class that exists (`p-done`/`p-open`/`p-bad`/`p-wait`, there is no `p-ok`).
- **"Getting your figures out"** — what each ⬇ contains, and the on-screen vs
  download window stated in the REAL numbers from the server (90 / 365), not
  copy that would go stale.
- **"When something is not right"** — a shipment that did not match, damage, a
  returned parcel, an order not moving, pulling an order back, and who to tell.
  Written as what WE do and what is worth doing at their end.
- Loaded once, when the Guide is first opened; a failure renders one honest
  line rather than a blank box, and leaves the rest of the Guide usable.
- On a phone the pill goes on its own line — a label and a sentence squeezed
  side by side leaves both unreadable.

Verified 34 browser checks on desktop and a Pixel 5: all four groups, 19 rows,
every one a coloured pill with real text, nothing rendering as undefined, each
of the seven order and collection labels explained by name, the receiving
promise and the REAL daily cut-off both present, five Guide sections, and no
sideways scroll.

### The last three days on the Overview, and today updates on its own

Per the user. The full day-by-day table lives on Orders; this is the short
answer to "how are we doing" without leaving the dashboard.

- **TODAY IS ALWAYS THE FIRST ROW, even when nothing has happened.**
  `ordersByDay()` only holds days that carry orders, so on a quiet morning today
  would simply be absent — and a client would hunt for a row that is not there
  rather than read a row of dashes. `overviewDaysHtml` builds the three days
  from `sgDayOffset()` and fills from the map.
- Every row opens that day's orders, like everything else on this screen.
- **THE LIVE POLL IS NARROW ON PURPOSE** (`LIVE_MS` 30s): only while the
  Overview is the open tab AND `document.visibilityState === 'visible'` (a
  dashboard left in a background tab for a week must not poll all week), and
  only the two calls the tiles and the strip are built from — not `loadAll`,
  which would re-fetch stock and inbound for nothing. Coming back to the tab
  ticks immediately rather than waiting out the interval. Stopped on sign-out.
- A dropped poll is silent: the next one is 30s away and the screen still holds
  the last good figures.

### A COMPLETED ORDER WITH NO COMPLETION TIME (`repairUndatedCompletions`)

Found while proving the live update: the order genuinely completed, and today's
row correctly did not move — because `completeOrderCore` took `endTime` **from
the request body** and stored nothing when it was absent. The office screen does
send it, so live packing was fine; **anything else** — a script, an integration,
a replay — marked an order `done` and left it UNDATED.

An undated completion falls back to the order's **upload date** in every
day-bucket in the system: the client's day table, the office Orders tab,
`fulfilmentSla` and `collectionDayFor`. Exactly the class of bug the 15-vs-17
thread was about, from a different direction.

- **The completion time is a fact the SERVER observes**, so it can never depend
  on the caller supplying it: a supplied time is still honoured (an offline
  replay legitimately says when it really happened), and its absence now means
  now, never nothing. `startTime` defaults the same way.
- **`repairUndatedCompletions(db)`** dates the ones already stored, from the
  best evidence there is: the LAST SCAN on the order (packing finished at or
  just after it), else `updated_at`, else **left alone** — an order with neither
  has no evidence, and inventing a date would be worse than the gap. Stamped
  `endTime_derived` so a derived date is never mistaken for an observed one.
  Runs in the same boot pass as `repairStoredDateStrings`, idempotent, audited
  `completions_redated`.

Verified: 16 browser checks on the strip (three rows, today first and marked,
the right three SGT days, each a link, no sideways scroll) and 9 on the live
path — an order completed through the REAL endpoints while the client sits on
the Overview, and today's Completed going 1 → 2 **28 seconds later with no
reload and nobody pressing refresh**, plus a hidden tab making no requests at
all. The boot repair dated a real undated order on the way in.

TEST GOTCHAS, all mine, all the same lesson this codebase keeps teaching:
`/api/scan/complete` answers **200 with `{ok:false}`** and the mismatches when
the counts do not line up — asserting on the status alone "passed" against an
order that was still `processing`. And a part-scanned or OVER-scanned order is
refused, so the test lands the count with `setqty` rather than counting scans.

### Every figure on the client's Overview opens the rows behind it

Per the user, pointing at the Overview: *"all this are to be clickable and
leads to its corresponding data"*. A number a client cannot open is a number
they cannot act on — "165 SKUs out of stock" is only useful if those 165 are
one tap away.

- **The four KPI tiles**: Available → Stock, Reserved → Stock filtered to
  reserved, Orders in progress → Orders (open), Orders shipped → Orders
  (completed). The Last-30-days figures lead to the same place.
- **Every alert** carries the tab and filter that answers it — out of stock,
  running low, orders waiting for stock, receiving discrepancies, inbound past
  the SLA. The wording that used to say "Open the Orders tab to see each one"
  is gone: it IS the link now.
- **The chart's bars** open that day's orders. A day with NO shipments is
  deliberately not a link — tapping it would land on an empty list, which reads
  as broken rather than as "nothing went out".
- **`openFrom(tab, filter, day)` SETS THE CHIP as well as the variable.**
  Leaving the chip on "All" while the list is filtered is exactly how someone
  concludes their stock has vanished — the same lesson as the office KPI tiles'
  `.kpi-filter-note`.
- **A SECTION THIS LOGIN CANNOT SEE IS NEVER MADE A LINK** — the builders ask
  `visible(k)`, the same rule the tabs and the API use, so a tile can never lead
  somewhere that answers 403. Asserted: with Stock switched off for a login, the
  Available and Reserved tiles stop being links while the Orders tiles stay.
- ONE delegated listener on `document`, because this HTML is rebuilt on every
  render and a bound listener would be thrown away with it. `role="link"` +
  `tabindex="0"` + an Enter/Space handler, so it is not mouse-only.
- The affordance is hover/focus only (plus a "View →" in each alert, since a
  phone has no hover) — a dashboard should still read as a dashboard, not a
  wall of buttons.

Verified 34 browser checks on desktop and a Pixel 5 against an account seeded
with real stock and a fortnight of shipments: every tile a link to the right
tab and filter, tapping Reserved landing on Stock with the Reserved chip ON,
each alert knowing where it leads and saying so, an empty chart day not being a
link, tapping a live bar opening Orders narrowed to that day with the day-note
naming it, and the visibility rule holding per login.

## Portal orders — the waybill you can open, and no pill that says nothing

- **A STALE DELIVERY PILL IS WORSE THAN NO PILL.** A collected order was showing
  a grey "Staging" chip under its green "Picked Up" — Staging means *waiting for
  pickup*, a step that is over, and for a marketplace order collected by the
  platform's own courier there was never a van of ours involved. `/api/portal/orders`
  now suppresses `delivery` when the parcel is `picked_up` AND the label would
  only be `Staging` or `Preplanned`. **"On the road" and "Delivered" survive** —
  if we really are moving it, that is real news.
- **THE WAYBILL IS A PILL YOU CAN OPEN.** A tracking number alone asks the
  client to take it on trust. `has_label` on the list and the detail says whether
  a matched page exists; clicking opens it via
  `GET /api/portal/order/:orderNumber/label`, which re-checks ownership itself
  and 404s (never 403) for another client's order, so the route cannot be used
  to probe for order numbers. The click `stopPropagation`s — the pill sits
  inside the expanded card, so letting it bubble would collapse it.

### SECURITY — `requireAuthOrToken` was missing the namespaced-session skip

`requireAuth` skips sessions keyed `driver:`/`portal:` so a client or driver
token can never unlock staff APIs. **`requireAuthOrToken` never got the same
guard**, and it is what the PDF and photo viewers use (they take `?token=`
because `<img>`/`<embed>` cannot send a header). So a signed-in client could
fetch ANY order's waybill, any label-import page, any inbound photo and the
no-barcode sheet — including other clients'. Four routes, all read.

Found by an assertion that a portal token could NOT reach the staff label
route; it could, and returned 200. Fixed by adding the identical skip. Keep
both functions in step — if a third auth helper is ever added, it needs this
too.

## Adjusting a stock quantity by hand — password, reason, trail

Per the user: allow adjusting inventory quantity, behind the Administrator
password, with the reason recorded. `POST /api/inventory/:sku/adjust`.

**THE REAL GAP WAS THE TRAIL.** The endpoint already existed, took ANY signed-in
user, made the reason optional, and wrote **nothing to `db.auditLog`**. The
movement landed in `stock_movements` so the number changed, but nothing said who
changed it or why. A hand adjustment is the one stock change with no document
behind it — no receipt, no order — so it is the one that most needs a name
against it. `inventory_adjusted` now records sku, client, delta, from, to,
reason, who, and `viaMaster` (whether the Administrator key was used rather than
a personal password).

- **`verifyAdminReconfirm(req, {role:'admin'})`** — an admin's own password OR
  the Administrator key. Warehouse gets a real 403. **403, never 401**: the
  session is valid, only the second check failed, and a 401 would trip the
  client's session-expired handler and force a reload (asserted in the browser
  test — the sign-in overlay must NOT appear on a wrong password).
- **The reason is mandatory**, floor of 6 characters. A length floor is blunt,
  but it blocks the classic non-reasons ("oops", "test", "fix", "adj") while
  "recount" and "damaged" pass. Nothing can judge whether a reason is TRUE; this
  only stops the box being waved through empty. (Caught by the test: at a floor
  of 4, "oops" sailed through.)
- Adjusting a SKU that is not in the client's item master is a 404, not a
  silent create.
- **The UI takes the NEW on-hand figure, not a delta** — someone correcting a
  count reads what the shelf says and types that. The delta is computed and
  shown (green up, red down) so the change is visible before it is made.

Verified 17 API checks and 12 browser checks.

## Stock lists — sort, download, and zero-quantity SKUs

Per the user: both the client portal and the office can toggle ascending /
descending and download the list as Excel; the office picks the client first.

- **ONE sorter, `sortStockRows(rows, sort, dir)` in server.js**, used by
  `/api/inventory`, `/api/inventory/export`, `/api/portal/stock` and
  `/api/portal/export/stock`. Sorting a screen client-side and a file
  server-side is exactly how the two drift, so both go through the same
  function and the file always matches the list it was taken from. The client
  mirrors the same keys (`STOCK_SORT` in portal.js, `INV_SORT` in app.js) for
  instant re-sorting without a round trip, and passes `sort`/`dir` on the
  download so the file agrees.
- Keys: `sku`, `name`, `available`, `on_hand`, `reserved`, `moved`. Ties break
  on SKU so the order is stable.
- **A SKU REGISTERED WITH NO STOCK IS A ROW READING 0, NEVER A MISSING ROW.**
  It is part of the client's item master and its absence would read as "we lost
  it". `inventory.getAll()` already returns the whole catalogue; nothing
  filters on quantity, and both exports write a numeric `0` rather than a
  blank. Both sheets say so in words under the title.
- `GET /api/inventory/export?clientId=&sort=&dir=&search=` is new (registered
  BEFORE the `/:sku` routes — Express would otherwise match "export" as a SKU).
  It refuses without a `clientId` rather than dumping every client's stock.
- The sheet records the sort it was taken in, so two files of the same client
  in different orders are still explicable.

### The sidebar's CLIENTS list was squashed to a sliver

`.sb-nav` and `.sb-client-list` were siblings both trying to share the
sidebar's leftover height. The nav takes its natural height and has grown to a
dozen tabs, so the client list — the flexible one — collapsed to a few pixels
with its own scrollbar and the client names were unreadable. They are now
wrapped in ONE `.sb-scroll` region that scrolls as a unit, each keeping its
natural size; only the user/admin block stays pinned at the bottom.

## A backorder dies when its order is fulfilled (`closeSettledBackorders`)

Reported from the floor: the Admin backorder queue showed **a few thousand**
open rows. Per the user: *"if orders can be scanned, fulfilled and completed,
then it's not considered a back order."* He is right, and this was a real bug.

A backorder is raised at UPLOAD time from `reserveOrder`'s shortfall — the
system's own stock figure, which on a new account is often zero simply because
the item master was loaded without quantities. The goods are on the shelf, the
packer scans the order, it ships. But **nothing ever closed the row**:
`releaseBackorders` only fires when new stock is RECEIVED, so a row raised at
upload outlived the order it belonged to, and months of that pile up.

`closeSettledBackorders(db)` closes any open backorder whose order is now
`done` (→ `fulfilled`) or `unprocessed` (→ `cancelled`), stamping
`closed_reason`. RECONCILE-ON-READ, not a hook, for exactly the reason
`pruneOrphanBackorders` reconciles: an order can be finished down several
paths, and hooking each one is precisely how the original gap appeared.

Called from **boot**, from `GET /api/backorders`, and it sits alongside the
orphan prune at every deletion site. Closed rows are KEPT as history, not
deleted — only genuinely-orphaned rows are removed. Audit-logged
`backorders_closed_settled`.

Verified against the reported shape: 1,250 open rows (1,000 whose orders were
picked and completed, 50 pointing at no order at all, 200 genuinely waiting)
came down to **200** at boot, the closed rows kept their reason, a second read
is a no-op, and completing one more order took its row with it. 15 checks.

## A reservation dies with its order (`releaseOrphanReservations`)

Reported from the floor: an order deleted in the office still showed its units
as **Reserved** on the client portal — "7 reserved" against "0 orders in
progress", a contradiction the client can see. Deleting an order removed the
order but never released what it had reserved, so those units stayed locked out
of `available` forever.

Only ONE path released a reservation (a voided marketplace order). Orders
disappear down at least eight routes — Master delete, single and bulk approval
of a deletion request, portal self-cancel, duplicate overwrite, whole-batch
delete, the Master reset, the client-data wipe and the 12-month archive — so
this RECONCILES rather than hooking each one, exactly as `pruneOrphanBackorders`
and `pruneOrphanTransportJobs` do, and for the same reason.

**A RESERVATION IS ONLY LEGITIMATE WHILE THE ORDER IS STILL OPEN** — the first
cut compared against orders that still EXIST, which missed the case actually
reported: an order CANCELLED in the office is still on the books, so its units
stayed Reserved. The rule is on STATUS:
- `pending` / `processing` → real, leave it
- `unprocessed` (cancelled) → nobody will pick it, give the units back
- `done` → `deductOrder` already released it; anything left is stale, and
  releasing is safe because a done order still holding a reservation never had
  its stock deducted either
- gone entirely → nothing to hold it

`inventory.openReservations(clientId)` derives what is still held per (order,
sku) from the movement ledger — reserved − released − shipped — and anything
not in the open set is released. A SHIPPED order can never get its stock back:
the ledger's outbound row cancels its reserve row, so it has no open
reservation to release (asserted directly). Audit-logged
`reservations_released_orphaned` with the units and the order numbers.

Called from **boot**, from every deletion site, and from
`GET /api/portal/overview` so a stuck reservation heals the moment the client
looks rather than waiting for the next office action.

**THE TEMPORAL-DEAD-ZONE TRAP, HIT FOR THE THIRD TIME.** The boot call was
first placed with the db.json reconcile pass near the top of the file, where
`const inventory` does not exist yet — the ReferenceError went into the
surrounding `catch` and the reconcile was silently skipped, so the test found
"released 0". It now runs next to `mergeInventoryClientCasing()`, which carries
the same warning for the same reason. Anything touching `inventory` at boot
must go THERE.

Verified 19 checks on the live path (deleting one of two orders gives back
exactly its 7 units; CANCELLING another gives back its 4 while it stays on the
books; the order still open keeps its 3; on-hand never moves; completing an
order deducts and releases together and re-running the reconciler does NOT
resurrect shipped stock) plus 5 on a pre-seeded fixture proving the state the
live site is already in heals at boot.

## Administrator → Clear Test Data (selective, per client)

Per the user: after testing an account, clear the trial data selectively —
Inbound, outbound Orders, Item Master and so on — choosing what goes and what
stays before handing the login to the real client.

`GET /api/master/client-data/summary?client=` counts what that client has;
`POST /api/master/client-data/wipe {client, scopes[], confirm}` removes only
the ticked scopes. **MASTER-KEY gated**, not admin-role: this is the most
destructive action in the app and it spans a client's whole history. The
confirmation is the client's name typed out, same guard as the other
destructive actions.

**REMOVING THE ACCOUNT ITSELF** is the `profile` scope. Every other scope clears
a client's DATA and deliberately leaves the account standing, because the usual
job is handing a cleaned account over — but an onboarding done by mistake, or
under a spelling that turns out to be a case-variant of an existing client, had
no way back at all. It removes the profile and, with it, the **portal logins**
(said in those words on the screen, and counted, rather than discovered by the
client at their next sign-in); their sessions are deleted at the same time via
`portalSessionKey`, so nobody is left holding a token against a profile that no
longer exists. Matched case-insensitively like every other scope here — "Betime"
and "BETIME" are one client, which is precisely the mistake this undoes.
Ticking it takes nothing else with it: orders, inbound and the item master are
each still their own choice.

**TWO THINGS ARE NEVER WIPEABLE, deliberately:**
- **`db.auditLog`** — a wipe that could erase its own trail is not a trail. The
  wipe is logged *there* (`client_data_wiped`, with the scopes and the counts),
  and that record outlives the account even when the profile scope removes it.
- **`warehouse_locations`** — the racking belongs to the warehouse, not the
  client; deleting it would take every other client's bins with it.

(The profile and its portal logins USED to be in this list — "the whole point is
to hand that account over" — which is right for a handover and wrong for an
onboarding mistake. They are now the opt-in `profile` scope above, never part of
a data clear.)

**PER-UPLOAD, NOT ALL-OR-NOTHING.** "37 order(s) in 3 upload(s)" is not enough
to decide with when some of those uploads are real work. `clientWipeSummary`
returns an `uploads[]` breakdown — when it landed, its job code and file, how
many orders and lines, and how many are **done / started / untouched** — and the
Outbound-orders box expands into it. Ticking specific rows sends `batchIds` and
the wipe clears only those; leaving them all unticked clears the client's whole
history exactly as before. An upload holding COMPLETED work shows its count in
red and the confirm dialog names it, because clearing that is destroying a
finished pick rather than tidying a test.

**A SUBMISSION STORES ITS CLIENT AS `client_name`.** The summary and the wipe
both filtered on `x.client`, which no submission has — so the box read
**0 submission(s)** with four sitting in the client's portal, and ticking it
removed none of them. Found from a screenshot of exactly that.

**THE DAY'S NUMBERING FOLLOWS WHAT SURVIVES** (`resyncCodeSequences`). Clearing
a client's test data used to leave the counters where they were, so the next
upload came out `CS-260803-04` with nothing on screen at all. **Recomputed,
never zeroed**: these counters are per-day and GLOBAL across clients (IS- and
CS- deliberately share `db.jobCodeSeq`, which is why `IS-260803-03` and
`CS-260803-01` sit side by side), so blindly resetting after wiping ONE client
would re-mint a code another client is already using today. Each counter is set
to the highest number still in use for that day — 0 when nothing is left, which
is the "start again at 01" the floor expects. Covers `jobCodeSeq` (IS-/CS-),
`inboundCodeSeq` (IB-), `waveCodeSeq` (WV-) and `stagingCodeSeq` (ST-), and the
result is returned and audit-logged as `sequences`.

`item_master` implies `stock` (stock for a SKU that no longer exists is
orphaned data nothing can reconcile) and the UI ticks and LOCKS the stock box
to say so. Clearing `stock` alone keeps the catalogue and zeroes the
quantities. Each scope shows how much it would remove, so nobody ticks blind.
`pruneOrphanBackorders` / `pruneOrphanTransportJobs` run afterwards, as on
every other deletion path.

Verified 15 API checks (warehouse refused, a mistyped confirmation changes
nothing, inbound-only leaves orders and the catalogue intact, stock-only keeps
the SKUs at zero, no other client touched, the audit trail GREW, the portal
logins survive) plus 13 browser checks — and 15 more on the counter resync:
clearing one client leaves the counter at 4 because ANOTHER client still holds
`IS-<day>-04`, clearing that one too takes it to 0, and the very next upload
is `IS-<day>-01`.

GOTCHA worth keeping: the first version of the client call set
`'content-type'` explicitly AND spread `hdrs()`, which sets `'Content-Type'`.
Two object keys differing only in CASE become one combined header value
(`application/json, application/json`), which `express.json()` does not
recognise — so the body arrived empty and the server answered "client is
required" on a request whose payload was visibly correct in DevTools.

## Inbound → Staging → Putaway (the current flow)

Per the user: the crew scans (or keys) quantities, **everything received then
goes to Inbound Staging**, and **Putaway is a separate function on the sidebar**.
There is no longer a putaway-now-or-later question at End Receipt — that decision
used to be forced on the person closing a receipt while a driver waited.

### Scanning: one piece by default, a keyed quantity when it helps

`#inboundQtyInput` sets what the NEXT scan counts. It **resets to 1 the moment
it is used** (`takeInboundQty`), so a multiplier left set can never quietly
inflate the rest of a receipt — the same discipline as the damaged/KIV condition
reset. The box turns amber while it is above 1 so a set multiplier is visible,
and ± buttons exist because keying on a phone mid-scan is slow. The server has
always accepted `qty`; this only wires it up.

**The qty travels with a held offline scan** (`extra.qty`). Replaying a keyed
carton of 24 as a single piece would silently lose 23 — the same class of bug as
replaying a damaged piece as plain "received".

### End Receipt issues the staging ID itself

`/api/inbound/:id/end-receipt` now stages everything outstanding as part of
closing (`auto: true` on the entry) and returns it, so the screen can offer the
label to print. `stagingOutstanding()` is unchanged and still subtracts BOTH
prior putaway and prior staging. Staging is **not a new stock state** — the units
were added to inventory at End Receipt; staging records WHICH pallet is which and
what is still owed a bin.

### `GET /api/putaway/queue` — one row per staging label

Every staged pallet still owed a bin, across ALL receipts, oldest first. Grouped
by staging ID because that is the physical unit: one label, one pallet, one trip.
Putaway is recorded per SKU on the receipt (not per label), so the queue credits
completed putaway against labels **oldest-first** — the order the floor would
physically work them.

### Partial putaway, and two people finishing one pallet together

Per the user: a pallet may be put away a bit at a time, and a second person may
**join** a pallet someone else started — *"whse user 1 put away sku ABC qty 10,
whse user 2 putaway ABC qty 10pcs, it will result in a final qty of 10+10. for
the item line, 2 user pills will be seen."*

- **PARTIAL IS THE NORMAL CASE, not an exception.** Each line carries
  `done of total` with the remainder left in the queue; the qty box defaults to
  what is still outstanding, so putting the lot away is one tap and putting away
  half is one edit. Quantities **add** — there is no "who owns this pallet"
  lock to take or hand over.
- **`putawayDoneForLabel(rec, stagingCode, sku)`** rolls the raw putaway entries
  up into `contributors` — `{by, qty, locations[], first_at, last_at}` per
  person, oldest first — which is what draws the `.pa-who` pills (your own
  highlighted) and what the receipt trail reports.
- **JOINING IS A NOTICE, NEVER A BLOCK.** A putaway that lands on a label
  someone else has already worked appends to `st.joins[]` and the response
  reports `joinedOthers`, so the joiner is told whose pallet they picked up and
  the earlier worker sees an orange notice on their own screen (dismissed via
  `POST /api/putaway/joins/seen`). Nothing waits on an acknowledgement — the
  units are already binned, and stopping the second person to ask permission is
  exactly the delay this feature exists to remove.
- **`staging_code` is stamped on every putaway entry.** Entries written before
  this existed carry none and are credited to labels oldest-first, so a
  part-finished pallet from before the refinement still reconciles.
- **Over-putting is REFUSED (409)**, naming the SKU and label ("PA-BOX on
  ST-260802-01 is already fully put away"). Two people racing the same last
  carton must not bank it twice — the physical piece only exists once.
### Finished putaway stays on the screen

The queue only lists what is still owed a bin, so a completed pallet vanished
entirely — "Nothing waiting" and no way to check what had been done. A **✓ Put
away** section now sits under the queue: one row per staging label with the
receipt, client, products, units, everyone who worked it and when it finished,
expandable to **every movement** (when, SKU, qty, bin, who, batch/expiry/
serials).

- `GET /api/putaway/history?from=&to=&client=` and
  `/api/putaway/history/export` (XLSX: a **Pallets** rollup plus a
  **Movements** sheet carrying every single entry — the sheet someone checks a
  dispute against).
- Built from `rec.state.putaway`, the SAME entries the queue credits against,
  so the two can never disagree about what happened.
- Entries written before staging labels existed carry no `staging_code` and are
  grouped as one "(before staging labels)" pallet rather than dropped — old
  work stays visible.

Verified 20 API checks and 10 browser checks: the queue is empty exactly as
reported while the finished pallet is shown below it, naming both people and
both bins, the trail opens on click, and the download carries both sheets.

- **`GET /api/inbound/:id/putaway-trail`** is the receipt-level audit view:
  every entry with qty/bin/person/time, plus the rollup the user asked for —
  how many people, which locations, how many units.
- The queue polls every 7s so a colleague's progress appears by itself, and
  **skips the repaint while any field has content or focus** — repainting under
  someone mid-keying a bin would lose what they typed.

### Mass putaway, and one inbound at a time

Per the user: *"putaway activity needs to tally with the unique inbound. ie:
inbound #123 contains sku ABC. inbound #125 contains also SKU ABC. each putaway
job, needs to be done based on one inbound job at a time."*

**THE RULE IS ENFORCED BY SHAPE, not by a check.** `POST /api/putaway/bulk`
takes ONE `inbound_id` and ONE `staging_code`, so a request spanning two
receipts cannot be expressed and there is no rule to forget. Every entry is
written onto `rec.state.putaway` tagged with its `staging_code`, and
`putawayOutstandingForLabel` / `putawayDoneForLabel` never look a SKU up across
receipts — #125's ABC can neither satisfy nor consume #123's outstanding
quantity. Verified directly with two receipts sharing SKU ABC: clearing all 10
of #123's leaves all 7 of #125's owing, credited with nothing, and an 11th piece
on #123 is refused while #125 can still bin its own 7 into the same bin.

- `doPutaway()` was EXTRACTED so the single-line route and the bulk route run
  the same code — a second copy would drift, and the first thing to drift would
  be the over-put guard.
- **A failing item does not abort the rest.** On a floor, one full bin must not
  undo four trolleys of finished work. Each item's outcome comes back so the
  screen can name the line that needs another look.
- **"Put away selected" ASKS, then commits.** It used to refuse a line with no
  bin by writing into `.pa-msg` at the BOTTOM of the card — on a 36-line pallet
  that is far below the fold, so pressing the button looked like it did nothing
  at all (reported from the floor exactly that way). Now: missing bins are
  offered the suggestion the screen is already showing, anything still
  unresolved is NAMED in a dialog, and the putaway itself is confirmed with what
  will happen ("2 line(s), 10 pc(s) into 1 bin(s) … Cancel = abort, nothing
  happens"). `msg()` also scrolls an error into view, since an error nobody can
  see reads as a dead button.
- UI: a tick column and a bulk bar INSIDE each staging card (a card is one
  label off one receipt, so the scope is visible), plus **"Use suggested bins"**
  — an explicit action, never a default, because the standing rule is that a bin
  is suggested and never forced.

### Split lines — one SKU, several bins, different batches and serials

Per the user: *"allow split lines as same sku, of larger quantities can sit in
different locations, they can have different batch/serial no too."*
`doPutaway()` is per-DESTINATION, not per-SKU: the caller sends one item per
bin, each with its own qty, `lot_number`/`expiry_date` and `serials[]`. The
"+ another bin" button splits the quantity OFF the row above rather than adding
on top, so the destinations can never total more than the line has left.

**`serials` gained `location_id` and `lot_number` columns** (`_migrateSerialLocation`)
and `inventory.placeSerials()` is new. A serial identifies one physical unit, so
once binned the registry has to say WHICH bin — otherwise a split line is only
half recorded. A serial never captured at receiving is registered now rather
than dropped (the crew reading it off the carton is the first time the system
could know it); a serial already **shipped** is never re-homed.

Refused, because both are contradictions rather than preferences: more serials
than units on a destination, and the same serial listed twice.

Verified 13 checks: 30 pcs to three bins in one action with three different
batches, stock landing 10/15/5 and adding back to 30, each serial recorded
against the bin AND the batch of its own split, a 31st piece refused, and both
serial contradictions refused.

### `inventory.suggestPutaway()` — a ranked shortlist, with reasons

`GET /api/putaway/suggest?client=&sku=&qty=`. HARD CONSTRAINTS filter first (bin
active, unit headroom left, carton physically fits when BOTH carton and bin are
measured — an unmeasured warehouse must still get suggestions). Then, in order:

1. **CONSOLIDATE** — a bin already holding this SKU. Fewest bins per SKU is the
   biggest picking win. A bin holding the SAME lot/expiry scores above one
   holding a different lot, so a bin stays easy to pick FEFO from.
2. **HOME BIN** — where the SKU has historically been put away, even if empty
   now. Pickers build muscle memory; moving a product's home costs more than the
   space it saves. Read from `stock_movements.to_location` — there is no
   `location_id` column on that table, and reading the wrong one silently
   returns no home.
3. **PICK FACE THEN BULK** — top the pick face up to capacity, overflow to bulk.
   This is what stops a full pallet being crammed into a shelf that holds a day's
   picking. The plan is returned as a split (`qty` per bin) that adds up.
4. **SMALLEST BIN THAT FITS** — a pallet location is worth more than a carton
   needs.

Plus **heavy cartons (≥ `PUTAWAY_HEAVY_KG` = 15kg) prefer a low shelf** — an
ergonomics rule, judged on the shelf label's ordering and said plainly rather
than dressed up as a calculation.

EVERY suggestion carries a `reason` string that the screen shows ("already holds
this batch · its usual bin · pick face"). It is **always a suggestion, never
forced**: the receiver scans the bin they actually used, and over-capacity is a
confirmable fact with a recorded reason, not a refusal.

### The location grammar — Row / Bay / Level / Location, and the floor tier

Per the user: *"AA-01-04-02, means Row AA, Bay 1, Level 4, Location 2"*, and
*"locations with 99-01-01, such as this formats are what we call floor
locations … when XX is 01, it means its tier is on the floor thus YY regardless
01,02,03, it would be all on the floor"*. `parseLocationId(id)` returns
`{tier, level, row, bay, pos, bonded, label}`:

- `^\d{2,3}-\d{1,3}-\d{1,3}$` (`99-01-01`, `090-001-001`) → **floor**.
- `^[A-Z][A-Z0-9]{0,3}-\d{1,3}-\d{1,3}(-[A-Z0-9]{1,2})?$` → the THIRD part is
  the level; **level 1 is floor**, everything above is `rack`.
- Anything else → `unknown`, and `unknown` is never silently guessed at.

**IT READS THE location_id AND NOTHING ELSE.** The zone/aisle/shelf/bin columns
cannot carry this: in the client's own 10,438-bin sheet, `zone` says "FLOOR A"
on level-4 racking — it is a *storey*, not ground level, so matching on the word
"floor" would call the whole warehouse prime pick space — and `AA-003-001-A`
imported as `shelf=1, bin=3`, i.e. the bay landed in `bin` and the `-A` was lost.
Measured against that real file: **2,973 floor, 6,979 rack, 486 unreadable.**

`tier`/`level_no`/`row_code`/`bay_code` are STORED on `warehouse_locations`
(derived at import by `_stampLocationTiers`, re-stamped after every bulk racking
change) so the engine can filter in SQL and an admin can correct a bin the
grammar reads wrongly. `tier_locked=1` makes a hand correction survive
re-stamping; passing `tier:''` to `updateLocation` hands it back to the grammar.

**BONDED AREAS ARE EXCLUDED OUTRIGHT, not scored down** — a bonded bin is
customs-controlled, so putting ordinary stock there is a compliance problem
rather than a preference. Matched on `/BOND/i` in the id or zone. It can still
be typed in by hand, and the count of skipped bonded bins is shown on screen so
the exclusion is visible rather than mysterious.

### Fast movers get the floor — `skuVelocity()`

Per the user: *"if a cargo moves almost daily or more than 20% of the inventory
moves per week, its a fast mover"*, and the 20% is **of that SKU's own on-hand**
(confirmed explicitly). So a SKU is `fast` when EITHER holds:

- it shipped on **≥70% of the days** in a 28-day window (`VELOCITY_DAILY_RATIO`), or
- **≥20% of its own on-hand ships per week** (`VELOCITY_WEEKLY_PCT`), averaged
  over 28 days rather than one raw week so a single busy Monday cannot promote it.

`VELOCITY_MIN_UNITS` (10) exists because the percentage is meaningless on tiny
numbers — 1 unit shipped against 2 on hand reads as 50% and would send a
nothing-SKU to prime floor space. Tiers are `fast` / `medium` / `slow` (nothing
in the window) / **`new`** (no history at all). `new` is deliberately NOT treated
as slow and never promoted to the floor: no evidence is not evidence.

COMPUTED ON READ, never stamped. `inventory.last_moved_at` is exactly the trap
to avoid — a column nothing writes. `stock_movements` is the source, and
`reserve`/`release` are excluded because allocating stock moves no piece.

HONEST LIMITATION: `outbound` movements are only written when an order completes
through scanning, so on a fresh site every SKU reads `new` for the first few
weeks and the tier rule simply does not fire. It degrades to the previous
behaviour rather than guessing.

### The full suggestion ladder

Same-SKU consolidation still wins — splitting one SKU across two bins costs the
pickers more than a slightly worse level, so **velocity is a modifier, not a
gate**:

1. same SKU + same lot · 2. same SKU · 3. its usual home bin ·
4. **velocity tier** (fast → floor +50, fast → level ≥3 −25, slow → floor −20) ·
5. **same client together** (their row +35, their zone +12) ·
6. pick face before bulk · 7. smallest bin that fits.

**Heavy outranks velocity when they compete for the same floor bins** — a 15kg+
carton cannot be lifted to level 4 whatever its turnover, so that rule is scored
as the safety constraint it is (+45 on floor, and a penalty that grows with the
level). When a fast mover cannot get a floor bin the response SAYS SO
(`"This is a fast mover but no floor location is free"`) rather than quietly
degrading.

Every suggestion carries `where` — the bin in warehouse words, "Row AA · Bay 1 ·
Level 1 (floor) · 01" — beside the raw code, and a fast mover shows an amber
pill with the figure that earned it ("ships on 25 of the last 28 days"), not
just a label.

NOT DONE, deliberately: **ABC zoning by walking distance** (fast movers near the
pack bench). Nothing in the data says where the bench is, so "near" has no
meaning yet. And **re-slotting existing stock** — once velocity is known the
system can see fast movers already sitting on level 04, but telling someone to
move them belongs in its own move-list with labour attached, not in a screen
asking a receiver to relocate stock that is not in their hands.

Verified 25 API checks (the user's own examples parse exactly; level 02 is not
floor; both fast-mover rules fire independently; slow does not squat on the
floor; `new` gets no claim either way; a client's row is offered when the SKU
has no bin; bonded never appears for any SKU or quantity; a 22kg carton goes
low; consolidation still beats the tier) plus 9 browser checks on desktop and a
Pixel 5, and the 35 + 23 earlier putaway checks re-run green.

Verified 35 API checks (one scan = one piece, a keyed 47 in one go, eventId
dedupe at qty 10, the discrepancy-photo rule still enforced, staging issued
automatically covering all 68 units, the queue draining exactly as lines are
binned, a split across pick+bulk that adds up, a heavy carton sent low, a second
delivery consolidating into the bin the SKU already lives in) plus 27 browser
checks on desktop and a Pixel 5.

## Inbound putaway — now, or stage it with a printed ID (SUPERSEDED — see above)

Per the user: the crew scans the ASN/PO, then the goods go either to a final
bin or to a staging area. The moment a receipt is ended the crew is ASKED which,
because they know right then and an unrecorded pallet on the floor is exactly
what goes missing.

- **NOW** → the existing putaway screen (`POST /api/inbound/:id/putaway`), where
  a real bin must be scanned or typed. Unchanged; already had capacity checks,
  expiry/lot capture and override reasons.
- **LATER** → `POST /api/inbound/:id/stage` issues a **staging ID**
  (`nextStagingCode`, `ST-YYMMDD-NN`, own per-SGT-day counter like the inbound
  and outbound serials), optionally tagged with a staging area ("Bay 3"), and
  records exactly which SKUs and quantities that label covers. Printed via
  `GET /api/inbound/:id/staging-label/:code` + `printStagingLabel()` — the same
  window.open + JsBarcode + print pattern as the carton slip — so the code is
  scannable back off the pallet.

STAGING IS NOT A NEW STOCK STATE. End Receipt already added the units;
`inventory.stagingQty()` already means "on hand but not in a bin". What was
missing was the paper trail saying WHICH pallet is which and what is still owed
a bin — that is all this adds.

`stagingOutstanding(rec)` subtracts BOTH prior putaway AND prior staging.
Without the second subtraction a repeat stage issued a fresh label claiming the
same cargo, so two printed IDs would each say they held the same pallet and the
outstanding-putaway figure would read double what was really on the floor.

Verified 13 API checks: a staging ID is issued in the right format covering all
10 pcs / 2 SKUs with the area recorded; the label carries code, receipt serial,
client and per-SKU descriptions; an unknown code 404s; staging shows on the
inbound record; putaway-now places into a real bin and a later stage then covers
only the 6-pc remainder; staging before End Receipt is refused; and staging
twice does not re-stage the same cargo.

## The item master is the DEFAULT lookup, in both directions

Per the user: once a client's item master is loaded at onboarding, it applies
throughout — receiving, orders, inbound — and a client's file need carry only
ONE of SKU or barcode, with no description at all. The catalogue supplies the
rest. *"A lookup is always the default. Don't need to rely on the upload file to
contain both information."*

- **`catalogueLookup(cid, sku, barcode)`** — one lookup used in both directions.
  Tries SKU, then barcode, then **the SKU field as a barcode** and the reverse
  (files put them in the wrong column), then `resolveBeTimeCode2` for the
  official CODE2 listing and learned barcodes.
- **`enrichLinesFromCatalogue(lines, clientName)`** (aliased as
  `enrichInboundLines`, the name existing call sites use) fills AND
  **CANONICALISES**. The re-keying is the part that was missing: it used to fill
  blanks only (`if (!l.sku) l.sku = rec.sku`), so a file whose SKU column held
  BARCODES produced barcode-keyed lines, and stock, reservations, reports and
  the pick list were all filed against a code matching no product.
- **THE CATALOGUE'S NAME WINS** — it does not merely fill an empty description.
  Filling-if-blank was not enough: a real file had no description column and the
  column detector mapped the CLIENT NAME into it, so every pick line read
  "Mayer2026". Once a line resolves to a catalogue product, the catalogue knows
  what that product is better than the order file does. The file's own wording is
  kept as `source_description` — which had to be named explicitly in
  `summarizeOrders`, since that function drops any field not in its list (the
  first version of this silently lost it, making the code comment a lie).
- Call sites: `/api/upload` (after `normalizeOrderRowsToInhouseSku` +
  `explodeBundleRows`) and **`/api/preview`, which previously did no
  normalisation at all** — so what an approver saw could differ from what the
  upload then created. Preview now runs the same calls, and grouping happens
  AFTER re-keying.
- CONSEQUENCE WORTH KNOWING: a file listing one product twice — once by SKU,
  once by barcode — now yields two lines with the SAME real SKU, so the existing
  duplicate-line safeguard can finally SEE it. Duplicates are still deliberately
  **not merged** (a genuine split pick vs a data-entry duplicate is a human
  call); the warning names the SKU and the combined qty.
- An unlisted line is never dropped: it keeps the file's own description, is
  flagged `unknown_product`, and `/api/preview` says
  "⚠ N line(s) are not in this client's item master … check the item master is
  loaded under the same client name" — which is the usual real cause.

Verified with the client's own 254-row Product Master under `Mayer2026`: an
order file with BARCODES in the SKU column and no description column produced
correct SKUs (`9557496058448` → `FJMHV9812DRWXXXXXPHML`), real product names, no
barcode-shaped SKUs anywhere, and the duplicate warning fired (10 checks). Plus
6 regression checks on an ordinary file: the catalogue name wins, the client's
wording survives as `source_description`, an unlisted SKU keeps its own text and
is reported, and row/order counts are unchanged.

STILL SKU-ONLY (flagged, not done): putaway, serial capture and cycle counts do
not resolve barcodes.

## Receiving resolves BARCODES, not just SKUs (`/api/inbound/:id/scan`)

Reported from the floor: a client's Product Master was uploaded (254 rows, every
row carrying a `Barcode (EAN/UPC)`), the PO listed those SKUs, yet scanning the
printed barcodes during receiving showed every piece as **"Not on PO"**.

Cause — receiving compared the scanned string against the line's SKU and nothing
else:
```js
const line = (rec.lines || []).find(l => l.sku.toUpperCase() === raw.toUpperCase());
```
A barcode can never equal a SKU, so it always fell through to "unlisted". Two
consequences, the second worse than the first: the receiver is told the item is
not on the paperwork, AND the stock is banked under a **phantom SKU equal to the
barcode** — a product that matches nothing in the catalogue and never
reconciles. Outbound scanning has had the full chain for a long time
(`matchScannedSku`); receiving simply never got it.

Order of resolution now, in `/api/inbound/:id/scan`:
1. exact SKU (case-insensitive) — unchanged, so nothing that worked stops working
2. **the PO line's own `barcode`** — `enrichInboundLines` already fills this from
   the item master at upload AND on read, so this step alone fixes the common
   case even when the catalogue is unavailable
3. `matchScannedSku(...)` — NP-suffix equivalence, packer-taught aliases, and the
   client's item-master barcode → SKU cross-reference
4. and if STILL unmatched (a genuinely unlisted item, or a `'return'` job, which
   has no expected list at all) the barcode is resolved against the catalogue
   anyway, so received stock is filed against the real product rather than under
   a barcode-shaped SKU. `resolveBeTimeCode2` runs first, as outbound does.

An unlisted item is still ACCEPTED, never blocked — that rule is unchanged.

### Why the onboarding "test a code" check passed anyway

The user's fair question. `GET /api/master/client-profiles/:client/test-resolve`
queried the catalogue DIRECTLY (`inventory.get` / `inventory.getByBarcode`) and
reported `found: true`. That only ever proved the item master holds the mapping —
it said nothing about whether any SCANNER consults it, and receiving did not. So
the barcodes tested green and still came up "Not on PO" on the floor. **A test
that can pass while the thing it names is broken is worse than no test.**

Fixed by construction, not by adding another assertion: the shared
`resolveCodeToCatalogueSku(raw, clientId)` (CODE2/learned → SKU → barcode) is
called by BOTH receiving and this endpoint, so a green test and the floor cannot
diverge — they run the same function. The response now also reports
`surfaces: {catalogue, inboundReceiving, outboundPicking}`, `scansAs` (the SKU a
gun would actually book against), and a plain-English `warning` for the two
failure shapes that matter: in the master but won't resolve when scanned, or not
in this client's master at all (→ check the client name it was uploaded under).

Verified 10 checks: the test's `scansAs` matches what receiving actually records
for a barcode on the PO, the SKU itself, and a catalogue barcode on no PO; and
an unknown code warns about the client name instead of failing silently.

Verified with the client's own file: product master imported 253/254 (row 230
has no Product Name — a real gap in the source file, reported not silently
dropped), all three reported barcodes now resolve to their SKUs
(`9557496058448` → `FJMHV9812DRWXXXXXPHML` etc.), and `state.scanned` is keyed
by SKU with no barcode-shaped phantoms. The pre-fix code fails 4 of those 7
checks, so the test genuinely reproduces the report. Plus 7 regression checks:
SKU and lowercase-SKU scans still match, an unknown code is still accepted, an
off-PO catalogue barcode resolves to its real SKU (and is still counted as an
extra), a RETURN resolves barcodes too, and the damaged condition and eventId
idempotency both still hold through the new path.

## Label PDFs — one pipeline for staff uploads AND client submissions

`processLabelPdf(buffer, filename, uploadedBy)` is the single implementation:
page split → per-page text extraction → `extractLabelFields` → match against
`buildLabelMatchIndex()` → first-write-wins attachment into `db.orderLabels`.
`POST /api/label-imports` is a thin wrapper around it, and approving a
client-submitted `kind:'labels'` submission calls the same function, so a
waybill a CLIENT sends through their portal is recognised exactly the way one
we upload ourselves is.

**The OCR pass belongs inside that function, not after it.** Image-only pages
(no text layer) can't match on first pass, so `processLabelPdf` ends by kicking
off `rematchLabelImport(importId, false)` via `setImmediate`, which renders and
OCRs them (full-page rasterisation when `@napi-rs/canvas` + pdfjs are
available, else embedded-image extraction) and caches the text so later
rematches are instant. This used to sit in the ROUTE, where it referenced
`pages` — a variable the extraction moved out of scope. It threw AFTER
`res.json` had been sent, so the catch could not respond: no error surfaced
anywhere and image-only labels silently stopped being OCR'd. Keep it inside the
function; every caller needs it.

### OCR IS PART OF READING A LABEL, NOT AN AFTERTHOUGHT

VERIFIED ON A REAL SCANNED WAYBILL (a 6-page Lazada/Speedpost AWB from the
client). It has **no text layer at all** — `extractPdfPageTexts` returns `''`
for every page — so a text-only read reported "nothing readable on this page"
six times and matched 0 of 6, which is exactly what the client saw.

`pageTextsWithOcr(buffer)` is now the single way a label PDF is read: text
layer first (instant, exact), then OCR **only** the pages that came back empty,
reusing ONE Tesseract worker. Used by BOTH `matchLabelsAgainstDraft` (the
client's step-2 preview) and `processLabelPdf` (the office import and the
approval path), so the two can never disagree.

- Measured on the real file: **~1.9s a page, 11s for six**, and all six
  tracking numbers come out exactly right.
- **Match on the TRACKING number, not the order number.** OCR reads
  `LZSGD1015082878` perfectly — it is large, and printed 8+ times down both
  sides of the label — while the small `Order No:` line comes back with the odd
  digit wrong (`169103066792054` → `169102066792054`). `matchLabelPage`'s
  `scanKeys` pass finds the tracking number anywhere in the OCR text, so this
  works as long as the client's order file carries the waybill column (see the
  `waybill_ref` mapping fix above — the two fixes are load-bearing together).
- `OCR_PREVIEW_PAGE_CAP` (80) and `OCR_PREVIEW_MS_BUDGET` (45s) bound the
  request. Anything past them is left to the existing background
  `rematchLabelImport`, and the client is TOLD how many were left.
- WHY IT ALSO WENT INTO `processLabelPdf`: the background rematch did
  eventually OCR and attach all six — about 12 seconds after approval. But the
  approver was shown "0 of 6 matched" at the moment they clicked, which is a
  number that reads as a failure. What someone reads when they approve has to
  be true, so the OCR happens in the first pass.
- Fallback when no rasteriser is available: the largest embedded image on the
  page, which IS the whole label whenever the page is one bitmap.

Verified 13 checks on the client path (image-only PDF, 6/6 matched in the
preview, 6/6 filed against the live orders on approval, every order carrying
its label) and 5 on the office Labels import with the same file (6/6 matched
straight away, not after a delay).

FIXTURE WARNING, kept because it cost real time: synthetic PDFs are useless
here. A `pdf-lib`-generated file is unreadable by this repo's `pdf-parse`
("bad XRef entry"), which once produced a false "the staff path is broken"
conclusion. Generate test PDFs by printing HTML through headless Chromium, or
use a genuine carrier file.

Also worth knowing: `buildLabelMatchIndex`'s `scanKeys` fallback only accepts a
normalised key of **≥8 chars (10 if all digits)**, so short order numbers can
never match by text scan. That guard is deliberate — it stops a 4-digit code
matching random text on a label.

## Rollback points — named snapshots of a known-good state

Written down HERE, in the repo, because a git tag created in a sandbox is not
pushable through this remote's git proxy and would be lost with the session. The
commit sha is the durable identifier; the name is just what a human says.

| Say this | Code = commit | Precedes |
|---|---|---|
| **"roll back to before the client portal upload"** | `1eb36b2` | the client-portal order/waybill submission + office approval workflow |

To roll the CODE back to one of these:
```
git checkout -B claude/ecommerce-order-dashboard-cxMNo 1eb36b2   # then force-with-lease push
```

CODE AND DATA ROLL BACK SEPARATELY — a commit cannot restore db.json or the
inventory SQLite store. Take the data snapshot BEFORE shipping anything risky:
- `POST /api/master/backups/run-now` (master key) writes a full gzip snapshot to
  the volume — db.json + all 13 inventory tables + config; or Administrator →
  Backups → Run Backup Now.
- `GET /api/master/backup` downloads the same thing as JSON to your own machine.
- Restoring inventory from one: `POST /api/master/backups/:file/restore-inventory`.
  There is deliberately NO whole-db restore endpoint — putting db.json back is a
  manual, deliberate act on the volume.

When adding a new rollback point: append a row here IN THE SAME COMMIT that
records it, so the name and the sha can never drift apart.

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
