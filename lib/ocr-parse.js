// lib/ocr-parse.js — Parse OCR text from a photographed picking list
'use strict';

const ORDER_PATTERNS = [
  /pick\s*(?:ticket|list|no\.?|number)[:\s#\-]*([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /pt\s*(?:no\.?|number)?[:\s#\-]+([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /order\s*(?:no\.?|number|ref)?[:\s#\-]+([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /invoice\s*(?:no\.?|number)?[:\s#\-]+([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /doc(?:ument)?\s*(?:no\.?|number)?[:\s#\-]+([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /packing\s*list\s*(?:no\.?|number)?[:\s#\-]*([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /delivery\s*(?:note|order)\s*(?:no\.?)?[:\s#\-]*([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /consignment\s*(?:no\.?|number)?[:\s#\-]+([A-Z0-9][A-Z0-9\-\/]{1,})/i,
  /ref(?:erence)?\s*(?:no\.?)?[:\s#\-]+([A-Z0-9][A-Z0-9\-\/]{3,})/i,
];

function isTableHeader(line) {
  const lc = line.toLowerCase();
  const hasItem = /item|sku|product|barcode|code|part|material|article/.test(lc);
  const hasQty  = /qty|quantity|pcs|pieces|count|unit/.test(lc);
  return hasItem && hasQty;
}

/**
 * Parse OCR text of a photographed picking list into mapped row objects
 * compatible with summarizeOrders().
 */
function parseOcrPicklist(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // ── 1. Extract order / document number ──────────────────────────────────
  let orderNumber = null;
  for (const line of lines) {
    for (const pat of ORDER_PATTERNS) {
      const m = line.match(pat);
      if (m && m[1]) {
        const candidate = m[1].replace(/[^A-Z0-9\-\/]/gi, '').toUpperCase();
        if (candidate.length >= 2) { orderNumber = candidate; break; }
      }
    }
    if (orderNumber) break;
  }
  if (!orderNumber) orderNumber = `OCR-${Date.now()}`;

  // ── 2. Find table header row ─────────────────────────────────────────────
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTableHeader(lines[i])) { headerIdx = i; break; }
  }

  // ── 3. Parse data rows ───────────────────────────────────────────────────
  const rows = [];
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 0;

  for (let i = dataStart; i < lines.length; i++) {
    const tokens = lines[i].split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;

    // Find the quantity: last numeric token (ignore the final column if it
    // looks like a unit label such as "EA", "PCS", "EACH").
    let qty = null, qtyIdx = -1;
    for (let t = tokens.length - 1; t >= 1; t--) {
      const clean = tokens[t].replace(/,/g, '');
      const n = parseFloat(clean);
      if (!isNaN(n) && n > 0 && n < 100000 && /^\d/.test(clean)) {
        qty = Math.round(n); qtyIdx = t; break;
      }
    }
    if (!qty || qtyIdx < 1) continue;

    // Skip leading S/N if it's a small integer
    const skuSearchStart = /^\d{1,4}$/.test(tokens[0]) ? 1 : 0;

    // SKU: first code-like token between S/N and qty
    let sku = '';
    for (let t = skuSearchStart; t < qtyIdx; t++) {
      const tok = tokens[t];
      if (/^[A-Z0-9][A-Z0-9_\-\/]{2,}$/i.test(tok) && tok.length >= 3 && tok.length <= 40) {
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
