# UPG-2026-07-SCANGUARD — "Scan Guard" v1.0

**Upgrade name:** SCANGUARD (double-scan / concatenated-barcode protection)
**Source:** IDEALSCAN, commit `0091853`, 2026-07-27
**Field report:** Packing station showed "Unrecognized barcode
84140028414002078059" — a leftover 7-char fragment (`8414002`) glued to the
real EAN-13 (`8414002078059`).

## The defect it fixes

Scanner keystrokes arriving while a modal/prompt is open were *ignored but not
blocked*: they still landed in the still-focused scan input behind the dialog.
The next scan then submitted `leftover fragment + real barcode` as one bogus
token. Applies to ANY app with a global scan-capture input and modals.

## Three defence layers

1. **Block, don't just ignore:** keystrokes during an open modal clear the
   scan buffer/input and are `preventDefault()`ed away from the background
   input (except when a modal's own input field has focus).
2. **Discard interrupted scans:** a buffer flush that fires while a modal is
   open drops the fragment instead of submitting it.
3. **Un-doubling safety net:** an *unresolved* all-digit token whose tail is a
   standard barcode length (GTIN-14 / EAN-13 / UPC-A / EAN-8) starting with
   exactly the leading fragment is retried as the tail. Only runs AFTER the
   original failed to resolve — a legitimate code is never rewritten.

```js
function _stripDoubleScan(val) {
  if (!/^\d{9,}$/.test(val)) return val;
  for (const n of [14, 13, 12, 8]) {
    if (val.length > n) {
      const code = val.slice(-n), frag = val.slice(0, val.length - n);
      if (frag.length <= n && code.startsWith(frag)) return code;
    }
  }
  return val;
}
```

## How to apply

Frontend-only (one file: `public/app.js`). Same lineage: `git apply` the
patch. Diverged: port the three layers into the target's scan-capture handler
(`keydown` guard, flush guard, and the un-doubling check at the
unknown-barcode branch).

## Acceptance test

1. Open any modal on the scan screen, fire the scanner → scan input stays empty.
2. Submit `<frag><code>` (e.g. `84140028414002078059`) where the code is
   unknown → the teach/unknown dialog shows the REAL code (`8414002078059`).
3. If the real code IS known → the item simply counts; no dialog.
4. Normal scans, alphanumeric SKUs, and short numeric SKUs are untouched.
