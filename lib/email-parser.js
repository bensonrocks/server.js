'use strict';

/**
 * Parses a standardised order email body.
 *
 * Expected format:
 *
 *   ---ORDER-START---
 *   ORDER_ID: ORD-2026-001
 *   CLIENT_ID: acme-corp
 *   CLIENT_NAME: Acme Corp
 *   CHANNEL: shopify
 *   ORDER_DATE: 2026-05-03T10:00:00Z
 *   STATUS: confirmed
 *   CURRENCY: USD
 *   NOTES: Rush delivery
 *
 *   ---ITEMS---
 *   SKU|NAME|QTY|UNIT_PRICE
 *   WIDGET-BLU|Blue Widget|2|29.99
 *
 *   ---SHIPPING---
 *   RECIPIENT: John Doe
 *   ADDRESS_LINE1: 123 Main St
 *   ADDRESS_LINE2: Apt 4B
 *   CITY: New York
 *   STATE: NY
 *   ZIP: 10001
 *   COUNTRY: US
 *
 *   ---TOTALS---
 *   SUBTOTAL: 59.98
 *   SHIPPING: 5.99
 *   TAX: 5.40
 *   TOTAL: 71.37
 *   ---ORDER-END---
 */
function parseEmailBody(rawBody) {
  const START = '---ORDER-START---';
  const END = '---ORDER-END---';

  const startIdx = rawBody.indexOf(START);
  const endIdx = rawBody.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Invalid format: missing ---ORDER-START--- or ---ORDER-END--- markers');
  }

  const body = rawBody.slice(startIdx + START.length, endIdx).trim();
  const sections = extractSections(body);

  const header = parseKeyValue(sections.header || '');
  const items = parseItems(sections.ITEMS || '');
  const shipping = parseKeyValue(sections.SHIPPING || '');
  const totals = parseKeyValue(sections.TOTALS || '');

  for (const field of ['ORDER_ID', 'CLIENT_ID', 'CLIENT_NAME', 'CHANNEL']) {
    if (!header[field]) throw new Error(`Missing required field: ${field}`);
  }

  return {
    id: header.ORDER_ID,
    clientId: header.CLIENT_ID,
    clientName: header.CLIENT_NAME,
    channel: header.CHANNEL.toLowerCase(),
    orderDate: header.ORDER_DATE || new Date().toISOString(),
    status: (header.STATUS || 'pending').toLowerCase(),
    currency: header.CURRENCY || 'USD',
    notes: header.NOTES || '',
    items,
    shipping: {
      recipient: shipping.RECIPIENT || '',
      addressLine1: shipping.ADDRESS_LINE1 || '',
      addressLine2: shipping.ADDRESS_LINE2 || '',
      city: shipping.CITY || '',
      state: shipping.STATE || '',
      zip: shipping.ZIP || '',
      country: shipping.COUNTRY || 'US',
    },
    subtotal: parseFloat(totals.SUBTOTAL) || 0,
    shippingCost: parseFloat(totals.SHIPPING) || 0,
    tax: parseFloat(totals.TAX) || 0,
    total: parseFloat(totals.TOTAL) || 0,
    source: { type: 'email', ingestedAt: new Date().toISOString() },
  };
}

function extractSections(body) {
  const result = { header: '' };
  let current = 'header';
  for (const line of body.split('\n')) {
    const m = line.trim().match(/^---(\w+)---$/);
    if (m) {
      current = m[1];
      result[current] = result[current] || '';
    } else {
      result[current] += line + '\n';
    }
  }
  return result;
}

function parseKeyValue(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

function parseItems(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  return lines.slice(1).map(line => {
    const [sku, name, qty, unitPrice] = line.split('|').map(s => s.trim());
    return { sku: sku || '', name: name || '', qty: parseInt(qty, 10) || 0, unitPrice: parseFloat(unitPrice) || 0 };
  }).filter(i => i.sku);
}

module.exports = { parseEmailBody };
