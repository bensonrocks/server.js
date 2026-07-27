# UPG-2026-07-LABELOCR — "Label OCR" v1.0

**Upgrade name:** LABELOCR (image-only shipping-label OCR matching, deploy-proof)
**Source:** IDEALSCAN, commits `0c82024` → `c5469d8` (4 commits), 2026-07-27
**Field report:** Real Lazada/Shopee KOLI label PDFs are rasterized scans with
NO text layer — pdf-parse extracts nothing, so every page sat unmatched
("ALL CANT MATCH WITH CURRENT UPLOADED ORDERS").

## What it adds

A last-resort OCR text source for label pages with no text layer, feeding the
same matcher used for real text:

1. **Rasterize** the single-page PDF to PNG:
   - try system `pdftoppm` (poppler-utils) first — fastest;
   - fall back to **pure-JS** `pdfjs-dist@3.11.174` + `@napi-rs/canvas`
     (plain npm deps, prebuilt binaries) — works on ANY host that ran
     `npm install`, immune to build systems ignoring nixpacks/apt. This
     fallback is what made it work on Railway when poppler silently
     failed to install.
2. **OCR** with tesseract.js using a **locally bundled** language model
   (`lib/tessdata/eng.traineddata`, ~23 MB) via `langPath` + `cachePath` +
   `gzip:false` — zero runtime network dependency (the default CDN fetch is
   blocked in many environments and was why OCR was disabled before).
3. **Background pass**: after a label-PDF upload responds, a `setImmediate`
   job re-reads no-text pages, OCRs them, tags `textSource:'ocr'`, and runs
   the normal despace-then-`includes` matcher. A manual Rematch action uses
   the same shared function.
4. **Diagnostics**: `GET /api/master/ocr-status` (master-gated) reports
   tesseract load, tessdata presence, pdftoppm availability, JS-rasterizer
   load, and runs a LIVE rasterize→OCR round trip on a generated test PDF,
   ending in a plain-English `verdict`. Use it before blaming matching logic.

## Files in the reference patch

`0001-labelocr-combined-reference.patch` is the combined diff of the 4 source
commits, EXCLUDING two things you must bring separately:

- **`lib/tessdata/eng.traineddata`** (23 MB binary): copy it from the
  IdealScan repo, or download
  `https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/eng.traineddata.gz`
  and gunzip into `lib/tessdata/`.
- **npm deps**: `npm i pdfjs-dist@3.11.174 @napi-rs/canvas tesseract.js`
  (package-lock diff intentionally excluded).

Optional: `nixpacks.toml` with `[phases.setup] nixPkgs = ["poppler_utils"]`
for the faster poppler path — the JS fallback covers you if it doesn't stick.

## How to apply

Server-side (`server.js`) + small frontend bits (OCR tag in the label page
list). Same lineage: `git apply` the reference patch, add the model + deps.
Diverged: port in this order — `runOcr` (bundled langPath), the two
rasterizers + `_rasterizePdfPage` chain, `_ocrLabelPage`, the shared rematch
function with the OCR step, the post-upload background pass, the diagnostic
endpoint.

## Acceptance test

1. Build a genuinely image-only PDF (render text to PNG, embed the PNG into a
   fresh PDF via pdf-lib — verify pdf-parse extracts "" from it).
2. Upload it as a label import for an order whose waybill it carries →
   within seconds the background pass matches it, method `waybill`,
   tagged OCR.
3. Hide `pdftoppm` from PATH and repeat → same result via the JS rasterizer.
4. `GET /api/master/ocr-status` → verdict "fully working", and it names
   which rasterizer ran.
