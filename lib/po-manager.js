'use strict';

/**
 * PO (Purchase Order) Manager
 * Handles B2B inbound document processing, validation, and line item parsing
 */
module.exports = function createPOManager(db) {

  const createPODocument = (poData) => {
    const {
      po_number,
      po_date,
      client_id,
      client_name,
      line_items,  // array of { sku, qty, destination_store, serial_number, batch_number, expiry_date, length_cm, width_cm, height_cm, weight_kg }
    } = poData;

    if (!po_number || !client_id) {
      throw new Error('PO number and client_id required');
    }

    const poId = require('crypto').randomUUID();
    const now = new Date().toISOString();
    const totalLines = line_items ? line_items.length : 0;
    const totalQty = line_items ? line_items.reduce((s, l) => s + (l.qty || 0), 0) : 0;

    try {
      db.prepare(`
        INSERT INTO po_documents (id, po_number, po_date, client_id, client_name, total_lines, total_qty, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
      `).run(poId, po_number, po_date, client_id, client_name, totalLines, totalQty, now, now);

      // Add line items
      if (line_items && line_items.length > 0) {
        const insertLineItem = db.prepare(`
          INSERT INTO po_line_items (id, po_id, sku_code, sku_name, qty, destination_store, serial_number, batch_number, expiry_date, length_cm, width_cm, height_cm, weight_kg, line_number, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        line_items.forEach((item, idx) => {
          const lineId = require('crypto').randomUUID();
          insertLineItem.run(
            lineId,
            poId,
            item.sku,
            item.sku_name || '',
            item.qty || 0,
            item.destination_store || '',
            item.serial_number || '',
            item.batch_number || '',
            item.expiry_date || null,
            item.length_cm || null,
            item.width_cm || null,
            item.height_cm || null,
            item.weight_kg || null,
            idx + 1,
            now
          );
        });
      }

      return {
        poId,
        po_number,
        status: 'received',
        totalLines,
        totalQty,
        createdAt: now,
      };
    } catch (err) {
      throw new Error(`Failed to create PO: ${err.message}`);
    }
  };

  const validatePODocument = (poId) => {
    const po = db.prepare('SELECT * FROM po_documents WHERE id = ?').get(poId);
    if (!po) throw new Error('PO not found');

    const errors = [];
    const warnings = [];

    // Get line items
    const lineItems = db.prepare(`
      SELECT * FROM po_line_items WHERE po_id = ? ORDER BY line_number
    `).all(poId);

    // Validate each line item
    lineItems.forEach((item, idx) => {
      const lineNum = idx + 1;

      // Check if SKU exists
      const sku = db.prepare('SELECT * FROM skus WHERE code = ?').get(item.sku_code);
      if (!sku) {
        errors.push({
          line: lineNum,
          field: 'sku_code',
          issue: 'SKU_NOT_FOUND',
          value: item.sku_code,
          action: 'Add SKU to inventory first',
        });
      }

      // Validate quantity
      if (!item.qty || item.qty <= 0) {
        errors.push({
          line: lineNum,
          field: 'qty',
          issue: 'INVALID_QUANTITY',
          value: item.qty,
          action: 'Quantity must be > 0',
        });
      }

      // Check destination store
      if (!item.destination_store) {
        warnings.push({
          line: lineNum,
          field: 'destination_store',
          issue: 'MISSING_DESTINATION',
          action: 'Specify where items should go',
        });
      }

      // Validate dimensions if present
      if ((item.length_cm || item.width_cm || item.height_cm) && !(item.length_cm && item.width_cm && item.height_cm)) {
        warnings.push({
          line: lineNum,
          field: 'dimensions',
          issue: 'PARTIAL_DIMENSIONS',
          action: 'Provide all dimensions or none',
        });
      }

      // Check expiry date
      if (item.expiry_date) {
        const expiryDate = new Date(item.expiry_date);
        const today = new Date();
        if (expiryDate < today) {
          errors.push({
            line: lineNum,
            field: 'expiry_date',
            issue: 'EXPIRED_ITEM',
            value: item.expiry_date,
            action: 'Item already expired',
          });
        } else if ((expiryDate - today) / (1000 * 60 * 60 * 24) < 30) {
          warnings.push({
            line: lineNum,
            field: 'expiry_date',
            issue: 'EXPIRY_SOON',
            value: item.expiry_date,
            action: 'Expires within 30 days',
          });
        }
      }
    });

    const validationErrors = errors.length > 0 ? JSON.stringify(errors) : null;
    const validationNotes = warnings.length > 0 ? JSON.stringify(warnings) : null;
    const status = errors.length > 0 ? 'validation_failed' : 'validated';
    const now = new Date().toISOString();

    // Update PO document with validation results
    db.prepare(`
      UPDATE po_documents
      SET status = ?, validation_errors = ?, validation_notes = ?, validated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, validationErrors, validationNotes, errors.length === 0 ? now : null, now, poId);

    return {
      poId,
      valid: errors.length === 0,
      errorCount: errors.length,
      warningCount: warnings.length,
      errors,
      warnings,
    };
  };

  const getPODocument = (poId) => {
    const po = db.prepare('SELECT * FROM po_documents WHERE id = ?').get(poId);
    if (!po) return null;

    const lineItems = db.prepare(`
      SELECT * FROM po_line_items WHERE po_id = ? ORDER BY line_number
    `).all(poId);

    return {
      id: po.id,
      poNumber: po.po_number,
      poDate: po.po_date,
      clientId: po.client_id,
      clientName: po.client_name,
      status: po.status,
      totalLines: po.total_lines,
      totalQty: po.total_qty,
      validatedAt: po.validated_at,
      validationErrors: po.validation_errors ? JSON.parse(po.validation_errors) : [],
      validationNotes: po.validation_notes ? JSON.parse(po.validation_notes) : [],
      lineItems,
      createdAt: po.created_at,
      updatedAt: po.updated_at,
    };
  };

  const listPODocuments = (status = null, clientId = null, limit = 50) => {
    let sql = 'SELECT * FROM po_documents WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (clientId) {
      sql += ' AND client_id = ?';
      params.push(clientId);
    }

    sql += ' ORDER BY po_date DESC LIMIT ?';
    params.push(limit);

    return db.prepare(sql).all(...params);
  };

  const approvePODocument = (poId) => {
    const po = getPODocument(poId);
    if (!po) throw new Error('PO not found');
    if (po.validationErrors.length > 0) throw new Error('Cannot approve PO with validation errors');

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE po_documents
      SET status = 'approved', updated_at = ?
      WHERE id = ?
    `).run(now, poId);

    return { poId, status: 'approved', approvedAt: now };
  };

  const rejectPODocument = (poId, reason) => {
    const po = getPODocument(poId);
    if (!po) throw new Error('PO not found');

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE po_documents
      SET status = 'rejected', validation_notes = ?, updated_at = ?
      WHERE id = ?
    `).run(reason || 'Rejected by user', now, poId);

    return { poId, status: 'rejected', rejectedAt: now };
  };

  return {
    createPODocument,
    validatePODocument,
    getPODocument,
    listPODocuments,
    approvePODocument,
    rejectPODocument,
  };
};
