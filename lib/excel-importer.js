'use strict';

const XLSX = require('xlsx');

function createImporter({ store }) {
  // Parse Excel file buffer and return sheet data as array of objects
  function parseExcel(buffer) {
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const result = {};
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        result[sheetName] = XLSX.utils.sheet_to_json(sheet);
      }
      return result;
    } catch (e) {
      throw new Error('Failed to parse Excel file: ' + e.message);
    }
  }

  // Import TMS_CUSTOMER.xlsx or real-world formats
  // Supports: standard TMS format + BETIME format + Outright format
  function importCustomers(rows) {
    if (!Array.isArray(rows)) throw new Error('Customers sheet must contain array of rows');

    const imported = [];
    for (const row of rows) {
      // Detect format by examining available columns
      const isBetimeFormat = 'PO NO' in row || 'CUSTOMER' in row;
      const isOutrightFormat = 'Customer Name' in row || 'PO Number' in row;

      let customerId, name, addressLine1, zip, deliveryDate;

      if (isBetimeFormat) {
        // BETIME_DELIVERY_SCHEDULE format
        customerId = String(row['PO NO'] || '').trim();
        name = (row['CUSTOMER'] || row[' CUSTOMER'] || '').trim();
        addressLine1 = (row[' ADD 1'] || row['ADD 1'] || '').trim();
        zip = String(row[' POSTAL CODE'] || row['POSTAL CODE'] || '').trim();
        deliveryDate = row['DELIVERY DATE'];
      } else if (isOutrightFormat) {
        // Outright Order Tracker format
        customerId = (row['PO Number'] || row['PO NO'] || '').toString().trim();
        name = (row['Customer Name'] || row['CUSTOMER'] || '').trim();
        addressLine1 = row['Address'] || row[' ADD 1'] || '';
        zip = row['Postal Code'] || row[' POSTAL CODE'] || '';
        deliveryDate = row['ULD Confirmed Delivery Date'] || row['Delivery Date '] || row['DELIVERY DATE'];
      } else {
        // Standard TMS format
        customerId = (row['customer_id'] || row['Customer ID'] || '').trim();
        name = (row['name'] || row['Name'] || '').trim();
        addressLine1 = row['address_line1'] || row['Address Line 1'] || '';
        zip = row['zip'] || row['ZIP'] || '';
      }

      if (!customerId || !name) continue;

      imported.push({
        customerId: customerId.slice(0, 50), // Cap ID length
        name: name.slice(0, 100),
        addressLine1: String(addressLine1).slice(0, 100),
        addressLine2: '',
        city: 'Singapore',
        state: 'SG',
        zip: String(zip).slice(0, 10),
        country: 'SG',
        phone: '',
        email: '',
        deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : null,
      });
    }
    return imported;
  }

  // Import TMS_STORE_CODE.xlsx: store locations for delivery hubs
  // Expected columns: store_code, store_name, address_line1, address_line2, city, zip, latitude, longitude
  function importStoreCodes(rows) {
    if (!Array.isArray(rows)) throw new Error('Store Codes sheet must contain array of rows');

    const imported = [];
    for (const row of rows) {
      const storeCode = (row['store_code'] || row['Store Code'] || '').trim();
      const storeName = (row['store_name'] || row['Store Name'] || '').trim();
      if (!storeCode || !storeName) continue;

      imported.push({
        storeCode,
        storeName,
        addressLine1: row['address_line1'] || row['Address Line 1'] || '',
        addressLine2: row['address_line2'] || row['Address Line 2'] || '',
        city: row['city'] || row['City'] || '',
        zip: row['zip'] || row['ZIP'] || '',
        latitude: row['latitude'] || row['Latitude'],
        longitude: row['longitude'] || row['Longitude'],
      });
    }
    return imported;
  }

  // Import TMS_ADJUSTMENT.xlsx: order quantity/delivery adjustments
  // Expected columns: order_id, adjustment_type (qty|delivery|price), old_value, new_value, reason
  function importAdjustments(rows) {
    if (!Array.isArray(rows)) throw new Error('Adjustments sheet must contain array of rows');

    const imported = [];
    for (const row of rows) {
      const orderId = (row['order_id'] || row['Order ID'] || '').trim();
      const type = (row['adjustment_type'] || row['Type'] || 'qty').toLowerCase();
      const reason = (row['reason'] || row['Reason'] || 'System adjustment').trim();

      if (!orderId) continue;

      imported.push({
        orderId,
        adjustmentType: type,
        oldValue: row['old_value'] || row['Old Value'],
        newValue: row['new_value'] || row['New Value'],
        reason,
        appliedAt: new Date().toISOString(),
      });
    }
    return imported;
  }

  // Create/update orders from import data
  function createOrdersFromImport(importData) {
    const { customers = [], adjustments = [] } = importData;

    const created = [];
    const updated = [];
    const skipped = [];

    for (const customer of customers) {
      // Use customerId directly if it looks like an order ID, otherwise prefix with ORD-
      let orderId = customer.customerId;
      if (!orderId.startsWith('ORD-') && !orderId.startsWith('PO') &&
          !orderId.match(/^[A-Z]+-\d+/)) {
        orderId = `ORD-${customer.customerId}`;
      }

      const existing = store.getOrder(orderId);

      if (!existing) {
        // Create new order
        const order = {
          id: orderId,
          clientId: customer.customerId,
          clientName: customer.name,
          channel: 'tms-import',
          orderDate: customer.deliveryDate || new Date().toISOString(),
          status: 'pending',
          currency: 'SGD',
          notes: 'Imported from TMS delivery schedule',
          items: customer.items || [],
          shipping: {
            recipient: customer.name,
            addressLine1: customer.addressLine1,
            addressLine2: customer.addressLine2 || '',
            city: customer.city,
            state: customer.state,
            zip: customer.zip,
            country: customer.country,
            phone: customer.phone || '',
            email: customer.email || '',
          },
          subtotal: 0,
          shippingCost: 0,
          tax: 0,
          total: 0,
          source: {
            importedAt: new Date().toISOString(),
            customerId: customer.customerId,
            format: customer.format || 'standard',
          },
        };
        try {
          store.addOrder(order);
          created.push(orderId);
        } catch (e) {
          skipped.push({ orderId, reason: e.message });
        }
      } else {
        // Update existing order's shipping info
        const updated_source = {
          ...(existing.source || {}),
          updatedAt: new Date().toISOString(),
          phone: customer.phone || existing.shipping?.phone || '',
          email: customer.email || existing.shipping?.email || '',
        };
        store.updateSource(orderId, updated_source);
        updated.push(orderId);
      }
    }

    return { created, updated, skipped, adjustments };
  }

  // Import BETIME delivery schedule format
  // Expected columns: PO NO, CUSTOMER, STORE NAME, ADD 1, POSTAL CODE, DELIVERY DATE, etc.
  function importBetimeDeliveries(rows) {
    if (!Array.isArray(rows)) throw new Error('BETIME sheet must contain array of rows');

    const imported = [];
    const seen = new Set(); // Track duplicate PO NOs on same date

    for (const row of rows) {
      const poNo = String(row['PO NO'] || '').trim();
      const customer = (row['CUSTOMER'] || row[' CUSTOMER'] || '').trim();
      const storeName = (row[' STORE NAME'] || row['STORE NAME'] || '').trim();
      const address = (row[' ADD 1'] || row['ADD 1'] || '').trim();
      const zip = String(row[' POSTAL CODE'] || row['POSTAL CODE'] || '').trim();
      const deliveryDate = row['DELIVERY DATE'];
      const skuCount = row['Count of SKU'] || row['ORDER QTY'] || 0;

      if (!poNo || !customer) continue;

      // Skip if already seen (handles duplicate rows in TESTING sheet)
      const key = `${poNo}-${deliveryDate}`;
      if (seen.has(key)) continue;
      seen.add(key);

      imported.push({
        customerId: poNo,
        name: customer,
        storeName: storeName,
        addressLine1: address,
        addressLine2: '',
        city: 'Singapore',
        state: 'SG',
        zip: zip || '',
        country: 'SG',
        phone: '',
        email: '',
        deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : null,
        skuCount: skuCount,
        format: 'betime',
        items: skuCount > 0 ? [{ sku: 'DELIVERY-' + poNo, name: 'Delivery: ' + skuCount + ' items', qty: 1, unitPrice: 0 }] : [],
      });
    }

    return imported;
  }

  // Import OUTRIGHT order format (by customer segment)
  // Expected columns: Customer Name, PO Number, Invoice Number, ULD Confirmed Delivery Date
  function importOutrightOrders(rows) {
    if (!Array.isArray(rows)) throw new Error('Outright sheet must contain array of rows');

    const imported = [];

    for (const row of rows) {
      const poNo = (row['PO Number'] || row['PO NO'] || '').toString().trim();
      const customer = (row['Customer Name'] || row['CUSTOMER'] || '').trim();
      const invoice = (row['Invoice Number'] || row['Invoice'] || '').trim();
      const deliveryDate = row['ULD Confirmed Delivery Date'] || row['Delivery Date '] || row['DELIVERY DATE'];

      if (!customer) continue;

      imported.push({
        customerId: poNo || invoice || customer.slice(0, 20).replace(/\s+/g, '-'),
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
        invoiceNumber: invoice,
        format: 'outright',
        items: [{ sku: invoice || poNo, name: 'Order: ' + invoice, qty: 1, unitPrice: 0 }],
      });
    }

    return imported;
  }

  return {
    parseExcel,
    importCustomers,
    importStoreCodes,
    importAdjustments,
    importBetimeDeliveries,
    importOutrightOrders,
    createOrdersFromImport,
  };
}

module.exports = createImporter;
