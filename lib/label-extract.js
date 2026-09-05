'use strict';
// Extracts key shipping-label fields from raw PDF text (from pdf-parse).
// Tuned for Lazada/TRACX labels but generic enough for most SG carrier formats.

function extractLabelFields(rawText) {
  const text  = rawText || '';

  // ── Tracking number ────────────────────────────────────────────────────────
  // Priority: TRACX TXSGD… > other SG prefixes > generic carrier pattern
  let trackingNumber = '';
  const tnPatterns = [
    /\b(TXSGD\d{8,})\b/i,
    /\b(SGDEX\d{8,})\b/i,
    /\b([A-Z]{2}\d{9}[A-Z]{2})\b/,          // postal tracking  e.g. RR123456789SG
    /\b([A-Z]{2,6}\d{9,18})\b/,              // generic: 2–6 letters + 9–18 digits
                                              // (covers SPXSG.../SPTTND... courier prefixes, up to 6 letters)
  ];
  for (const p of tnPatterns) {
    const m = text.match(p);
    if (m) { trackingNumber = m[1].toUpperCase(); break; }
  }

  // ── Order number ───────────────────────────────────────────────────────────
  // Lazada: 14–18 digit number, optionally with trailing letter (e.g. Z)
  // Also look for explicit labels like "Qder No.", "Order No.", "Order:"
  let orderNumber = '';
  const orderLabelMatch = text.match(
    /(?:Qder|Order)\s*(?:No\.?|Number|#)?\s*[:\s]\s*([1-9]\d{12,18}[A-Z]?)/i
  );
  if (orderLabelMatch) {
    orderNumber = orderLabelMatch[1];
  } else {
    // Shopee-style alphanumeric order ID, e.g. "Order ID: 260726PNCVDSYK"
    // (SPX/Shopee labels print this instead of a pure-digit Lazada-style ID)
    const shopeeMatch = text.match(/Order\s*ID\s*[:\s]+([A-Z0-9]{8,20})\b/i);
    if (shopeeMatch) {
      orderNumber = shopeeMatch[1].toUpperCase();
    } else {
      const laMatch = text.match(/\b(1\d{13,17}[A-Z]?)\b/);
      if (laMatch) orderNumber = laMatch[1];
    }
  }

  // ── Goods-issue (GI) number ────────────────────────────────────────────────
  // A Keyfields/WMS picking document identifies itself by its GI number — what
  // the floor calls "the order number" on those jobs, and what the *GI-…*
  // barcode on the sheet encodes. NONE of the marketplace patterns above can
  // see it (they want a 13–18 digit Lazada id or a Shopee "Order ID:"), so a
  // GI label reached matchLabelPage with every field blank and could only ever
  // match by the blind whole-page text scan — which has a length floor a short
  // GI can never clear. It gets its OWN field rather than competing with
  // orderNumber, so nothing about a Lazada or Shopee label changes, and its own
  // EXACT lookup in matchLabelPage, which is what makes a short GI matchable.
  let giNumber = '';
  // The literal token, as printed and barcoded: GI-25001234 / GI 25001234.
  const giLiteral = text.match(/\bGI[\s-]?(\d{4,})\b/i);
  if (giLiteral) {
    giNumber = 'GI-' + giLiteral[1];
  } else {
    // Captioned but unprefixed — "Issue No: 1300456", "GI No.: 1300456",
    // "iWMS GINo 1300456". This is where a GI stored in issue_no by the
    // XLSX/CSV path is printed, and it is frequently too short for the scan.
    const giCaption = text.match(
      /\b(?:GI|Issue)\s*(?:No\.?|Number|#)?\s*[:\s]\s*([A-Z0-9][A-Z0-9-]{3,19})\b/i
    );
    if (giCaption) giNumber = giCaption[1].toUpperCase();
  }

  // ── Recipient name ─────────────────────────────────────────────────────────
  let recipientName = '';
  const toMatch = text.match(/\bTo\s*:\s*\n?\s*([A-Za-z][^\n]{1,60})/);
  if (toMatch) recipientName = toMatch[1].trim();

  // ── Address and postal code ────────────────────────────────────────────────
  let address = '';
  let postalCode = '';
  const postalPatterns = [
    /\bS(\d{6})\b/,
    /Singapore\s+(\d{6})\b/i,
    /,\s*Singapore\s*,?\s*(\d{6})\b/i,
    /\b(\d{6})\b(?=\s*$)/m,
  ];
  for (const p of postalPatterns) {
    const m = text.match(p);
    if (m) { postalCode = m[1]; break; }
  }
  const addrBlock = text.match(/(?:To|Deliver\s*To)\s*:\s*\n([^\n]+)\n((?:[^\n]+\n){0,4})/i);
  if (addrBlock) {
    const lines = addrBlock[0].split('\n').map(l => l.trim()).filter(Boolean).slice(1);
    address = lines.join(', ');
  }

  // ── Sender / store name ────────────────────────────────────────────────────
  let senderName = '';
  const fromMatch = text.match(/\bFrom\s*:\s*([^\n]{1,60})/i);
  if (fromMatch) senderName = fromMatch[1].trim();

  // ── SKU and item description ───────────────────────────────────────────────
  let sku = '';
  let itemDescription = '';
  const skuBlockMatch = text.match(/SKU\s*[\/|]\s*Item\s*Description\s*\n\s*\d+\.\s+(\S+)\s+(.+)/i);
  if (skuBlockMatch) {
    sku             = skuBlockMatch[1];
    itemDescription = skuBlockMatch[2].trim();
  } else {
    const skuMatch = text.match(/\bSKU\s*[:/]?\s*([A-Z0-9\-]{3,20})/i);
    if (skuMatch) sku = skuMatch[1];
  }

  // ── Quantity ───────────────────────────────────────────────────────────────
  let qty = null;
  const qtyPatterns = [
    /(?:No\.\s*of\s*Items?|Qty|Quantity|QTY)\s*[:\s]*(\d+)/i,
    /\bQty\s*(\d+)\b/i,
  ];
  for (const p of qtyPatterns) {
    const m = text.match(p);
    if (m) { qty = parseInt(m[1]); break; }
  }

  // ── Package weight ─────────────────────────────────────────────────────────
  let weight = '';
  const weightMatch = text.match(/(?:Package\s*Weight|Weight)\s*[:\s]*([\d.]+\s*(?:kg)?)/i);
  if (weightMatch) weight = weightMatch[1].trim();

  // ── Label printed date ─────────────────────────────────────────────────────
  let labelPrintedDate = '';
  const dateMatch = text.match(/(?:Label\s*Printed?|Print\s*Date)\s*[:\s]*([\d\-\/. ]+\d{4})/i);
  if (dateMatch) labelPrintedDate = dateMatch[1].trim();

  return {
    trackingNumber,
    orderNumber,
    giNumber,
    recipientName,
    address,
    postalCode,
    senderName,
    sku,
    itemDescription,
    qty,
    weight,
    labelPrintedDate,
  };
}

module.exports = { extractLabelFields };
