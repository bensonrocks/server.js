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

  // Import TMS_CUSTOMER.xlsx: customer data with addresses
  // Expected columns: customer_id, name, address_line1, address_line2, city, state, zip, country, phone, email
  function importCustomers(rows) {
    if (!Array.isArray(rows)) throw new Error('Customers sheet must contain array of rows');

    const imported = [];
    for (const row of rows) {
      const customerId = (row['customer_id'] || row['Customer ID'] || '').trim();
      const name = (row['name'] || row['Name'] || '').trim();
      if (!customerId || !name) continue;

      imported.push({
        customerId,
        name,
        addressLine1: row['address_line1'] || row['Address Line 1'] || '',
        addressLine2: row['address_line2'] || row['Address Line 2'] || '',
        city: row['city'] || row['City'] || '',
        state: row['state'] || row['State'] || '',
        zip: row['zip'] || row['ZIP'] || '',
        country: row['country'] || row['Country'] || 'SG',
        phone: row['phone'] || row['Phone'] || '',
        email: row['email'] || row['Email'] || '',
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

    for (const customer of customers) {
      // For each customer, create an order if it doesn't exist
      const orderId = `ORD-${customer.customerId}`;
      const existing = store.getOrder(orderId);

      if (!existing) {
        // Create new order
        const order = {
          id: orderId,
          clientId: customer.customerId,
          clientName: customer.name,
          channel: 'tms-import',
          orderDate: new Date().toISOString(),
          status: 'pending',
          currency: 'SGD',
          notes: 'Imported from TMS',
          items: [],
          shipping: {
            recipient: customer.name,
            addressLine1: customer.addressLine1,
            addressLine2: customer.addressLine2,
            city: customer.city,
            state: customer.state,
            zip: customer.zip,
            country: customer.country,
            phone: customer.phone,
            email: customer.email,
          },
          subtotal: 0,
          shippingCost: 0,
          tax: 0,
          total: 0,
          source: {
            importedAt: new Date().toISOString(),
            customerId: customer.customerId,
          },
        };
        try {
          store.addOrder(order);
          created.push(orderId);
        } catch (e) {
          // Skip if duplicate or invalid
        }
      } else {
        // Update existing order's shipping info
        const updated_source = {
          ...(existing.source || {}),
          updatedAt: new Date().toISOString(),
          phone: customer.phone,
          email: customer.email,
        };
        store.updateSource(orderId, updated_source);
        updated.push(orderId);
      }
    }

    return { created, updated, adjustments };
  }

  return {
    parseExcel,
    importCustomers,
    importStoreCodes,
    importAdjustments,
    createOrdersFromImport,
  };
}

module.exports = createImporter;
