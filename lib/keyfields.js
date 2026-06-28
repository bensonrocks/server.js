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

function mapRow(rawRow) {
  // Normalise all keys first
  const n = {};
  for (const k of Object.keys(rawRow)) n[normalizeKey(k)] = rawRow[k];

  const rawQty = n.quantity ?? n.qty ?? n.pcs ?? n.pieces ?? 1;
  const qty    = typeof rawQty === 'number'
    ? Math.round(rawQty)
    : (parseInt(String(rawQty), 10) || 1);

  return {
    // ── Order identifier ────────────────────────────────────────────────────
    // Add more aliases if client files use different column names.
    order_number: String(
      n.ref            ??
      n.order_number   ??
      n.order_no       ??
      n.so_number      ??
      n.sales_order    ??
      n.job_no         ??
      n.reference      ??
      'UNKNOWN'
    ),

    // ── Customer / consignee ────────────────────────────────────────────────
    customer_name: String(
      n.customer_name  ??
      n.consignee      ??
      n.recipient      ??
      n.ship_to_name   ??
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
      ''
    ),

    carrier: String(
      n.driver           ??
      n.carrier          ??
      n.courier          ??
      n.logistics        ??
      n.delivery_party   ??
      n.shipping_method  ??
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
      n.dispatch_date
    ),

    // ── Item ────────────────────────────────────────────────────────────────
    sku: String(
      n.product_code     ??
      n.sku              ??
      n.item_code        ??
      n.barcode          ??
      n.product_sku      ??
      n.item_sku         ??
      n.article_no       ??
      ''
    ),

    qty,

    // ── WMS extra fields ────────────────────────────────────────────────────
    batch_number: String(
      n.batch_number     ??
      n.lot_number       ??
      n.lot_no           ??
      n.batch            ??
      n.lot              ??
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
      n.manufacture_date
    ),

    serial_number: String(
      n.serial_number    ??
      n.serial_no        ??
      n.serial           ??
      n.sn               ??
      n.imei             ??
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
    'd-shaddr1':      order.delivery_address || null,   // delivery address (PRIMARY — CRITICAL)
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
