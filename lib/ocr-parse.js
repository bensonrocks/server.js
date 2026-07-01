// lib/ocr-parse.js — Parse OCR text from a photographed picking list
'use strict';

// ── Order number patterns — inline (key: value on same line), priority order ──
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
  /gi\s*[-:\s]+([A-Z0-9][A-Z0-9\-\/]{2,})/i,
];

// Two-line key patterns: key is detected on line N, value is on line N+1
const TWO_LINE_ORDER_KEYS = [
  { re: /^reference$/i,                priority: 0 },
  { re: /^po\s*(?:number|no\.?)$/i,    priority: 1 },
  { re: /^order\s*(?:no\.?|number)$/i, priority: 2 },
  { re: /^pick\s*ticket$/i,            priority: 3 },
  { re: /^issue\s*no\.?$/i,            priority: 4 },
];

// ── Customer / account name patterns (inline) ─────────────────────────────────
const CUSTOMER_PATTERNS = [
  /account\s*[:\s]+([A-Za-z][A-Za-z0-9\s&,\.\-]{2,})/i,
  /customer\s*(?:name)?\s*[:\s]+([A-Za-z][A-Za-z0-9\s&,\.\-]{2,})/i,
  /consignee\s*[:\s]+([A-Za-z][A-Za-z0-9\s&,\.\-]{2,})/i,
  /client\s*(?:name)?\s*[:\s]+([A-Za-z][A-Za-z0-9\s&,\.\-]{2,})/i,
  /company\s*[:\s]+([A-Za-z][A-Za-z0-9\s&,\.\-]{2,})/i,
  /ship\s*to\s*[:\s]+([A-Za-z][A-Za-z0-9\s&,\.\-]{2,})/i,
];

// Two-line customer keys
const TWO_LINE_CUSTOMER_KEYS = [
  /^account$/i,
  /^customer(?:\s+name)?$/i,
  /^consignee$/i,
  /^client(?:\s+name)?$/i,
];

// ── Stop parsing when we hit footer / summary lines ───────────────────────────
const STOP_PAT = /^(total\s+whole|total\s+loose|grand\s+total|picked\s+by|checked\s+by|released\s+by|start\s+pick|end\s+pick|print\s+date|remarks?\s*:|page\s+\d|plt\s*\d|pallet\s*\d)/i;

// ── Words never treated as a SKU ──────────────────────────────────────────────
const SKIP_SKU = new Set([
  'total','grand','subtotal','delivery','status','pick','picking',
  'remarks','remark','note','notes','account','reference','consignee',
  'address','date','time','name','description','desc','uom','unit',
  'whole','loose','lhu','batch','expiry','serial','lot','each','carton',
  'carto','pcs','pieces','qty','quantity','weight','pallet','box','no',
  'day','start','end','fini','print','page','by','and','for','the',
  'location','sku','item','product','sno','seq','vdc','adc',
  'cus','part','issue','ticket','gi','gd','gt','so','po','dn','do',
]);

// Warehouse bin/location codes — look like product codes but are positions.
// Matches: BC-003-035, AC-007-003-B, AB-005001-A, AB-006-001-B, DMG-2, BIN-1
// Pattern: 1-3 letter prefix, 1-3 hyphen-separated digit groups (1-6 digits each),
// optional hyphen + 1-2 letter suffix.
const LOCATION_CODE_PAT = /^[A-Z]{1,3}(-\d{1,6}){1,3}(-[A-Z]{1,2})?$/i;

// Unit-of-measure keywords that immediately follow the quantity
const UOM_RE = /^(?:EACH|EA|PCS|PIECES|BOX|CTN|CARTON|CARTO|CARTOS|UOM)$/i;

// Date pattern for expiry column (e.g. 30/Nov/2028, 01-Apr-2027)
const EXPIRY_DATE_PAT = /^\d{1,2}[\/\-][A-Za-z0-9]+[\/\-]\d{2,4}$/;

// ── OCR character-confusion corrections ───────────────────────────────────────
// Only triggered when the extracted code is 7+ all-digit characters.
//
// LEADING (5→S, 8→B, 6→G): these digits strongly resemble their letter forms.
//   0 and 1 are NOT in the leading map — leading zeros are common in real codes.
//
// TRAILING (2→Z only): Z is routinely misread as 2 by OCR engines.
//   Applied only when leading fix does not fire, so the two never both apply.
//
// Example: 500037495 → S00037495 (leading 5→S)
//          010720262 → 01072026Z (trailing 2→Z; leading 0 is NOT corrected)
const OCR_LEAD_MAP  = { '5': 'S', '8': 'B', '6': 'G' };
const OCR_TRAIL_MAP = { '2': 'Z' };

function fixOcrConfusions(code) {
  if (!/^\d{7,}$/.test(code)) return code;
  const lead = OCR_LEAD_MAP[code[0]];
  if (lead) return lead + code.slice(1);
  const trail = OCR_TRAIL_MAP[code[code.length - 1]];
  if (trail) return code.slice(0, -1) + trail;
  return code;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTableHeader(line) {
  const lc = line.toLowerCase();
  const hasItem  = /\b(item|sku|product|barcode|code|part|material|article|location|desc(?:ription)?)\b/.test(lc);
  const hasQty   = /\b(qty|quantity|pcs|pieces|count|uom|whole|loose|lhu)\b/.test(lc);
  const hasBatch = /\b(batch|lot\s*no|expiry)\b/.test(lc);
  return (hasItem && hasQty) || (hasItem && hasBatch);
}

// Extract a value from "Key   Value" on the same line, or Key\nValue on adjacent lines.
// Returns the value string, or null if not found.
function extractKV(lines, keyRe) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    const inline = (m[1] || '').trim();
    if (inline.length >= 2) return inline;
    // Key-only line — try next non-empty line as value
    if (i + 1 < lines.length) {
      const nxt = lines[i + 1].trim();
      // Accept if it doesn't look like another key line (no colon at mid-line)
      if (nxt.length >= 2 && !/\s{2,}[A-Za-z]/.test(nxt)) return nxt;
    }
  }
  return null;
}

// ── Main parser ───────────────────────────────────────────────────────────────
function parseOcrPicklist(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Detect document format: WMS-style Picking List
  const isPickingList =
    /picking\s*list/i.test(text) &&
    /\b(wholeuom|whole\s*uom|total\s*lhu|loose\s*uom)\b/i.test(text);

  // ── 1. Order number ─────────────────────────────────────────────────────────
  let orderNumber = null;

  // Inline patterns first
  for (const re of ORDER_PATTERNS) {
    for (const line of lines) {
      const m = line.match(re);
      if (m && m[1]) {
        const cand = m[1].replace(/[^A-Z0-9\-\/]/gi, '').toUpperCase();
        if (cand.length >= 2) { orderNumber = fixOcrConfusions(cand); break; }
      }
    }
    if (orderNumber) break;
  }

  // Two-line key/value fallback (key on one line, number on next)
  if (!orderNumber) {
    const candidates = [];
    for (let i = 0; i < lines.length - 1; i++) {
      for (const { re, priority } of TWO_LINE_ORDER_KEYS) {
        if (re.test(lines[i].trim())) {
          const val = fixOcrConfusions(
            lines[i + 1].trim().replace(/[^A-Z0-9\-\/]/gi, '').toUpperCase()
          );
          if (val.length >= 2 && /[A-Z0-9]/.test(val)) {
            candidates.push({ val, priority });
            break;
          }
        }
      }
    }
    if (candidates.length) {
      candidates.sort((a, b) => a.priority - b.priority);
      orderNumber = candidates[0].val;
    }
  }

  if (!orderNumber) orderNumber = `OCR-${Date.now()}`;

  // ── 2. Customer name ────────────────────────────────────────────────────────
  let customerName = '';

  // Inline
  for (const re of CUSTOMER_PATTERNS) {
    const val = extractKV(lines, re);
    if (val) {
      // Trim trailing columns from the same OCR line (double-space split)
      customerName = val.split(/\s{2,}/)[0].trim();
      if (customerName.length >= 2) break;
      customerName = '';
    }
  }

  // Two-line fallback
  if (!customerName) {
    for (let i = 0; i < lines.length - 1; i++) {
      for (const re of TWO_LINE_CUSTOMER_KEYS) {
        if (re.test(lines[i].trim())) {
          const nxt = lines[i + 1].trim();
          // Must look like a company name (has letters, not a pure number)
          if (nxt.length >= 3 && /[A-Za-z]{2}/.test(nxt) && !/^[\d\-\/]+$/.test(nxt)) {
            customerName = nxt;
            break;
          }
        }
      }
      if (customerName) break;
    }
  }

  // ── 3. Supplemental header fields ───────────────────────────────────────────
  const rawIssue  = extractKV(lines, /issue\s*no\.?\s*[:\s]+(.*)/i)  || '';
  const rawTicket = extractKV(lines, /pick\s*ticket\s*[:\s]+(.*)/i)  || '';
  const rawRef    = extractKV(lines, /reference\s*[:\s]+(.*)/i)      || '';

  const issueNo    = fixOcrConfusions(rawIssue .replace(/[^A-Z0-9\-]/gi, '').toUpperCase());
  const pickTicket = fixOcrConfusions(rawTicket.replace(/[^A-Z0-9\-]/gi, '').toUpperCase());
  const reference  = fixOcrConfusions(rawRef   .replace(/[^A-Z0-9\-]/gi, '').toUpperCase());

  // ── 4. Table header row ─────────────────────────────────────────────────────
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTableHeader(lines[i])) { headerIdx = i; break; }
  }

  // ── 5. Data rows ────────────────────────────────────────────────────────────
  const rows = [];
  const dataStart = headerIdx >= 0 ? headerIdx + 1 : 0;

  // Minimum SKU length: 4 in Picking List mode (blocks 3-char noise like "333"
  // while allowing 4-digit WMS codes like 5603, 8009, 8101, 8133)
  const MIN_SKU_LEN = isPickingList ? 4 : 3;

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (STOP_PAT.test(line)) break;

    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 3) continue;

    // ── Qty: prefer integer immediately before a UOM keyword (EACH, PCS, etc.)
    // This stops batch numbers like 533601 or 517008 from being mistaken for qty.
    let qty = null, qtyIdx = -1;
    for (let t = 1; t < tokens.length; t++) {
      if (UOM_RE.test(tokens[t])) {
        const clean = (tokens[t - 1] || '').replace(/,/g, '');
        if (/^\d+$/.test(clean)) {
          const n = parseInt(clean, 10);
          if (n > 0 && n < 1000000) { qty = n; qtyIdx = t - 1; break; }
        }
      }
    }
    // Fallback: rightmost plain integer (covers lines without explicit UOM)
    if (!qty) {
      for (let t = tokens.length - 1; t >= 1; t--) {
        const clean = tokens[t].replace(/,/g, '');
        if (/^\d+$/.test(clean)) {
          const n = parseInt(clean, 10);
          if (n > 0 && n < 1000000) { qty = n; qtyIdx = t; break; }
        }
      }
    }
    if (!qty || qtyIdx < 1) continue;

    // ── Cursor: skip leading row number (1–4 digits) ─────────────────────────
    let cursor = /^\d{1,4}$/.test(tokens[0]) ? 1 : 0;

    // ── Skip bin/location code (e.g. BC-003-035) ─────────────────────────────
    if (cursor < qtyIdx && LOCATION_CODE_PAT.test(tokens[cursor])) cursor++;

    // ── SKU: first valid product-code token ──────────────────────────────────
    let sku = '';
    const descTokens = [];
    for (let t = cursor; t < qtyIdx; t++) {
      const tok = tokens[t];
      if (!sku) {
        if (tok.length < MIN_SKU_LEN || tok.length > 40) continue;
        if (SKIP_SKU.has(tok.toLowerCase())) continue;
        if (/^\d+[a-z]{1,3}$/i.test(tok)) continue;    // 100ml, 250g
        if (LOCATION_CODE_PAT.test(tok)) continue;      // another bin code
        if (!/\d/.test(tok)) continue;                  // must contain a digit
        if (/^[A-Z0-9][A-Z0-9_\-\/]{2,}$/i.test(tok)) {
          sku = tok.toUpperCase();
          continue;
        }
      } else {
        descTokens.push(tok);
      }
    }
    if (!sku) continue;

    // ── Batch number and expiry date (columns right of qty/UOM) ─────────────
    // Format after qty: [UOM] [/] [CARTO] [repeated-qty] [batch] [expiry]
    let batchNumber = '';
    let expiryDate  = '';
    let lotStart = qtyIdx + 1;
    if (lotStart < tokens.length && UOM_RE.test(tokens[lotStart])) lotStart++;
    let foundBatch = false;
    for (let t = lotStart; t < tokens.length; t++) {
      const tok = tokens[t];
      if (EXPIRY_DATE_PAT.test(tok)) { expiryDate = tok; break; }
      if (tok === '/' || UOM_RE.test(tok))                         continue;
      if (!foundBatch && tok === String(qty))                       continue; // Total LHU repeat
      if (!foundBatch && /^[A-Z0-9]{2,}$/i.test(tok)) {
        batchNumber = tok.toUpperCase();
        foundBatch  = true;
      }
    }

    rows.push({
      order_number    : orderNumber,
      sku,
      qty,
      description     : descTokens.join(' '),
      customer_name   : customerName,
      delivery_address: '',
      client_name     : customerName,
      tel             : '',
      waybill_number  : '',
      issue_no        : issueNo,
      pick_ticket     : pickTicket,
      carrier         : '',
      platform        : '',
      shop_name       : '',
      date            : null,
      batch_number    : batchNumber,
      expiry_date     : expiryDate || null,
      remarks_betime  : reference ? `Ref: ${reference}` : '',
    });
  }

  return rows;
}

module.exports = { parseOcrPicklist };
