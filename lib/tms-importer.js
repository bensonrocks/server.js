// TMS Importer — Import Excel delivery schedules and order trackers
// Uses attribute-based detection (data content) instead of field names

const XLSX = require('xlsx');

function parseExcelFile(buffer) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const result = {};
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      result[sheetName] = XLSX.utils.sheet_to_json(sheet);
    }
    return result;
  } catch (err) {
    throw new Error(`Failed to parse Excel file: ${err.message}`);
  }
}

// Detect column attributes based on data content
function analyzeColumnType(values) {
  if (!Array.isArray(values) || values.length === 0) return { type: 'unknown' };

  const nonEmpty = values.filter(v => v != null && String(v).trim() !== '');
  if (nonEmpty.length === 0) return { type: 'empty' };

  const sample = String(nonEmpty[0]).trim();

  // Check all values for consistency (most specific first)
  const allDateFormat = nonEmpty.every(v => {
    const s = String(v).trim();
    return /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4}/.test(s);
  });

  // Singapore postal codes are exactly 6 digits
  const allPostalFormat = nonEmpty.every(v => /^\d{6}$/.test(String(v).trim()));

  const allOrderCodeFormat = nonEmpty.every(v => {
    const s = String(v).trim();
    // Order codes: alphanumeric with hyphens, 4-20 chars
    return /^[A-Z0-9\-]{4,20}$/i.test(s) && /[A-Z0-9]/i.test(s);
  });

  const allPhoneFormat = nonEmpty.every(v => {
    const s = String(v).trim();
    // Phone: digits, spaces, dashes, parens, +, typically 7+ chars
    return /^[+]?[\d\s\-()]{7,}$/.test(s) && /\d{3,}/.test(s);
  });

  const allNumericFormat = nonEmpty.every(v => !isNaN(parseFloat(v)) && String(v).trim() !== '');

  // Priority order for detection (most specific → least specific)

  // Date detection (very specific pattern)
  if (allDateFormat) {
    return { type: 'date' };
  }

  // Postal code detection (all values are exactly 3-6 digits)
  if (allPostalFormat) {
    return { type: 'postal_code' };
  }

  // Order code detection (uppercase alphanumeric with hyphens)
  if (allOrderCodeFormat) {
    return { type: 'order_code' };
  }

  // Phone number detection (must be after date since dates also have dashes)
  if (allPhoneFormat && !allDateFormat) {
    return { type: 'phone' };
  }

  // Address detection (before quantity to catch addresses starting with numbers)
  const avgLength = nonEmpty.reduce((sum, v) => sum + String(v).length, 0) / nonEmpty.length;
  const hasAddressKeywords = nonEmpty.some(v => /\b(road|street|jalan|ave|avenue|blvd|boulevard|lane|drive|court|plaza|complex|centre|center|sg|singapore)\b/i.test(String(v)));
  if (avgLength > 15 || (avgLength > 10 && hasAddressKeywords)) {
    return { type: 'address' };
  }

  // Quantity/Number detection (all numeric, typically smaller numbers)
  if (allNumericFormat && nonEmpty.every(v => parseFloat(v) < 10000)) {
    return { type: 'quantity', isNumeric: true };
  }

  // Text (default)
  return { type: 'text' };
}

// Analyze all columns in a dataset
function analyzeColumns(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return {};

  const analysis = {};
  const firstRow = rows[0];
  const keys = Object.keys(firstRow);

  for (const key of keys) {
    const values = rows.map(r => r[key]);
    analysis[key] = analyzeColumnType(values);
  }

  return analysis;
}

// Extract customer data based on detected attributes
function extractCustomerFromRow(row, columnAnalysis) {
  const result = {
    name: '',
    addressLine1: '',
    city: 'Singapore',
    state: 'SG',
    zip: '',
    country: 'SG',
    phone: '',
    email: '',
    orderId: ''
  };

  // Map columns by their detected type
  const typeMap = {};
  for (const [key, analysis] of Object.entries(columnAnalysis)) {
    if (!typeMap[analysis.type]) typeMap[analysis.type] = [];
    typeMap[analysis.type].push(key);
  }

  // Extract order code (highest priority)
  if (typeMap.order_code && typeMap.order_code[0] && row[typeMap.order_code[0]]) {
    result.orderId = String(row[typeMap.order_code[0]]).trim();
  }

  // Extract phone
  if (typeMap.phone && typeMap.phone[0] && row[typeMap.phone[0]]) {
    result.phone = String(row[typeMap.phone[0]]).trim();
  }

  // Extract postal code
  if (typeMap.postal_code && typeMap.postal_code[0] && row[typeMap.postal_code[0]]) {
    result.zip = String(row[typeMap.postal_code[0]]).trim();
  }

  // Extract name and address from text/address columns
  // If we have text columns, use them (first = name, second = address)
  if (typeMap.text && typeMap.text.length > 0) {
    if (typeMap.text[0] && row[typeMap.text[0]]) {
      result.name = String(row[typeMap.text[0]]).trim();
    }
    if (typeMap.text[1] && row[typeMap.text[1]]) {
      result.addressLine1 = String(row[typeMap.text[1]]).trim();
    }
  }

  // If we don't have name yet, check address columns (first address = name if no text found)
  if (!result.name && typeMap.address && typeMap.address.length > 0) {
    // The first address-like column might actually be the company name
    const firstAddr = String(row[typeMap.address[0]]).trim();
    if (firstAddr.length < 50 && !firstAddr.includes('Road') && !firstAddr.includes('Street') && !firstAddr.includes('Avenue')) {
      result.name = firstAddr;
    } else {
      result.addressLine1 = firstAddr;
    }
  }

  // If we still need address, take remaining address columns
  if (!result.addressLine1 && typeMap.address && typeMap.address.length > 1) {
    result.addressLine1 = String(row[typeMap.address[1]]).trim();
  } else if (!result.addressLine1 && typeMap.address) {
    // Fallback to using address[0] if it looks like an address
    const firstAddr = String(row[typeMap.address[0]]).trim();
    if (firstAddr.includes('Road') || firstAddr.includes('Street') || firstAddr.includes('Avenue') || firstAddr.includes('Jalan') || firstAddr.length > 30) {
      result.addressLine1 = firstAddr;
    }
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

  if (!Array.isArray(rows) || rows.length === 0) return imported;

  // Analyze columns to detect their types
  const columnAnalysis = analyzeColumns(rows);

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    // Extract data based on attributes
    const custData = extractCustomerFromRow(row, columnAnalysis);
    let poNo = custData.orderId;
    let customer = custData.name;
    let deliveryDate = null;
    let skuCount = 0;

    // Look for date column (delivery date)
    for (const [key, analysis] of Object.entries(columnAnalysis)) {
      if (analysis.type === 'date' && !deliveryDate && row[key]) {
        try {
          deliveryDate = new Date(row[key]).toISOString();
        } catch (e) {
          deliveryDate = null;
        }
      }
      if (analysis.type === 'quantity' && !skuCount && row[key]) {
        skuCount = Number(row[key]) || 0;
      }
    }

    // Fallback to field name matching if attributes didn't find these
    if (!poNo) {
      for (const key of Object.keys(row)) {
        if (key.toLowerCase().includes('po no')) {
          poNo = String(row[key] || '').trim();
          break;
        }
      }
    }

    if (!customer) {
      for (const key of Object.keys(row)) {
        if (key.toLowerCase().includes('customer')) {
          customer = String(row[key] || '').trim();
          break;
        }
      }
    }

    if (!poNo || !customer) continue;

    const dedupeKey = `${poNo}-${deliveryDate}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    imported.push({
      customerId: poNo,
      name: customer,
      addressLine1: custData.addressLine1 || '',
      addressLine2: '',
      city: 'Singapore',
      state: 'SG',
      zip: custData.zip || '',
      country: 'SG',
      phone: custData.phone || '',
      email: custData.email || '',
      deliveryDate: deliveryDate,
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

  if (!Array.isArray(rows) || rows.length === 0) return imported;

  // Analyze columns to detect their types
  const columnAnalysis = analyzeColumns(rows);

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    // Extract data based on attributes
    const custData = extractCustomerFromRow(row, columnAnalysis);
    let customer = custData.name;
    let poNo = custData.orderId;
    let invoice = '';
    let deliveryDate = null;

    // Look for more order codes and dates
    for (const [key, analysis] of Object.entries(columnAnalysis)) {
      if (analysis.type === 'date' && !deliveryDate && row[key]) {
        try {
          deliveryDate = new Date(row[key]).toISOString();
        } catch (e) {
          deliveryDate = null;
        }
      }
      // Second order code could be invoice
      if (analysis.type === 'order_code' && !invoice && custData.orderId !== String(row[key]).trim() && row[key]) {
        invoice = String(row[key]).trim();
      }
    }

    // Fallback to field name matching
    if (!customer) {
      for (const key of Object.keys(row)) {
        if (key.toLowerCase().includes('customer')) {
          customer = String(row[key] || '').trim();
          break;
        }
      }
    }

    if (!poNo) {
      for (const key of Object.keys(row)) {
        if (key.toLowerCase().includes('po')) {
          poNo = String(row[key] || '').trim();
          break;
        }
      }
    }

    if (!invoice) {
      for (const key of Object.keys(row)) {
        if (key.toLowerCase().includes('invoice')) {
          invoice = String(row[key] || '').trim();
          break;
        }
      }
    }

    if (!customer) continue;

    const customerId = poNo || invoice || customer.slice(0, 20).replace(/\s+/g, '-');

    imported.push({
      customerId: customerId,
      name: customer,
      addressLine1: custData.addressLine1 || '',
      addressLine2: '',
      city: 'Singapore',
      state: 'SG',
      zip: custData.zip || '',
      country: 'SG',
      phone: custData.phone || '',
      email: custData.email || '',
      deliveryDate: deliveryDate,
      invoiceNumber: invoice || '',
      format: 'outright',
      items: [{ sku: invoice || poNo, name: 'Order: ' + (invoice || poNo), qty: 1, unitPrice: 0 }]
    });
  }
  return imported;
}

// Generate transport record ID (TR-YYMMDD-NNN)
function nextTransportCode(db) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '').slice(2); // YYMMDD
  const seqKey = `transportCodeSeq_${today}`;

  if (!db[seqKey]) {
    db[seqKey] = 1;
  } else {
    db[seqKey]++;
  }

  const num = String(db[seqKey]).padStart(3, '0');
  return `TR-${today}-${num}`;
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
    // Check if transport record already exists for this customer + delivery date
    const existing = db.transport.find(o =>
      o.clientId === customer.customerId &&
      o.source?.deliveryDate === customer.deliveryDate
    );

    if (!existing) {
      // Generate unique transport record ID only for new records
      const transportId = nextTransportCode(db);
      const transportRequest = {
        id: transportId,
        referenceId: customer.customerId, // Original customer/PO reference
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
        created.push(transportId);
      } catch (e) {
        skipped.push({ transportId, reason: e.message });
      }
    } else {
      // Update existing transport request
      existing.source = {
        ...(existing.source || {}),
        updatedAt: new Date().toISOString(),
        phone: customer.phone || existing.shipping?.phone || '',
        email: customer.email || existing.shipping?.email || ''
      };
      updated.push(existing.id);
    }
  }

  return { created, updated, skipped, adjustments };
}

module.exports = {
  parseExcelFile,
  detectFormat,
  analyzeColumnType,
  analyzeColumns,
  extractCustomerFromRow,
  importBetimeDeliveries,
  importOutrightOrders,
  createOrdersFromImport,
  nextTransportCode
};
