// TMS Importer — Import Excel delivery schedules and order trackers
// Supports BETIME, Outright, and standard formats

const XLSX = require('xlsx');

function parseExcelFile(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const result = {};
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    result[sheetName] = XLSX.utils.sheet_to_json(sheet);
  }
  return result;
}

function detectFormat(row) {
  if (!row || typeof row !== 'object') return 'unknown';
  const keys = Object.keys(row).map(k => k.toLowerCase());
  const keyStr = keys.join('|');

  if (keyStr.includes('po no') || keyStr.includes('customer') || keyStr.includes('delivery date')) return 'betime';
  if (keyStr.includes('po number') || keyStr.includes('customer name') || keyStr.includes('invoice')) return 'outright';
  if (keyStr.includes('customer_id') || keyStr.includes('customer id')) return 'standard';
  return 'unknown';
}

function importBetimeDeliveries(rows) {
  const imported = [];
  const seen = new Set();

  if (!Array.isArray(rows)) return imported;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    // Extract fields (case-insensitive key matching)
    const keys = Object.keys(row);
    let poNo, customer, address, zip, deliveryDate, skuCount;

    for (const key of keys) {
      const lkey = key.toLowerCase().trim();
      if (lkey.includes('po no')) poNo = String(row[key] || '').trim();
      if (lkey.includes('customer')) customer = String(row[key] || '').trim();
      if (lkey.includes('add 1') || lkey.includes('address')) address = String(row[key] || '').trim();
      if (lkey.includes('postal') || lkey.includes('zip')) zip = String(row[key] || '').trim();
      if (lkey.includes('delivery date')) deliveryDate = row[key];
      if (lkey.includes('count of sku') || lkey.includes('order qty')) skuCount = Number(row[key]) || 0;
    }

    if (!poNo || !customer) continue;

    const key = `${poNo}-${deliveryDate}`;
    if (seen.has(key)) continue;
    seen.add(key);

    imported.push({
      customerId: poNo,
      name: customer,
      addressLine1: address || '',
      addressLine2: '',
      city: 'Singapore',
      state: 'SG',
      zip: zip || '',
      country: 'SG',
      phone: '',
      email: '',
      deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : null,
      skuCount: skuCount || 0,
      format: 'betime',
      items: (skuCount || 0) > 0
        ? [{ sku: 'DELIVERY-' + poNo, name: 'Delivery: ' + skuCount + ' items', qty: 1, unitPrice: 0 }]
        : []
    });
  }
  return imported;
}

function importOutrightOrders(rows) {
  const imported = [];

  if (!Array.isArray(rows)) return imported;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    const keys = Object.keys(row);
    let poNo, customer, invoice, deliveryDate;

    for (const key of keys) {
      const lkey = key.toLowerCase().trim();
      if (lkey.includes('po number') || lkey.includes('po no')) poNo = String(row[key] || '').trim();
      if (lkey.includes('customer name') || lkey.includes('customer')) customer = String(row[key] || '').trim();
      if (lkey.includes('invoice number') || lkey.includes('invoice')) invoice = String(row[key] || '').trim();
      if (lkey.includes('delivery date') || lkey.includes('uld confirmed')) deliveryDate = row[key];
    }

    if (!customer) continue;

    const customerId = poNo || invoice || customer.slice(0, 20).replace(/\s+/g, '-');

    imported.push({
      customerId: customerId,
      name: customer,
      addressLine1: '',
      addressLine2: '',
      city: 'Singapore',
      state: 'SG',
      zip: '',
      country: 'SG',
      phone: '',
      email: '',
      deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : null,
      invoiceNumber: invoice || '',
      format: 'outright',
      items: [{ sku: invoice || poNo, name: 'Order: ' + invoice, qty: 1, unitPrice: 0 }]
    });
  }
  return imported;
}

function createOrdersFromImport(importData, db) {
  const { customers = [], adjustments = [] } = importData;
  const created = [];
  const updated = [];
  const skipped = [];

  if (!Array.isArray(customers)) return { created, updated, skipped, adjustments };

  // Initialize transport array if needed
  if (!db.transport) db.transport = [];

  for (const customer of customers) {
    let orderId = customer.customerId;

    // Generate proper order ID format
    if (!orderId.startsWith('ORD-') && !orderId.startsWith('PO') &&
        !orderId.match(/^[A-Z]+-\d+/)) {
      orderId = `ORD-${customer.customerId}`;
    }

    // Check if order already exists
    const existing = db.transport.find(o => o.id === orderId);

    if (!existing) {
      const transportRequest = {
        id: orderId,
        clientId: customer.customerId,
        clientName: customer.name,
        channel: 'tms-import',
        createdAt: new Date().toISOString(),
        status: 'pending',
        currency: 'SGD',
        notes: 'Imported from TMS delivery schedule',
        items: customer.items || [],
        shipping: {
          recipient: customer.name,
          addressLine1: customer.addressLine1 || '',
          addressLine2: customer.addressLine2 || '',
          city: customer.city || 'Singapore',
          state: customer.state || 'SG',
          zip: customer.zip || '',
          country: customer.country || 'SG',
          phone: customer.phone || '',
          email: customer.email || ''
        },
        subtotal: 0,
        shippingCost: 0,
        tax: 0,
        total: 0,
        source: {
          importedAt: new Date().toISOString(),
          customerId: customer.customerId,
          format: customer.format || 'standard',
          deliveryDate: customer.deliveryDate,
          skuCount: customer.skuCount || 0,
          invoiceNumber: customer.invoiceNumber || ''
        }
      };

      try {
        db.transport.push(transportRequest);
        created.push(orderId);
      } catch (e) {
        skipped.push({ orderId, reason: e.message });
      }
    } else {
      // Update existing transport request
      existing.source = {
        ...(existing.source || {}),
        updatedAt: new Date().toISOString(),
        phone: customer.phone || existing.shipping?.phone || '',
        email: customer.email || existing.shipping?.email || ''
      };
      updated.push(orderId);
    }
  }

  return { created, updated, skipped, adjustments };
}

module.exports = {
  parseExcelFile,
  detectFormat,
  importBetimeDeliveries,
  importOutrightOrders,
  createOrdersFromImport
};
