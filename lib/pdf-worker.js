'use strict';
// PDF work that used to run on the request thread — text extraction
// (pdf-parse), full-page rasterisation (pdfjs + @napi-rs/canvas) and page
// splitting (pdf-lib). Each of these holds the CPU for hundreds of ms to
// seconds per page, and on the single Node thread that meant every user's
// click queued behind a label import. This file runs in a worker_thread
// (see lib/pdf-pool.js); it must never require server.js.
const { parentPort } = require('worker_threads');

let pdfParse = null, pdfjsLib = null, napiCanvas = null, PDFDocument = null;
try { pdfParse = require('pdf-parse'); } catch {}
try { pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); } catch {}
try { napiCanvas = require('@napi-rs/canvas'); } catch {}
try { ({ PDFDocument } = require('pdf-lib')); } catch {}

let renderAvailable = false;
try {
  if (napiCanvas && pdfjsLib) {
    const c = napiCanvas.createCanvas(8, 8);
    c.getContext('2d').fillRect(0, 0, 8, 8);
    renderAvailable = true;
  }
} catch {}

class NapiCanvasFactory {
  create(width, height) {
    const canvas = napiCanvas.createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(c, width, height) { c.canvas.width = width; c.canvas.height = height; }
  destroy(c) { c.canvas.width = 0; c.canvas.height = 0; }
}

// Identical to server.js extractPdfPageTexts — one page string per page, a
// newline wherever the baseline moves.
async function pageTexts(buffer) {
  const out = [];
  if (!pdfParse) return out;
  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent();
      let last = null, text = '';
      for (const item of tc.items) {
        if (last && last.transform[5] !== item.transform[5]) text += '\n';
        text += item.str;
        last = item;
      }
      out.push(text);
      return text;
    },
  });
  return out;
}

// Identical to server.js renderPdfPageToPng — null when nothing can render.
async function render(buffer, pageIndex, scale) {
  if (!renderAvailable) return null;
  let doc = null;
  try {
    const factory = new NapiCanvasFactory();
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, canvasFactory: factory }).promise;
    const page     = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });
    const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise;
    return await canvas.encode('png');
  } catch (e) {
    return { error: e.message };
  } finally {
    if (doc) doc.destroy().catch(() => {});
  }
}

// One single-page PDF per page of the source, in order — what processLabelPdf
// and splitWaybillPdf did inline with pdf-lib.
async function splitPages(buffer) {
  const src = await PDFDocument.load(buffer);
  const n = src.getPageCount();
  const pages = [];
  for (let i = 0; i < n; i++) {
    const single = await PDFDocument.create();
    const [pg] = await single.copyPages(src, [i]);
    single.addPage(pg);
    pages.push(Buffer.from(await single.save()));
  }
  return pages;
}

parentPort.on('message', async (msg) => {
  const { id, op, args } = msg;
  try {
    let result;
    if (op === 'ping')       result = { renderAvailable, pdfParse: !!pdfParse, pdfLib: !!PDFDocument };
    else if (op === 'pageTexts')  result = await pageTexts(Buffer.from(args.buffer));
    else if (op === 'render')     result = await render(Buffer.from(args.buffer), args.pageIndex, args.scale);
    else if (op === 'splitPages') result = await splitPages(Buffer.from(args.buffer));
    else throw new Error('unknown op ' + op);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e && e.message || String(e) });
  }
});
