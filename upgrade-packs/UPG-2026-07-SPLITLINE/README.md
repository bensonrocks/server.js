# UPG-2026-07-SPLITLINE — "Split-Line Closing" v1.0

**Upgrade name:** SPLITLINE (Split-Line Closing)
**Source:** IDEALSCAN, branch `claude/order-processing-wms-fulfillment-6mf8o4`, commit `4b4a073`
**Date:** 2026-07-27
**Field report:** Order GI-132076 (National Skin Centre / betime) — same SKU on
two lines (1 pc + 12 pcs) could not be closed line by line and the order could
never complete.

---

## What this upgrade does

An order file can list the SAME SKU on several lines (e.g. UR4834 × 1 on one
line and UR4834 × 12 on another). Scanning is tallied per SKU, so before this
upgrade every one of those lines displayed the SKU's combined total, the
pieces-left counter double-counted, and the completion check compared each
line against the same aggregate — the order was impossible to complete.

After this upgrade **each line is a unique picking unit**:

- The SKU's scan total is allocated across its lines **in file order** —
  earlier lines fill first. One scan closes the 1-pc line at 1/1 ✓; the next
  twelve fill the 12-pc line to 12/12 ✓. Each line closes independently.
- Any genuine over-scan shows **only on the SKU's last line**, so overage is
  visible in one place.
- Scan feedback compares against the SKU's aggregate ordered quantity
  ("UR4834: 13/13 ✓ Complete" — no false OVER).
- Per-row manual quantity edits change **that line's** share, not the whole
  SKU total.
- Completion mismatch check, completion-slip export, teach-barcode item list
  and carton slip all use the same line-level view (the last two aggregate
  per SKU instead of printing duplicate rows).

**No data migration.** Stored scan state stays per-SKU totals
(`state.scanned[sku]`); the allocation is computed at read time. In-flight
orders redistribute correctly the moment the new build loads.

## The core algorithm (portable)

Both server and client use the same ~12-line waterfall. If the target codebase
diverges, port this function and apply it at every line-level read of scans:

```js
// Returns one allocated qty per line, same order as ord.lines.
// Earlier lines fill first; the SKU's LAST line absorbs any overflow.
function allocateScansToLines(ord, scanned) {
  const linesLeft = {};
  for (const l of ord.lines || []) linesLeft[l.sku] = (linesLeft[l.sku] || 0) + 1;
  const pool = { ...(scanned || {}) };
  return (ord.lines || []).map(l => {
    const have = pool[l.sku] || 0;
    linesLeft[l.sku]--;
    const take = linesLeft[l.sku] === 0 ? have : Math.min(have, l.qty || 0);
    pool[l.sku] = have - take;
    return take;
  });
}
```

Integration points to cover in the target app (everywhere scans are read
per line):

| # | Touchpoint | Change |
|---|-----------|--------|
| 1 | Scan-screen items table render | per-line qty = allocation, row closes when its share is full |
| 2 | Progress badge ("N/M items") + pieces-left counter | count via allocation (fixes double-count) |
| 3 | Per-row manual qty input | new SKU total = other lines' shares + typed value |
| 4 | Order completion / mismatch check | compare each line against its allocation |
| 5 | Completion-slip / status export | per-line scanned = allocation |
| 6 | Scan feedback message | ordered qty = SUM of the SKU's lines |
| 7 | Teach-barcode item picker | one entry per SKU, quantities aggregated |
| 8 | Carton content slip | iterate per-SKU scan totals, not per line |

## How to apply

- **Same codebase lineage:** `git apply` (or `git am`)
  `0001-splitline-line-by-line-closing.patch` — it touches only `server.js`
  and `public/app.js`.
- **Diverged codebase:** port `allocateScansToLines` and walk the
  8 touchpoints above. The patch file shows the reference implementation of
  each.

## Acceptance test (must pass before shipping)

Seed an order with the same SKU on two lines, qty 1 + qty 12:

1. Scan the SKU once → line 1 shows 1/1 ✓ closed; line 2 shows 0/12; progress "1/2 items".
2. Scan 12 more → line 2 shows 12/12 ✓; progress "2/2 items"; feedback "13/13 Complete".
3. Complete → succeeds, **no mismatch dialog**.
4. Scan once more before completing → only the LAST line shows 13/12 over.
5. Regression: single-line orders behave exactly as before.
