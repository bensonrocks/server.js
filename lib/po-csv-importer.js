'use strict';

/**
 * PO CSV Importer
 * Handles CSV upload parsing and conversion to PO documents
 * Expected CSV format: po_number, po_date, client_id, client_name, sku, qty, destination_store, serial_number, batch_number, expiry_date, length_cm, width_cm, height_cm, weight_kg
 */
module.exports = function createPOCSVImporter(db) {

  const parseCSV = (csvText) => {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) throw new Error('CSV must have header + at least 1 row');

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      if (values.every(v => !v)) continue; // Skip empty rows

      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx] || '';
      });
      rows.push(row);
    }

    return { headers, rows };
  };

  const groupByPO = (rows) => {
    const poGroups = {};

    rows.forEach(row => {
      const poNumber = row.po_number || row.PO_Number;
      if (!poNumber) throw new Error('Missing po_number in row');

      if (!poGroups[poNumber]) {
        poGroups[poNumber] = {
          po_number: poNumber,
          po_date: row.po_date || row.PO_Date || new Date().toISOString().split('T')[0],
          client_id: row.client_id || row.Client_ID,
          client_name: row.client_name || row.Client_Name || '',
          line_items: [],
        };
      }

      poGroups[poNumber].line_items.push({
        sku: row.sku || row.SKU,
        sku_name: row.sku_name || row.SKU_Name || '',
        qty: parseInt(row.qty || row.Qty) || 0,
        destination_store: row.destination_store || row.Destination_Store || '',
        serial_number: row.serial_number || row.Serial_Number || '',
        batch_number: row.batch_number || row.Batch_Number || '',
        expiry_date: row.expiry_date || row.Expiry_Date || null,
        length_cm: parseFloat(row.length_cm || row.Length_cm) || null,
        width_cm: parseFloat(row.width_cm || row.Width_cm) || null,
        height_cm: parseFloat(row.height_cm || row.Height_cm) || null,
        weight_kg: parseFloat(row.weight_kg || row.Weight_kg) || null,
      });
    });

    return Object.values(poGroups);
  };

  const importPOsFromCSV = (csvText, clientId = null) => {
    try {
      const { rows } = parseCSV(csvText);
      const poGroups = groupByPO(rows);

      const results = {
        total: poGroups.length,
        created: [],
        errors: [],
      };

      const createPOManager = require('./po-manager');
      const poManager = createPOManager(db);

      poGroups.forEach(po => {
        try {
          // Override client_id if provided
          if (clientId) po.client_id = clientId;

          const created = poManager.createPODocument(po);
          results.created.push({
            po_number: po.po_number,
            po_id: created.poId,
            lines: po.line_items.length,
            total_qty: po.line_items.reduce((s, l) => s + (l.qty || 0), 0),
          });
        } catch (err) {
          results.errors.push({
            po_number: po.po_number,
            error: err.message,
          });
        }
      });

      return results;
    } catch (err) {
      throw new Error(`CSV parsing failed: ${err.message}`);
    }
  };

  const importTemplate = () => {
    return `po_number,po_date,client_id,client_name,sku,qty,destination_store,serial_number,batch_number,expiry_date,length_cm,width_cm,height_cm,weight_kg
PO-2026-001,2026-07-16,betime-marketing,Betime Marketing,SKU-001,100,Store A,SN-001-100,BATCH-XYZ,2027-07-16,30,20,15,2.5
PO-2026-001,2026-07-16,betime-marketing,Betime Marketing,SKU-002,50,Store B,SN-002-050,BATCH-XYZ,2027-07-16,25,20,15,2.0`;
  };

  return {
    parseCSV,
    groupByPO,
    importPOsFromCSV,
    importTemplate,
  };
};
