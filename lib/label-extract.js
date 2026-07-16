'use strict';

/**
 * Label Extraction Utility
 * Extracts key shipping information from raw label text (PDF, OCR, etc.)
 * Patterns tuned for SG/regional carrier formats (Lazada, Shopee, DHL, FedEx, etc.)
 */

function extractLabelFields(rawText) {
  const text = (rawText || '').trim();

  // ── Tracking Number ────────────────────────────────────────────────────────
  // Priority: Regional prefixes > postal codes > generic carrier pattern
  let trackingNumber = '';
  const tnPatterns = [
    /\b(TXSGD\d{8,})\b/i,                    // TRACX (Lazada)
    /\b(SGDEX\d{8,})\b/i,                    // SGDEX
    /\b([A-Z]{2}\d{9}[A-Z]{2})\b/,           // Postal tracking (RR123456789SG)
    /\b(SG\d{10,20})\b/i,                    // Generic SG prefix
    /\b([A-Z]{2,4}\d{10,18})\b/,             // Generic: 2–4 letters + 10–18 digits
  ];
  for (const pattern of tnPatterns) {
    const match = text.match(pattern);
    if (match) {
      trackingNumber = match[1].toUpperCase();
      break;
    }
  }

  // ── Order Number ───────────────────────────────────────────────────────────
  // Lazada: 14–18 digit number with optional trailing letter
  let orderNumber = '';
  const orderLabelMatch = text.match(
    /(?:Order|Qder|GI|Reference)\s*(?:No\.?|Number|#)?\s*[:\s]\s*([1-9]\d{12,18}[A-Z]?)/i
  );
  if (orderLabelMatch) {
    orderNumber = orderLabelMatch[1];
  } else {
    // Fallback: look for 13+ digit sequence (Lazada orders)
    const laMatch = text.match(/\b(1\d{13,17}[A-Z]?)\b/);
    if (laMatch) orderNumber = laMatch[1];
  }

  // ── Recipient Name ─────────────────────────────────────────────────────────
  let recipientName = '';
  const toMatch = text.match(/\b(?:To|Recipient|Ship\s+to)\s*[:\s]\s*\n?\s*([A-Za-z][^\n]{1,60})/i);
  if (toMatch) recipientName = toMatch[1].trim();

  // ── Address and Postal Code ────────────────────────────────────────────────
  let address = '';
  let postalCode = '';
  const postalPatterns = [
    /\bS(\d{6})\b/,                          // S followed by 6 digits
    /(?:Singapore|SG)\s+(\d{6})\b/i,         // Singapore + 6 digits
    /,\s*(\d{6})\s*(?:,?\s*Singapore)?\b/i, // Comma + 6 digits + optional Singapore
    /\b(\d{6})\b(?=\s*$)/m,                  // 6 digits at end of text
  ];
  for (const pattern of postalPatterns) {
    const match = text.match(pattern);
    if (match) {
      postalCode = match[1];
      break;
    }
  }

  const addrBlock = text.match(
    /(?:To|Deliver\s+To|Recipient|Ship\s+To)\s*:?\s*\n([^\n]+)\n((?:[^\n]+\n){0,4})/i
  );
  if (addrBlock) {
    const lines = addrBlock[0].split('\n').map(l => l.trim()).filter(Boolean).slice(1);
    address = lines.join(', ');
  }

  // ── Sender / Store Name ────────────────────────────────────────────────────
  let senderName = '';
  const fromMatch = text.match(/\b(?:From|Seller|Store)\s*:?\s*([^\n]{1,60})/i);
  if (fromMatch) senderName = fromMatch[1].trim();

  // ── SKU and Item Description ───────────────────────────────────────────────
  let sku = '';
  let itemDescription = '';
  const skuBlockMatch = text.match(
    /(?:SKU|Product|Item)\s*[\/|]\s*(?:Description|Name)\s*\n?\s*\d+\.\s+(\S+)\s+(.+)/i
  );
  if (skuBlockMatch) {
    sku = skuBlockMatch[1];
    itemDescription = skuBlockMatch[2].trim();
  } else {
    const skuMatch = text.match(/\b(?:SKU|Code|Product Code)\s*[:\s]+([A-Z0-9\-]{3,20})/i);
    if (skuMatch) sku = skuMatch[1];
  }

  // ── Quantity ───────────────────────────────────────────────────────────────
  let qty = null;
  const qtyPatterns = [
    /(?:No\.\s*of\s*Items?|Qty|Quantity|QTY|Count)\s*[:\s]*(\d+)/i,
    /\b(?:Qty|QTY)\s*[:\s]*(\d+)/i,
    /^(\d+)\s*(?:x|pcs|pieces|ea|each)$/im,
  ];
  for (const pattern of qtyPatterns) {
    const match = text.match(pattern);
    if (match) {
      qty = parseInt(match[1], 10);
      break;
    }
  }

  // ── Weight and Dimensions ──────────────────────────────────────────────────
  let weight = null;
  let weightUnit = '';
  const weightPatterns = [
    /\b(?:Weight|Wt)\s*[:\s]*(\d+(?:\.\d+)?)\s*(kg|g|lbs?)/i,
    /\b(\d+(?:\.\d+)?)\s*(kg|g|lbs?)(?:\s|$)/i,
  ];
  for (const pattern of weightPatterns) {
    const match = text.match(pattern);
    if (match) {
      weight = parseFloat(match[1]);
      weightUnit = match[2].toLowerCase();
      break;
    }
  }

  let dimensions = {};
  const dimPatterns = [
    /(?:L|Length)\s*[:\s]*(\d+(?:\.\d+)?)\s*(?:x|X|×)\s*(?:W|Width)\s*[:\s]*(\d+(?:\.\d+)?)\s*(?:x|X|×)\s*(?:H|Height)\s*[:\s]*(\d+(?:\.\d+)?)/,
    /(\d+)\s*cm\s*×\s*(\d+)\s*cm\s*×\s*(\d+)\s*cm/i,
  ];
  for (const pattern of dimPatterns) {
    const match = text.match(pattern);
    if (match) {
      dimensions = { length: parseFloat(match[1]), width: parseFloat(match[2]), height: parseFloat(match[3]) };
      break;
    }
  }

  // ── Service Type / Shipping Method ─────────────────────────────────────────
  let serviceType = '';
  const servicePatterns = [
    /(?:Service|Shipping\s+Method|Type)\s*[:\s]*([^\n]+)/i,
    /\b(?:Standard|Express|Overnight|Ground|Air|Sea)\b/i,
  ];
  for (const pattern of servicePatterns) {
    const match = text.match(pattern);
    if (match) {
      serviceType = (match[1] || match[0]).trim();
      break;
    }
  }

  // ── Barcode (typically printed as visual element, but may appear as text) ──
  let barcode = '';
  const barcodePatterns = [
    /\b(?:Barcode|Code128|UPC|EAN|ISBN)\s*[:\s]*([A-Z0-9]{8,})/i,
    /^\|([A-Z0-9]{8,})\|$/m,                  // Barcode wrapped in pipes
  ];
  for (const pattern of barcodePatterns) {
    const match = text.match(pattern);
    if (match) {
      barcode = match[1];
      break;
    }
  }

  // ── Reference Fields (PO, Invoice, etc.) ───────────────────────────────────
  let poNumber = '';
  let invoiceNumber = '';
  const poMatch = text.match(/\b(?:PO|Purchase\s+Order)\s*[:\s]*([A-Z0-9\-]{4,20})/i);
  if (poMatch) poNumber = poMatch[1];
  const invMatch = text.match(/\b(?:Invoice|INV)\s*[:\s]*([A-Z0-9\-]{4,20})/i);
  if (invMatch) invoiceNumber = invMatch[1];

  return {
    trackingNumber,
    orderNumber,
    recipientName,
    address,
    postalCode,
    senderName,
    sku,
    itemDescription,
    qty,
    weight,
    weightUnit,
    dimensions,
    serviceType,
    barcode,
    poNumber,
    invoiceNumber,
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Extract fields from multiple label variations
 * Returns array of extracted field sets, one per label detected
 */
function extractMultipleLabels(rawText) {
  // Simple heuristic: split on page breaks or repeated "To:" patterns
  const labels = [];
  const pageBreakPattern = /(?:[\f\n]{2,}|Page\s+\d+)/i;
  const pages = rawText.split(pageBreakPattern);

  for (const page of pages) {
    if (page.trim().length > 50) {
      // Only process pages with substantial content
      labels.push(extractLabelFields(page));
    }
  }

  return labels.length > 0 ? labels : [extractLabelFields(rawText)];
}

module.exports = {
  extractLabelFields,
  extractMultipleLabels,
};
