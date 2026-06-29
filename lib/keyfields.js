// =============================================================================
// lib/keyfields.js  —  Keyfields WMS Output Format
// =============================================================================
//
// THIS is the only file you need to edit when:
//   • A client's upload file uses different column names   → INPUT COLUMN ALIASES
//   • The WMS system changes its column names or order     → OUTPUT HEADERS
//   • A field needs to map to a different output column    → ROW BUILDER
//   • Site code, UOM, or default remark values change     → CONSTANTS
//
// All other app logic (upload, scan, email, persistence) lives in server.js
// and does NOT need to change when the format changes.
//
// =============================================================================

'use strict';
const XLSX = require('xlsx');

// =============================================================================
// CONSTANTS
// Change these when the site/warehouse code or WMS defaults change.
// =============================================================================

const SITE_CODE            = 'ULD-PL';      // d-sitecode  — warehouse code
const DEFAULT_UOM          = 'EACH';         // d-uom       — unit of measure
const DEFAULT_REMARK       = 'NM';           // d-lot14     — remark when none supplied
const OUTPUT_SHEET_NAME    = 'IssueDetail';  // worksheet name in the output XLSX
const OUTPUT_SHEET_BLANK   = 'Sheet1';       // second blank sheet (required by WMS)
const OUTPUT_FILE_PREFIX   = 'WMS';          // prefix for the generated filename

// =============================================================================
// INPUT COLUMN ALIASES
// =============================================================================
// Maps any incoming file column name → internal field.
// Column names are normalised to lowercase_with_underscores before matching,
// so "Order No.", "order_no", "ORDER NO" all match "order_no".
//
// To support a new client file format, add their column name to the right-hand
// side of the relevant ?? chain. Do NOT remove existing aliases.
// =============================================================================

function normalizeKey(k) {
  return String(k).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function dateVal(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return String(v).split('T')[0] || null;
}

// =============================================================================
// AI COLUMN DETECTION
// =============================================================================
// Analyses the actual data in a batch of raw rows to identify which columns
// represent the order key, SKU/item code, and quantity — regardless of what
// those columns are named. Detected columns are used as a last-resort fallback
// in mapRow() so that IDEALSCAN can scan-inspect ANY uploaded file format.
//
// The detected columns are appended at the END of each alias chain in mapRow,
// so known aliases (e.g. "order_no", "d-SKUCODE") always take priority.
// AI detection only activates when the normal alias chain would produce nothing.
// =============================================================================

function detectColumnMap(rawRows) {
  if (!rawRows || rawRows.length < 2) return {};

  const sampleRows = rawRows.slice(0, Math.min(rawRows.length, 200));
  const n          = sampleRows.length;

  // Collect and normalise all column names present in this file
  const allCols = new Set();
  for (const row of sampleRows) {
    for (const k of Object.keys(row)) allCols.add(normalizeKey(k));
  }
  const columns = [...allCols];

  // Build normalised versions of all rows for stat computation
  const normRows = sampleRows.map(row => {
    const nr = {};
    for (const k of Object.keys(row)) nr[normalizeKey(k)] = row[k];
    return nr;
  });

  // Per-column statistics used by the scoring functions
  const stats = {};
  for (const col of columns) {
    const vals = normRows
      .map(r => r[col])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '');

    if (vals.length === 0) {
      stats[col] = { fill: 0, cardinality: 1, numRatio: 0, avgLen: 0 };
      continue;
    }
    const strs     = vals.map(v => String(v).trim());
    const unique   = new Set(strs.map(s => s.toLowerCase())).size;
    const numCount = strs.filter(s => /^\d+(\.\d+)?$/.test(s)).length;
    stats[col] = {
      fill:        vals.length / n,
      unique,
      cardinality: unique / vals.length,          // 0 = all same, 1 = all unique
      numRatio:    numCount / vals.length,
      avgLen:      strs.reduce((sum, s) => sum + s.length, 0) / strs.length,
    };
  }

  // ── Scoring functions ───────────────────────────────────────────────────────

  function scoreOrder(col) {
    const s = stats[col];
    if (!s || s.fill < 0.4) return -99;
    let nameScore = 0;
    if (/order|ref|invoice|shipment|consign|^po$|^po_|_po$/.test(col))                          nameScore += 15;
    if (/issue|ticket|pick|^so[_$]|[_-]so$|exref|_no$|num$|number$/.test(col))                nameScore += 8;
    if (/^doc(?:ument)?(?:_no|_num)?$|^dn(?:_no)?$|^pl(?:_no)?$|dispatch|packing|delivery_note/.test(col)) nameScore += 8;
    // A column with only 1 unique value is a constant field (site, region,
    // customer), not an order key — UNLESS the name is a strong order keyword
    // (e.g. single-order file where Invoice = 'INV-999' repeats across all rows).
    if (s.unique <= 1 && nameScore < 8) return -99;
    let score = nameScore;
    // Multiple items share one order key → values repeat → low but non-zero cardinality
    if      (s.cardinality <= 0.15) score += 20;
    else if (s.cardinality <= 0.35) score += 12;
    else if (s.cardinality <= 0.60) score += 5;
    else                             score -= 12; // unique per row → probably SKU
    // Order refs are rarely pure digits
    if      (s.numRatio < 0.2)  score += 4;
    else if (s.numRatio > 0.95) score -= 4;
    if (s.avgLen >= 3 && s.avgLen <= 32) score += 3;
    return score;
  }

  function scoreSku(col) {
    const s = stats[col];
    if (!s || s.fill < 0.4) return -99;
    let score = 0;
    if (/sku|item|product|barcode|article|material|part|goods/.test(col)) score += 15;
    if (/code$|_code|_id$/.test(col))                                      score += 6;
    // SKUs tend to be unique per row (or near-unique across the whole batch)
    if      (s.cardinality >= 0.7) score += 10;
    else if (s.cardinality >= 0.4) score += 5;
    if (s.numRatio < 0.6)  score += 4;   // alphanumeric codes preferred
    if (s.fill > 0.85)     score += 3;
    if (s.avgLen >= 2 && s.avgLen <= 30) score += 2;
    return score;
  }

  function scoreQty(col) {
    const s = stats[col];
    if (!s) return -99;
    let score = 0;
    if (/^qty$|quantity|^pcs$|pieces|^count$|^units?$|^amount$/.test(col)) score += 20;
    if (s.numRatio > 0.9)     score += 15;
    if (s.avgLen <= 3)        score += 8;
    if (s.cardinality <= 0.2) score += 3; // small set of repeated values (1, 2, 3…)
    return score;
  }

  // ── Find best column per role ───────────────────────────────────────────────

  let bestOrder = null, bestOrderScore = -Infinity;
  let bestSku   = null, bestSkuScore   = -Infinity;
  let bestQty   = null, bestQtyScore   = -Infinity;

  for (const col of columns) {
    const os = scoreOrder(col);
    const ss = scoreSku(col);
    const qs = scoreQty(col);
    if (os > bestOrderScore) { bestOrderScore = os; bestOrder = col; }
    if (ss > bestSkuScore)   { bestSkuScore   = ss; bestSku   = col; }
    if (qs > bestQtyScore)   { bestQtyScore   = qs; bestQty   = col; }
  }

  const result = {};
  if (bestOrderScore >= 5)  result.order_key = bestOrder;
  if (bestSkuScore   >= 5)  result.sku_key   = bestSku;
  if (bestQtyScore   >= 5)  result.qty_key   = bestQty;

  return result;
}

// =============================================================================

function mapRow(rawRow, detected = {}) {
  // Normalise all keys first
  const n = {};
  for (const k of Object.keys(rawRow)) n[normalizeKey(k)] = rawRow[k];

  const rawQty =
    n.quantity ?? n.qty ?? n.pcs ?? n.pieces ??
    (detected.qty_key ? n[detected.qty_key] : undefined) ?? 1;
  const qty    = typeof rawQty === 'number'
    ? Math.round(rawQty)
    : (parseInt(String(rawQty), 10) || 1);

  return {
    // ── Order identifier ────────────────────────────────────────────────────
    // Includes Keyfields WMS output column (d-exref2) and Betime internal
    // refs (Issue No, PickTicket) so Keyfields-generated picklists import
    // without the "UNKNOWN order number" error.
    order_number: String(
      n.ref              ??
      n.order_number     ??
      n.order_no         ??
      n.so_number        ??
      n.sales_order      ??
      n.job_no           ??
      n.reference        ??
      n.d_exref2         ??   // Keyfields output: d-exref2
      n.issue_no         ??   // Betime: Issue No
      n.issueno          ??
      n.issue_number     ??
      n.pick_ticket      ??   // Betime: PickTicket number
      n.pickticket       ??
      n.pick_ticket_no   ??
      n.pt_no            ??
      n.picking_no       ??   // picking list variants
      n.packing_list_no  ??
      n.packing_list     ??
      n.pl_no            ??
      n.delivery_note    ??
      n.delivery_note_no ??
      n.dn_no            ??
      n.doc_no           ??
      n.document_no      ??
      n.document_number  ??
      n.consignment_no   ??
      n.shipment_no      ??
      n.shipment_number  ??
      n.dispatch_no      ??
      (detected.order_key ? n[detected.order_key] : undefined) ??  // AI fallback
      'UNKNOWN'
    ),

    // ── Customer / consignee ────────────────────────────────────────────────
    customer_name: String(
      n.customer_name  ??
      n.consignee      ??
      n.recipient      ??
      n.ship_to_name   ??
      n.d_shname       ??   // Keyfields output: d-shname
      ''
    ),

    // ── Client / brand (the merchant who sent us the picklist) ──────────────
    client_name: String(
      n.client_name    ??
      n.client         ??
      n.merchant       ??
      n.brand          ??
      n.seller         ??
      ''
    ),

    // ── Delivery contact ────────────────────────────────────────────────────
    tel: String(
      n.tel            ??
      n.phone          ??
      n.mobile         ??
      n.contact_no     ??
      n.d_shtotel      ??   // Keyfields output: d-shtotel
      ''
    ),

    delivery_address: (() => {
      // Try a single full-address column first
      const single =
        n.delivery_address  ??
        n.address           ??
        n.ship_to_address   ??
        n.ship_to           ??
        n.recipient_address ??
        n.full_address      ??
        n.d_shaddr1         ??   // Keyfields output: d-shaddr1 (primary delivery address)
        null;

      // Also collect individual components that some clients put in separate columns
      const parts = [
        n.address_line_1 ?? n.addr1 ?? n.address1 ?? n.street ?? null,
        n.address_line_2 ?? n.addr2 ?? n.address2 ?? null,
        n.address_line_3 ?? n.addr3 ?? n.address3 ?? null,
        n.city           ?? n.town  ?? null,
        n.state          ?? n.province ?? n.region ?? null,
        n.postal_code    ?? n.postcode ?? n.zip    ?? n.zip_code ?? null,
        n.country        ?? n.country_code ?? null,
      ].filter(v => v !== null && String(v).trim() !== '');

      // Prefer the single-column value if it looks like a real address (more than
      // just a country name / short code — heuristic: longer than 6 chars).
      if (single && String(single).trim().length > 6) return String(single).trim();

      // If we found individual parts, join them
      if (parts.length) return parts.map(v => String(v).trim()).join(', ');

      // Fall back to whatever single value we had (even if short)
      return single ? String(single).trim() : '';
    })(),

    // ── Logistics ───────────────────────────────────────────────────────────
    waybill_number: String(
      n.tracking_number  ??
      n.waybill_number   ??
      n.waybill          ??
      n.tracking         ??
      n.awb              ??
      n.airway_bill      ??
      n.consignment_no   ??
      n.d_shaddr2        ??   // Keyfields output: d-shaddr2 (waybill/tracking)
      ''
    ),

    // ── Betime / WMS internal identifiers ───────────────────────────────────
    // Used as fallback keys when matching carrier waybill PDF pages to orders.
    issue_no: String(
      n.issue_no          ??
      n.issue_number      ??
      n.issueno           ??
      n.issue_ref         ??
      n.issue             ??
      ''
    ),

    pick_ticket: String(
      n.pick_ticket        ??
      n.pickticket         ??
      n.pick_ticket_no     ??
      n.pickticket_no      ??
      n.pick_ticket_number ??
      n.pt_no              ??
      n.pick_no            ??
      ''
    ),

    carrier: String(
      n.driver           ??
      n.carrier          ??
      n.courier          ??
      n.logistics        ??
      n.delivery_party   ??
      n.shipping_method  ??
      n.d_rem1           ??   // Keyfields output: d-rem1 (carrier)
      ''
    ),

    // ── Sales channel ───────────────────────────────────────────────────────
    platform: String(
      n.platform         ??
      n.channel          ??
      n.marketplace      ??
      n.sales_channel    ??
      ''
    ),

    shop_name: String(
      n.shop_name        ??
      n.shop             ??
      n.store            ??
      n.store_name       ??
      ''
    ),

    // ── Dates ───────────────────────────────────────────────────────────────
    date: dateVal(
      n.date             ??
      n.order_date       ??
      n.ship_date        ??
      n.delivery_date    ??
      n.dispatch_date    ??
      n.d_exdate2           // Keyfields output: d-exdate2 (order date)
    ),

    // ── Item ────────────────────────────────────────────────────────────────
    sku: String(
      n.product_code     ??
      // Picking list format: "Location" column = item code (AC-007-003-B),
      // "SKU" column = internal numeric ID (5501). Prefer location when sku
      // is a pure integer and location has letters.
      (n.sku != null && n.location != null &&
       /^\d+$/.test(String(n.sku)) && /[A-Za-z]/.test(String(n.location))
         ? n.location : undefined)  ??
      n.sku              ??
      n.item_code        ??
      n.barcode          ??
      n.product_sku      ??
      n.item_sku         ??
      n.article_no       ??
      n.d_skucode        ??   // Keyfields output: d-SKUCODE
      n.item_no          ??   // picking list: Item No
      n.item             ??   // picking list: Item
      n.material         ??   // WMS: Material
      n.material_no      ??
      n.mat_no           ??
      n.part_no          ??   // manufacturing: Part No
      n.part_number      ??
      n.product_id       ??
      n.code             ??   // generic: Code
      (detected.sku_key ? n[detected.sku_key] : undefined) ??  // AI fallback
      ''
    ),

    qty,

    // ── WMS extra fields ────────────────────────────────────────────────────
    batch_number: String(
      n.batch_number     ??
      n.lot_number       ??
      n.lot_no           ??
      n.batch_lot_no     ??   // Betime picking list: Batch/Lot No
      n.batch_lot        ??
      n.batch_no         ??
      n.batch            ??
      n.lot              ??
      n.d_lot2           ??   // Keyfields output: d-lot2 (batch/lot)
      ''
    ),

    expiry_date: dateVal(
      n.expiry_date      ??
      n.expiry           ??
      n.best_before      ??
      n.exp_date         ??
      n.bb_date          ??
      n.date_code        ??
      n.mfg_date         ??
      n.manufacture_date ??
      n.d_lot1              // Keyfields output: d-lot1 (expiry date)
    ),

    serial_number: String(
      n.serial_number    ??
      n.serial_no        ??
      n.serial           ??
      n.sn               ??
      n.imei             ??
      n.d_lot3           ??   // Keyfields output: d-lot3 (serial)
      ''
    ),

    remarks: String(
      n.remarks          ??
      n.notes            ??
      n.note             ??
      n.comment          ??
      ''
    ),

    // WMS-specific remark field — printed into d-lot14 in the Keyfields output
    remarks_betime: String(
      n.remarks_betime   ??
      n.wms_remark       ??
      n.wms_note         ??
      n.wms_remarks      ??
      n.d_lot14          ??   // Keyfields output: d-lot14 (WMS remark round-trip)
      ''
    ),
  };
}

// =============================================================================
// OUTPUT HEADERS
// =============================================================================
// These are the exact column names the WMS system expects, in order.
// If Keyfields renames a column, change it here only.
// When a custom template is uploaded via the Master panel, these defaults
// are replaced at runtime — see generateKeyfieldsXLSX(orders, customHeaders).
// =============================================================================

const KEYFIELDS_HEADERS = [
  'd-exline',        //  1  Line sequence number (auto-incremented)
  'd-sitecode',      //  2  Site / warehouse code
  'd-exref2',        //  3  Order reference number
  'd-exdate2',       //  4  Order date
  'd-SKUCODE',       //  5  Product SKU / barcode
  'QTY',             //  6  Quantity
  'd-uom',           //  7  Unit of measure  (EACH / CTN / SET …)
  'd-shname',        //  8  Consignee / customer name
  'd-exref1',        //  9  (spare)
  'd-exdate1',       // 10  (spare)
  'd-expdate',       // 11  (spare)
  'd-priority',      // 12  (spare)
  'd-shaddr1',       // 13  Delivery address (PRIMARY — CRITICAL)
  'd-shaddr2',       // 14  Waybill / tracking number
  'd-shaddr3',       // 15  (spare)
  'd-shaddr4',       // 16  (spare)
  'd-shzipcode',     // 17  (spare)
  'd-shtotel',       // 18  Phone / contact number
  'd-shtotelexfax',  // 19  (spare)
  'd-isdrem1',       // 20  (spare)
  'd-rem1',          // 21  Carrier / delivery party
  'd-rcdate',        // 22  (spare)
  'd-loccode',       // 23  (spare)
  'd-lot1',          // 24  Expiry / date code
  'd-lot2',          // 25  Batch / lot number
  'd-lot3',          // 26  Serial number
  'd-lot4',          // 27  (spare)
  'd-lot5',          // 28  (spare)
  'd-lot6',          // 29  (spare)
  'd-lot7',          // 30  (spare)
  'd-lot8',          // 31  (spare)
  'd-lot9',          // 32  (spare)
  'd-lot10',         // 33  (spare)
  'd-lot11',         // 34  (spare)
  'd-lot12',         // 35  (spare)
  'd-lot13',         // 36  (spare)
  'd-lot14',         // 37  Remarks / WMS notes
  'd-lot15',         // 38  (spare)
  'd-lot16',         // 39  (spare)
];

// =============================================================================
// ROW BUILDER
// =============================================================================
// Returns a named object keyed by WMS column name.
// generateKeyfieldsXLSX maps this to an array using the effective headers,
// so column order changes in a custom template are handled automatically.
// Add new field mappings here; the column name must appear in KEYFIELDS_HEADERS
// (or the uploaded custom template) to appear in the output.
// =============================================================================

function buildRow(lineNum, order, line) {
  const orderDate  = order.date       ? new Date(order.date)       : null;
  const expiryDate = line.expiry_date ? new Date(line.expiry_date) : null;

  return {
    'd-exline':       lineNum,
    'd-sitecode':     SITE_CODE,
    'd-exref2':       order.order_number,
    'd-exdate2':      orderDate,
    'd-SKUCODE':      line.sku,
    'QTY':            line.qty,
    'd-uom':          DEFAULT_UOM,
    'd-shname':       order.customer_name    || null,
    'd-exref1':       null,
    'd-exdate1':      null,
    'd-expdate':      null,
    'd-priority':     null,
    'd-shaddr1':      order.delivery_address || order.customer_name || null,   // delivery address; falls back to consignee name for picklists
    'd-shaddr2':      order.waybill_number   || null,   // waybill / tracking number
    'd-shaddr3':      null,
    'd-shaddr4':      null,
    'd-shzipcode':    null,
    'd-shtotel':      order.tel              || null,   // contact tel
    'd-shtotelexfax': null,
    'd-isdrem1':      null,
    'd-rem1':         order.carrier          || null,   // carrier
    'd-rcdate':       null,
    'd-loccode':      null,
    'd-lot1':         expiryDate,
    'd-lot2':         line.batch_number  || null,   // batch / lot number
    'd-lot3':         line.serial_number || null,   // serial number
    'd-lot4':         null,
    'd-lot5':         null,
    'd-lot6':         null,
    'd-lot7':         null,
    'd-lot8':         null,
    'd-lot9':         null,
    'd-lot10':        null,
    'd-lot11':        null,
    'd-lot12':        null,
    'd-lot13':        null,
    'd-lot14':        line.remarks_betime || DEFAULT_REMARK,  // WMS remark
    'd-lot15':        null,
    'd-lot16':        null,
  };
}

// =============================================================================
// XLSX GENERATOR
// =============================================================================
// Assembles the complete Keyfields XLSX from a list of summarised orders.
// Pass customHeaders (array of strings) to override the default column list —
// used when a custom template has been uploaded via the Master panel.
// =============================================================================

function generateKeyfieldsXLSX(orders, customHeaders) {
  const headers = (customHeaders && customHeaders.length) ? customHeaders : KEYFIELDS_HEADERS;
  const aoa = [headers];
  let lineNum = 1;

  for (const order of orders) {
    for (const line of order.lines) {
      const rowObj = buildRow(lineNum++, order, line);
      aoa.push(headers.map(h => (rowObj[h] !== undefined ? rowObj[h] : null)));
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });

  // Line column uses an Excel ROW()-1 formula so numbers stay correct
  // if rows are inserted or deleted inside the WMS system.
  // Only applied when d-exline is the first column (default layout).
  if (headers[0] === 'd-exline') {
    for (let r = 1; r < aoa.length; r++) {
      const addr = XLSX.utils.encode_cell({ r, c: 0 });
      ws[addr]   = { t: 'n', f: 'ROW()-1', v: r };
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, OUTPUT_SHEET_NAME);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), OUTPUT_SHEET_BLANK);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// =============================================================================
// TEMPLATE SAMPLE GENERATOR
// =============================================================================
// Produces a two-row XLSX: row 1 = headers, row 2 = annotated sample values.
// Used by the Master panel "Download Template" button so operators can verify
// the expected output format matches what the WMS system requires.
// =============================================================================

const COLUMN_SAMPLES = {
  'd-exline':       '1',
  'd-sitecode':     SITE_CODE,
  'd-exref2':       'ORDER-001',
  'd-exdate2':      new Date().toISOString().split('T')[0],
  'd-SKUCODE':      'SKU-12345',
  'QTY':            '2',
  'd-uom':          DEFAULT_UOM,
  'd-shname':       'Customer Name',
  'd-exref1':       '',
  'd-exdate1':      '',
  'd-expdate':      '',
  'd-priority':     '',
  'd-shaddr1':      '123 Delivery Street, Singapore',
  'd-shaddr2':      'WAYBILL-NO',
  'd-shaddr3':      '',
  'd-shaddr4':      '',
  'd-shzipcode':    '',
  'd-shtotel':      '91234567',
  'd-shtotelexfax': '',
  'd-isdrem1':      '',
  'd-rem1':         'SPX',
  'd-rcdate':       '',
  'd-loccode':      '',
  'd-lot1':         '2026-12-31',
  'd-lot2':         'BATCH-001',
  'd-lot3':         'SN-123456',
  'd-lot4':         '',
  'd-lot5':         '',
  'd-lot6':         '',
  'd-lot7':         '',
  'd-lot8':         '',
  'd-lot9':         '',
  'd-lot10':        '',
  'd-lot11':        '',
  'd-lot12':        '',
  'd-lot13':        '',
  'd-lot14':        DEFAULT_REMARK,
  'd-lot15':        '',
  'd-lot16':        '',
};

function generateTemplateSampleXLSX(customHeaders) {
  const headers   = (customHeaders && customHeaders.length) ? customHeaders : KEYFIELDS_HEADERS;
  const sampleRow = headers.map(h => (COLUMN_SAMPLES[h] !== undefined ? COLUMN_SAMPLES[h] : ''));
  const aoa       = [headers, sampleRow];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), OUTPUT_SHEET_NAME);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), OUTPUT_SHEET_BLANK);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Input side
  mapRow,
  normalizeKey,
  dateVal,
  detectColumnMap,

  // Output side
  buildRow,                    // exported so server.js can build rows for validation
  generateKeyfieldsXLSX,
  generateTemplateSampleXLSX,
  KEYFIELDS_HEADERS,

  // Constants (also exported so server.js can use them in filenames etc.)
  SITE_CODE,
  DEFAULT_UOM,
  DEFAULT_REMARK,
  OUTPUT_SHEET_NAME,
  OUTPUT_FILE_PREFIX,
};
