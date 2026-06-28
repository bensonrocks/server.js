'use strict';

// ── Extraction Instructions ────────────────────────────────────────────────────
// Edit this file to change how the AI reads uploaded documents.
// All changes here take effect immediately — no need to touch file-importer.js.
// ─────────────────────────────────────────────────────────────────────────────

// ── Output schema ─────────────────────────────────────────────────────────────
// Defines the JSON structure the AI must return for every order it finds.
// Add or rename fields here, then update extractedToOrder() in server.js
// to map the new fields into the OMS order format.

const OUTPUT_SCHEMA = `[{
  "orderNumber":   "waybill number, tracking number, DO number, or any unique reference — string or null",
  "clientName":    "sender / shipper / account name — string or null",
  "recipientName": "consignee / deliver-to / ship-to name — string or null",
  "addressLine1":  "street address — string or null",
  "addressLine2":  "unit, floor, building — string or null",
  "city":          "city or town — string or null",
  "state":         "state or province — string or null",
  "zip":           "postcode / ZIP — string or null",
  "country":       "2-letter ISO code; default MY if not shown — string",
  "courier":       "carrier / logistics company name — string or null",
  "trackingNumber":"airway bill / tracking / AWB number — string or null",
  "items": [
    {
      "sku":       "product/item code or barcode — string (use ITEM if none)",
      "name":      "product description or goods description — string",
      "qty":       "quantity as integer — number (default 1)",
      "unitPrice": "unit price as decimal — number (default 0)"
    }
  ],
  "notes": "any extra remarks, special instructions, or reference numbers — string or null"
}]`;

// ── Base instruction — applied to all file types ──────────────────────────────
// Change this if you want to add universal rules (e.g. currency assumptions,
// client name normalisation, or extra fields to look for).

const BASE = `Extract ALL order or shipment records found in this file.
Return ONLY a raw JSON array — no markdown, no code fences, no explanation.
Use this exact structure for each order:

${OUTPUT_SCHEMA}

Rules:
- If multiple orders / waybills appear, return one object per order.
- If a field is genuinely absent, use null (not an empty string).
- For items: if no individual SKU/product breakdown is visible, create one item
  using the goods description as the name and qty 1.
- Country defaults to "MY" when not shown.
- If you find no extractable order data at all, return [].`;

// ── Per-type preambles ────────────────────────────────────────────────────────
// These are prepended before BASE to give the model context about the file.
// Edit the relevant one if you need type-specific hints.

const PREAMBLE = {
  image: `You are reading a waybill, shipping label, or delivery order image.
Carefully read all text — printed, handwritten, or stamped — including barcodes
labels, sender/receiver boxes, and any table of contents or item listings.`,

  pdf: `You are reading a PDF document that may be a waybill, delivery order (DO),
packing list, shipping manifest, invoice, or a batch of multiple such documents.
Extract every distinct shipment or order record you find.`,

  text: `You are reading the text content of a Word document or similar file.
It may contain one or more orders, delivery instructions, or shipment records.
Extract every distinct order or shipment entry you find.`,
};

// ── Exported prompt builders ──────────────────────────────────────────────────

module.exports = {
  forImage: `${PREAMBLE.image}\n\n${BASE}`,
  forPDF:   `${PREAMBLE.pdf}\n\n${BASE}`,
  forText:  (text) => `${PREAMBLE.text}\n\n${BASE}\n\nDocument content:\n${text.slice(0, 8000)}`,
};
