# UPG-2026-07-PRINTDIRECT — "Print Direct" v1.0

**Upgrade name:** PRINTDIRECT (print from preview + prompts wait for the user)
**Source:** IDEALSCAN, commits `cace3b9` + `1487c01`, 2026-07-27
**Field report:** (1) Printing a matched label saved a PDF to the desktop that
the packer then had to find and open. (2) The "Print Matched Label?" prompt
auto-dismissed after 3 s — once it skipped itself the label was hard to find
again (reported by floor staff with screenshot).

## What it changes

1. **Direct print (`cace3b9`):** the print prompt fetches the PDF and opens
   the browser's print dialog straight from the preview via a hidden iframe —
   nothing lands on the desktop. Falls back to opening the PDF in a new tab
   if iframe printing is blocked. Explicit download buttons elsewhere keep
   downloading.

   ```js
   async function authPrintPdf(url) {
     const resp = await fetch(url);                       // auth headers injected
     const blob = new Blob([await resp.arrayBuffer()], { type: 'application/pdf' });
     const blobUrl = URL.createObjectURL(blob);
     const frame = document.createElement('iframe');
     frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;visibility:hidden;';
     frame.onload = () => setTimeout(() => {
       try { frame.contentWindow.focus(); frame.contentWindow.print(); }
       catch { window.open(blobUrl, '_blank'); }
     }, 150);
     document.body.appendChild(frame);
     frame.src = blobUrl;
   }
   ```

2. **No auto-skip (`1487c01`):** completion print prompts (modal AND toast
   variants) stay on screen until the packer explicitly clicks Print or Skip.
   Countdown timers, bars and "auto-skipping in Xs" text removed.

## How to apply

Frontend-only (`public/app.js`, `public/index.html`, `public/styles.css`).
Same lineage: `git am` the patch (2 commits). Diverged: add `authPrintPdf`,
point the prompt's Print button at it, and delete the prompt countdown logic.

## Acceptance test

1. Complete an order with a printable document → prompt appears and STAYS
   (wait >5 s, still there).
2. Click Print → browser print dialog opens with the PDF preview; no file in
   Downloads.
3. Click Skip → prompt closes, focus returns to the scan/search input.
4. Serve the PDF endpoint without `Content-Disposition: attachment` for the
   print path (inline) so the new-tab fallback previews instead of downloading.
