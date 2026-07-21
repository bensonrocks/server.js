'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Product Master — ULD_Product_Master_Template.xlsx adoption.
//
//  The client's real onboarding format for the inventory catalog: SKU +
//  barcode + brand/model + unit/carton dimensions & weight (storage/cbm
//  billing, courier selection) + handling flags + per-marketplace SKU
//  cross-references. Column headers here are the EXACT text from the
//  template the client returns filled in — matched by normalized header
//  (lowercased, non-alphanumerics collapsed to "_") so minor casing/spacing
//  differences in a re-saved copy still match.
// ─────────────────────────────────────────────────────────────────────────────

const XLSX = require('xlsx');

// [Excel header, internal field name] — order here is also the column order
// used when generating a fresh template download.
const PRODUCT_MASTER_FIELDS = [
  ['SKU Code *', 'sku'],
  ['Product Name *', 'name'],
  ['Barcode (EAN/UPC) *', 'barcode'],
  ['Brand', 'brand'],
  ['Model', 'model'],
  ['Units per Carton', 'units_per_carton'],
  ['Unit L (cm)', 'unit_l'],
  ['Unit W (cm)', 'unit_w'],
  ['Unit H (cm)', 'unit_h'],
  ['Unit Weight (kg)', 'unit_weight'],
  ['Carton L (cm)', 'carton_l'],
  ['Carton W (cm)', 'carton_w'],
  ['Carton H (cm)', 'carton_h'],
  ['Carton Weight (kg)', 'carton_weight'],
  ['Fragile (Y/N)', 'fragile'],
  ['Contains Battery (Y/N)', 'contains_battery'],
  ['Serial Tracked (Y/N)', 'serial_tracked'],
  ['Platform SKU - Shopee', 'platform_sku_shopee'],
  ['Platform SKU - Lazada 1', 'platform_sku_lazada1'],
  ['Platform SKU - Lazada 2', 'platform_sku_lazada2'],
  ['Platform SKU - TikTok', 'platform_sku_tiktok'],
  ['Platform SKU - Shopify', 'platform_sku_shopify'],
  ['Platform SKU - Others', 'platform_sku_others'],
  ['Storage / Handling Remarks', 'storage_remarks'],
];

const YN_FIELDS = new Set(['fragile', 'contains_battery', 'serial_tracked']);
const NUM_FIELDS = new Set(['units_per_carton', 'unit_l', 'unit_w', 'unit_h', 'unit_weight', 'carton_l', 'carton_w', 'carton_h', 'carton_weight']);

function _normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// header (Excel text) -> internal field, keyed by normalized header so a
// re-saved template with slightly different spacing/casing still matches.
const _HEADER_TO_FIELD = new Map(PRODUCT_MASTER_FIELDS.map(([h, f]) => [_normalizeHeader(h), f]));

function _ynToFlag(v) {
  const s = String(v ?? '').trim().toUpperCase();
  return s === 'Y' || s === 'YES' || s === '1' || s === 'TRUE' ? 1 : 0;
}

// rawRows: array of row objects as produced by XLSX.utils.sheet_to_json
// (keyed by whatever header text row 1 actually has). Returns
// { rows: [{sku, name, barcode, ...}], skipped: [{row, reason}] } — SKU and
// Name are the only truly mandatory fields (a missing barcode is a normal,
// already-supported case elsewhere in this app — see the QR-substitute
// no-barcode flow — so it's not treated as an error here).
function parseProductMasterRows(rawRows) {
  const rows = [];
  const skipped = [];
  rawRows.forEach((raw, i) => {
    const mapped = {};
    for (const [rawHeader, val] of Object.entries(raw)) {
      const field = _HEADER_TO_FIELD.get(_normalizeHeader(rawHeader));
      if (!field) continue;
      if (YN_FIELDS.has(field)) mapped[field] = _ynToFlag(val);
      else if (NUM_FIELDS.has(field)) mapped[field] = val === '' || val == null ? 0 : Number(val) || 0;
      else mapped[field] = String(val ?? '').trim();
    }
    if (!mapped.sku) { skipped.push({ row: i + 2, reason: 'Missing SKU Code' }); return; } // +2: header row + 1-index
    if (!mapped.name) { skipped.push({ row: i + 2, reason: 'Missing Product Name' }); return; }
    rows.push(mapped);
  });
  return { rows, skipped };
}

// Builds a downloadable template: header row + the client's own sample row
// (kept as a worked example) on "Product Master", plus the "Instructions"
// sheet, byte-for-byte matching the layout the client already knows.
function buildProductMasterTemplateXlsx() {
  const headers = PRODUCT_MASTER_FIELDS.map(([h]) => h);
  const sampleRow = [
    'AF-5L-BLK', 'Air Fryer 5L Black', '8888123456789', 'KitchenPro', 'KP-AF500',
    '4', '30', '28', '32', '3.2', '62', '58', '66', '13.5', 'Y', 'N', 'N',
    'AF-5L-BLK', 'AF5L-BLACK', 'AF-5L-BLK-V2', 'AF-5L-BLK', 'airfryer-5l-blk', '',
    'Keep upright, do not stack above 4 cartons',
  ];
  const instructions = [
    ['ULD / IDEALONE — Product Master List: How to fill', ''],
    ['', ''],
    ['* Fields marked * are mandatory. One row per sellable SKU (each colour/size variant = its own row).', ''],
    ['', ''],
    ['SKU Code', 'Your master SKU — the code printed/encoded on the product barcode where possible. Must be unique.'],
    ['Barcode', 'The scannable code on the product (EAN/UPC/QR content). If a product has NO barcode, leave blank — we will generate scannable QR labels for it.'],
    ['Units per Carton', 'How many sellable units per master carton as shipped to our warehouse.'],
    ['Dimensions/Weight', 'Used for storage (cbm) billing accuracy and courier selection. Approximate is acceptable to start.'],
    ['Fragile', 'Y = packed with bubblewrap + shrinkwrap + fragile tape per agreed handling.'],
    ['Contains Battery', 'Y = affects courier eligibility and declaration.'],
    ['Serial Tracked', 'Y = we record serial numbers at outbound (warranty-sensitive items).'],
    ['Platform SKU columns', 'ONLY needed where the SKU code used on that platform differs from your master SKU Code. Leave blank if identical.'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, sampleRow]), 'Product Master');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instructions), 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { PRODUCT_MASTER_FIELDS, parseProductMasterRows, buildProductMasterTemplateXlsx };
