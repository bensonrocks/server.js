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

    delivery_address: String(
      n.delivery_address ??
      n.address          ??
      n.ship_to_address  ??
      n.ship_to          ??
      n.recipient_address ??
      ''
    ),

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
      n.batch            ??
      n.lot              ??
      ''
    ),

    expiry_date: dateVal(
      n.expiry_date      ??
      n.expiry           ??
      n.best_before      ??
      n.exp_date         ??
      n.bb_date
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
// The numbers in comments correspond to positions in ROW BUILDER below.
// If Keyfields renames a column, change it here only.
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
  'd-shaddr1',       // 13  Waybill / tracking number
  'd-shaddr2',       // 14  Delivery address
  'd-shaddr3',       // 15  (spare)
  'd-shaddr4',       // 16  (spare)
  'd-shzipcode',     // 17  (spare)
  'd-shtotel',       // 18  Phone / contact number
  'd-shtotelexfax',  // 19  (spare)
  'd-isdrem1',       // 20  (spare)
  'd-rem1',          // 21  Carrier / delivery party
  'd-rcdate',        // 22  (spare)
  'd-loccode',       // 23  (spare)
  'd-lot1',          // 24  Expiry date
  'd-lot2',          // 25  (spare)
  'd-lot3',          // 26  (spare)
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
// Builds one output row per order line.
// Each position must align with KEYFIELDS_HEADERS above (same index = same column).
// Change the value at any position to map a different field into that column.
// =============================================================================

function buildRow(lineNum, order, line) {
  const orderDate  = order.date           ? new Date(order.date)           : null;
  const expiryDate = line.expiry_date     ? new Date(line.expiry_date)     : null;

  return [
    lineNum,                                    //  1  d-exline
    SITE_CODE,                                  //  2  d-sitecode
    order.order_number,                         //  3  d-exref2
    orderDate,                                  //  4  d-exdate2
    line.sku,                                   //  5  d-SKUCODE
    line.qty,                                   //  6  QTY
    DEFAULT_UOM,                                //  7  d-uom
    order.customer_name        || null,         //  8  d-shname
    null,                                       //  9  d-exref1    (spare)
    null,                                       // 10  d-exdate1   (spare)
    null,                                       // 11  d-expdate   (spare)
    null,                                       // 12  d-priority  (spare)
    order.waybill_number       || null,         // 13  d-shaddr1   → tracking no.
    order.delivery_address     || null,         // 14  d-shaddr2   → delivery addr
    null,                                       // 15  d-shaddr3   (spare)
    null,                                       // 16  d-shaddr4   (spare)
    null,                                       // 17  d-shzipcode (spare)
    order.tel                  || null,         // 18  d-shtotel   → contact tel
    null,                                       // 19  d-shtotelexfax (spare)
    null,                                       // 20  d-isdrem1   (spare)
    order.carrier              || null,         // 21  d-rem1      → carrier
    null,                                       // 22  d-rcdate    (spare)
    null,                                       // 23  d-loccode   (spare)
    expiryDate,                                 // 24  d-lot1      → expiry date
    null,                                       // 25  d-lot2      (spare)
    null,                                       // 26  d-lot3      (spare)
    null,                                       // 27  d-lot4      (spare)
    null,                                       // 28  d-lot5      (spare)
    null,                                       // 29  d-lot6      (spare)
    null,                                       // 30  d-lot7      (spare)
    null,                                       // 31  d-lot8      (spare)
    null,                                       // 32  d-lot9      (spare)
    null,                                       // 33  d-lot10     (spare)
    null,                                       // 34  d-lot11     (spare)
    null,                                       // 35  d-lot12     (spare)
    null,                                       // 36  d-lot13     (spare)
    line.remarks_betime || DEFAULT_REMARK,      // 37  d-lot14     → WMS remark
    null,                                       // 38  d-lot15     (spare)
    null,                                       // 39  d-lot16     (spare)
  ];
}

// =============================================================================
// XLSX GENERATOR
// =============================================================================
// Assembles the complete Keyfields XLSX from a list of summarised orders.
// Only needs to change if the WMS requires a different file structure
// (e.g., additional sheets, different cell formats).
// =============================================================================

function generateKeyfieldsXLSX(orders) {
  const aoa = [KEYFIELDS_HEADERS];
  let lineNum = 1;

  for (const order of orders) {
    for (const line of order.lines) {
      aoa.push(buildRow(lineNum++, order, line));
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });

  // Line column uses an Excel ROW()-1 formula so numbers stay correct
  // if rows are inserted or deleted inside the WMS system.
  for (let r = 1; r < aoa.length; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: 0 });
    ws[addr]   = { t: 'n', f: 'ROW()-1', v: r };
  }

  XLSX.utils.book_append_sheet(wb, ws, OUTPUT_SHEET_NAME);
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
  generateKeyfieldsXLSX,
  KEYFIELDS_HEADERS,

  // Constants (also exported so server.js can use them in filenames etc.)
  SITE_CODE,
  DEFAULT_UOM,
  DEFAULT_REMARK,
  OUTPUT_SHEET_NAME,
  OUTPUT_FILE_PREFIX,
};
