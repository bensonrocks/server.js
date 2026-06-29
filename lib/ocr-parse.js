// lib/ocr-parse.js — Parse OCR text from a photographed picking list
'use strict';

// Listed in priority order — first match wins across the whole document.
// Reference / PO are preferred over Pick Ticket / Issue No because they
// are the customer-facing order identifiers used in downstream WMS.
const ORDER_PATTERNS = [
  /reference\s*[:\s]+([A-Z0-9][A-Z0-9\-\/]{3,})/i,
  /po\s*(?:number|no\.?)?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/]{3,})/i,
  /order\s*(?:no\.?|number|ref)?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/]{3,})/i,
  /invoice\s*(?:no\.?|number)?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/]{3,})/i,
  /doc(?:ument)?\s*(?:no\.?|number)?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/]{3,})/i,
  /packing\s*list\s*(?:no\.?|number)?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /delivery\s*(?:note|order)?\s*(?:no\.?)?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/]{3,})/i,
  /consignment\s*(?:no\.?|number)?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/]{3,})/i,
  /pick\s*(?:ticket|list|no\.?|number)\s*[:\s#\-]+([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /pt\s*(?:no\.?|number)?\s*[:\s#\-]+([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /issue\s*(?:no\.?|number)?\s*[:\s]+([A-Z0-9][A-Z0-9\-\/]{2,})/i,
];

// Stop parsing data rows when we hit these footer/summary lines
const STOP_PAT = /^(total\s+whole|total\s+loose|grand\s+total|picked\s+by|checked\s+by|released\s+by|start\s+pick|end\s+pick|print\s+date|remarks?\s*:|page\s+\d)/i;

// Words that must never be treated as a SKU
const SKIP_SKU = new Set([
  'total','grand','subtotal','delivery','status','pick','picking',
  'remarks','remark','note','notes','account','reference','consignee',
  'address','date','time','name','description','desc','uom','unit',
  'whole','loose','lhu','batch','expiry','serial','lot','each','carton',
  'carto','pcs','pieces','qty','quantity','weight','pallet','box','no',
  'day','start','end','fini','print','page','by','and','for','the',
  'location','sku','item','product','sno','seq',
]);

function isTableHeader(line) {
  const lc = line.toLowerCase();
  const hasItem = /\b(item|sku|product|barcode|code|part|material|article|location|desc(?:ription)?)\b/.test(lc);
  const hasQty  = /\b(qty|quantity|pcs|pieces|count|uom|whole|loose|lhu)\b/.test(lc);
  const hasBatch = /\b(batch|lot\s*no|expiry)\b/.test(lc);
  return (hasItem && hasQty) || (hasItem && hasBatch);
}

function parseOcrPicklist(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // ── 1. Order number: try patterns in priority order across all lines ───────
  let orderNumber = null;
  for (const re of ORDER_PATTERNS) {
    for (const line of lines) {
      const m = line.match(re);
      if (m && m[1]) {
        const cand = m[1].replace(/[^A-Z0-9\-\/]/gi, '').toUpperCase();
        if (cand.length >= 2) { orderNumber = cand; break; }
      }
    }
    if (orderNumber) break;
  }
  if (!orderNumber) orderNumber = `OCR-${Date.now()}`;

  // ── 2. Find table header row ───────────────────────────────────────────────
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTableHeader(lines[i])) { headerIdx = i; break; }
  }

  // ── 3. Parse data rows ────────────────────────────────────────────────────
  const rows = [];
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 0;

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (STOP_PAT.test(line)) break;

    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 3) continue;

    // Qty: last token that is a plain integer within a sensible range
    let qty = null, qtyIdx = -1;
    for (let t = tokens.length - 1; t >= 1; t--) {
      const clean = tokens[t].replace(/,/g, '');
      if (/^\d+$/.test(clean)) {
        const n = parseInt(clean, 10);
        if (n > 0 && n < 100000) { qty = n; qtyIdx = t; break; }
      }
    }
    if (!qty || qtyIdx < 1) continue;

    // Skip leading row-number (S/N) if it's 1–4 digits
    const skuStart = /^\d{1,4}$/.test(tokens[0]) ? 1 : 0;

    // SKU: first token between skuStart and qtyIdx that looks like a product code.
    // Must: contain a digit OR a hyphen/underscore (rejects plain English words),
    //       not be a pure measurement like "100ml" or "250g",
    //       not be in SKIP_SKU.
    let sku = '';
    for (let t = skuStart; t < qtyIdx; t++) {
      const tok = tokens[t];
      if (tok.length < 3 || tok.length > 40) continue;
      if (SKIP_SKU.has(tok.toLowerCase())) continue;
      if (/^\d+[a-z]{1,3}$/i.test(tok)) continue;         // e.g. 100ml, 250g
      if (!/[\d\-_]/.test(tok)) continue;                  // must have digit or hyphen
      if (/^[A-Z0-9][A-Z0-9_\-\/]{2,}$/i.test(tok)) {
        sku = tok.toUpperCase(); break;
      }
    }
    if (!sku) continue;

    rows.push({
      order_number:     orderNumber,
      sku,
      qty,
      customer_name:    '',
      delivery_address: '',
      client_name:      '',
      tel:              '',
      waybill_number:   '',
      issue_no:         '',
      pick_ticket:      '',
      carrier:          '',
      platform:         '',
      shop_name:        '',
      date:             null,
      batch_number:     '',
      expiry_date:      null,
      remarks_betime:   '',
    });
  }

  return rows;
}

module.exports = { parseOcrPicklist };
