// =============================================================================
// lib/validation.js  —  Keyfields Upload Validation Ruleset
// =============================================================================
//
// This module is the sole source of truth for all upload validation rules.
// It is intentionally separate from server.js — edit ONLY this file when:
//   • Adding or removing mandatory fields
//   • Changing address validation logic
//   • Adjusting static field expected values
//   • Modifying error message wording
//
// server.js calls validateRows(wmsRows) AFTER building the WMS row objects
// but BEFORE writing anything to the database or filesystem.
// If validation fails the upload is aborted immediately.
//
// =============================================================================

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

// Values that are considered empty / invalid placeholders in address fields
const INVALID_ADDRESS_PLACEHOLDERS = [
  'n/a', 'na', 'nil', 'none', 'null', 'tbc', 'tbd',
  '-', '--', '—', '.', '...',
];

// Expected static field values
const EXPECTED_UOM      = 'EACH';
const EXPECTED_SITECODE = 'ULD-PL';   // must match SITE_CODE in keyfields.js

// Any single line above this quantity is treated as a barcode/EAN that leaked
// into the QTY column (shortest EANs are 8 digits; real lines are  ≤ 4 digits)
const MAX_SANE_QTY = 99999;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBlank(v) {
  if (v === null || v === undefined) return true;
  return String(v).trim() === '';
}

function isInvalidPlaceholder(v) {
  return INVALID_ADDRESS_PLACEHOLDERS.includes(String(v).trim().toLowerCase());
}

// ── Core validator ────────────────────────────────────────────────────────────

/**
 * Validate an array of built WMS row objects (output of buildRow()).
 *
 * @param  {Object[]} wmsRows   — row objects keyed by WMS column name
 * @returns {Object}            — validation result (see return shape below)
 */
function validateRows(wmsRows) {
  const errors = [];

  // If no row in the file carries any address data the file is a scan-only
  // picklist — skip delivery-address checks so it uploads cleanly.
  const isPicklistOnly = wmsRows.every(r => isBlank(r['d-shaddr1']) && isBlank(r['d-shname']));

  for (let i = 0; i < wmsRows.length; i++) {
    const row     = wmsRows[i];
    const excelRow = i + 2;          // Excel row 1 = header; data starts at row 2
    const orderId  = isBlank(row['d-exref2']) ? '(unknown)' : String(row['d-exref2']);

    // ── 1. MANDATORY FIELD VALIDATION (CRITICAL) ──────────────────────────
    const mandatoryFields = [
      { field: 'd-exref2',   label: 'Order ID',                  critical: false },
      { field: 'd-SKUCODE',  label: 'SKU / Barcode',             critical: false },
      { field: 'QTY',        label: 'Quantity',                  critical: false },
      { field: 'd-uom',      label: 'Unit of Measure',           critical: false },
      // Address fields are only required when the file is a full delivery order
      ...(!isPicklistOnly ? [
        { field: 'd-shname',   label: 'Recipient Name',            critical: false },
        { field: 'd-shaddr1',  label: 'Delivery Address (Primary)',critical: true  },
      ] : []),
      { field: 'd-sitecode', label: 'Site Code',                 critical: false },
    ];

    for (const { field, label, critical } of mandatoryFields) {
      if (isBlank(row[field])) {
        errors.push({
          excelRow,
          orderId,
          field,
          issue:    field === 'd-shaddr1' ? 'DELIVERY ADDRESS MISSING' : `${label.toUpperCase()} MISSING`,
          description: `${label} (${field}) is empty.`,
          action:   `Populate the full ${label.toLowerCase()} exactly as per the source order file.`,
          critical,
        });
      }
    }

    // ── 2. DELIVERY ADDRESS QUALITY CHECKS ───────────────────────────────
    if (!isPicklistOnly && !isBlank(row['d-shaddr1'])) {
      if (isInvalidPlaceholder(row['d-shaddr1'])) {
        errors.push({
          excelRow,
          orderId,
          field:   'd-shaddr1',
          issue:   'INVALID DELIVERY ADDRESS',
          description: `Delivery address contains invalid placeholder value: "${String(row['d-shaddr1']).trim()}".`,
          action:  'Replace the placeholder with the actual delivery address from the source order file.',
          critical: true,
        });
      }
    }

    // ── 3. DATA TYPE VALIDATION — QTY ─────────────────────────────────────
    if (!isBlank(row['QTY'])) {
      const numQty = Number(row['QTY']);
      if (isNaN(numQty) || numQty <= 0) {
        errors.push({
          excelRow,
          orderId,
          field:   'QTY',
          issue:   'INVALID QUANTITY',
          description: `Quantity value "${row['QTY']}" is not a positive number (must be numeric and > 0).`,
          action:  'Correct the quantity to a numeric value greater than 0.',
          critical: false,
        });
      } else if (numQty > MAX_SANE_QTY) {
        // A "quantity" of billions is a barcode/EAN that landed in the QTY
        // column (e.g. a barcode reference sheet uploaded as an order file)
        errors.push({
          excelRow,
          orderId,
          field:   'QTY',
          issue:   'QUANTITY LOOKS LIKE A BARCODE',
          description: `Quantity value "${row['QTY']}" exceeds ${MAX_SANE_QTY.toLocaleString()} — this looks like an EAN/barcode in the quantity column, not a real order quantity.`,
          action:  'Check that the correct order file is being uploaded and that the QTY column holds piece counts, not barcodes.',
          critical: true,
        });
      }
    }

    // ── 4. STATIC FIELD VALIDATION ────────────────────────────────────────
    if (!isBlank(row['d-uom']) && String(row['d-uom']).trim().toUpperCase() !== EXPECTED_UOM) {
      errors.push({
        excelRow,
        orderId,
        field:   'd-uom',
        issue:   'INCORRECT UNIT OF MEASURE',
        description: `Unit of Measure is "${row['d-uom']}" but expected "${EXPECTED_UOM}".`,
        action:  `Correct the unit of measure to "${EXPECTED_UOM}".`,
        critical: false,
      });
    }

    if (!isBlank(row['d-sitecode']) && String(row['d-sitecode']).trim() !== EXPECTED_SITECODE) {
      errors.push({
        excelRow,
        orderId,
        field:   'd-sitecode',
        issue:   'INCORRECT SITE CODE',
        description: `Site Code is "${row['d-sitecode']}" but expected "${EXPECTED_SITECODE}".`,
        action:  `Correct the site code to "${EXPECTED_SITECODE}".`,
        critical: false,
      });
    }
  }

  // ── 5. DATA CONSISTENCY VALIDATION ───────────────────────────────────────
  // Verify no order ID is missing from the output rows
  const missingOrderIds = wmsRows.filter(r => isBlank(r['d-exref2']));
  if (missingOrderIds.length > 0) {
    // Already caught above in mandatory field loop — no duplicate entry needed
  }

  // ── 6. BUILD RESULT ───────────────────────────────────────────────────────
  const rowsWithErrors = [...new Set(errors.map(e => e.excelRow))];
  const hasCritical    = errors.some(e => e.critical);
  const hasErrors      = errors.length > 0;

  return {
    passed:             !hasErrors,
    status:             hasErrors ? 'FAILED' : 'PASSED',
    totalRowsProcessed: wmsRows.length,
    totalErrors:        errors.length,
    rowsWithErrors:     rowsWithErrors.length,
    hasCritical,
    errors,
    // ── 7. ABORT MESSAGE (section 8 of ruleset) ─────────────────────────
    abortMessage: hasCritical
      ? 'UPLOAD ABORTED:\nOne or more validation errors detected, including missing or invalid delivery address.\nPlease correct all errors and re-upload.'
      : hasErrors
        ? 'UPLOAD ABORTED:\nValidation errors detected. Please correct all errors and re-upload.'
        : null,
  };
}

// ── SUCCESS CONDITION (section 9 of ruleset) ─────────────────────────────────
// ONLY if passed = true, status = 'PASSED', totalErrors = 0
// may the upload proceed.

module.exports = { validateRows, EXPECTED_UOM, EXPECTED_SITECODE };
