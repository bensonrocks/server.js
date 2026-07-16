'use strict';

/**
 * Enhanced Returns Management Module
 * Complete return-to-vendor (RTV) and customer returns workflow
 * with RMA generation, condition assessment, disposition logic, and analytics
 */

module.exports = function createEnhancedReturns(db, inventoryWarehouse) {

  /**
   * Create Return Merchandise Authorization (RMA)
   * Returns from customers
   */
  const createCustomerReturn = (options = {}) => {
    const {
      orderId,
      items = [],  // {sku, qty, condition, reason}
      returnReason = 'defective',  // defective, damaged, wrong_item, no_longer_needed
      notes = '',
      customerName = '',
      requestedAction = 'refund'  // refund, replacement, store_credit
    } = options;

    if (!orderId || !items.length) {
      throw new Error('orderId and items required');
    }

    const rmaId = generateRMANumber(db);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO returns (
        id, rma_number, order_id, type, status, return_reason,
        customer_name, requested_action, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      require('crypto').randomUUID(),
      rmaId,
      orderId,
      'customer_return',
      'pending_inspection',
      returnReason,
      customerName,
      requestedAction,
      notes,
      now,
      now
    );

    const returnRecord = db.prepare(`
      SELECT id FROM returns WHERE rma_number = ?
    `).get(rmaId);

    // Add return items
    for (const item of items) {
      db.prepare(`
        INSERT INTO return_items (
          return_id, sku_id, return_qty, condition, reason, added_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        returnRecord.id,
        item.sku,
        item.qty,
        item.condition || 'unknown',
        item.reason || returnReason,
        now
      );
    }

    return {
      rmaNumber: rmaId,
      orderId,
      status: 'pending_inspection',
      itemCount: items.length,
      createdAt: now
    };
  };

  /**
   * Create Return to Vendor (RTV)
   * For returning items to suppliers/vendors
   */
  const createReturnToVendor = (options = {}) => {
    const {
      vendorName,
      poNumber,
      items = [],  // {sku, batchId, qty, reason}
      reason = 'defective_at_receipt',  // defective_at_receipt, overstock, damaged_in_warehouse
      notes = '',
      targetReturnDate = null
    } = options;

    if (!vendorName || !items.length) {
      throw new Error('vendorName and items required');
    }

    const rtvId = generateRTVNumber(db);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO returns (
        id, rma_number, type, status, vendor_name, po_number,
        return_reason, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      require('crypto').randomUUID(),
      rtvId,
      'return_to_vendor',
      'pending_shipment',
      vendorName,
      poNumber || null,
      reason,
      notes,
      now,
      now
    );

    const returnRecord = db.prepare(`
      SELECT id FROM returns WHERE rma_number = ?
    `).get(rtvId);

    // Add return items
    for (const item of items) {
      db.prepare(`
        INSERT INTO return_items (
          return_id, sku_id, batch_id, return_qty, reason, added_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        returnRecord.id,
        item.sku,
        item.batchId || null,
        item.qty,
        item.reason || reason,
        now
      );
    }

    return {
      rtvNumber: rtvId,
      vendorName,
      status: 'pending_shipment',
      itemCount: items.length,
      createdAt: now
    };
  };

  /**
   * Inspect return item
   * Detailed condition assessment and disposition decision
   */
  const inspectReturnItem = (returnItemId, inspection) => {
    const {
      finalCondition = 'unknown',  // new, like_new, good, damaged, defective, unsaleable
      disposition = 'restock',      // restock, refurbish, scrap, donate, return_to_vendor
      notes = '',
      inspectorName = ''
    } = inspection;

    const item = db.prepare(`
      SELECT * FROM return_items WHERE id = ?
    `).get(returnItemId);

    if (!item) throw new Error('Return item not found');

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE return_items
      SET final_condition = ?, disposition = ?, inspection_notes = ?,
          inspector_name = ?, inspected_at = ?
      WHERE id = ?
    `).run(
      finalCondition,
      disposition,
      notes,
      inspectorName,
      now,
      returnItemId
    );

    return {
      returnItemId,
      finalCondition,
      disposition,
      inspectedAt: now
    };
  };

  /**
   * Process return disposition
   * Execute the decided disposition (restock, refund, etc.)
   */
  const processDisposition = (returnId, itemId, disposition, options = {}) => {
    const {
      warehouseId = 'wh-main',
      locationBin = 'QC-01',  // Default QC holding location
      batchNumber = null,
      refundAmount = null,
      creditMemoNumber = null
    } = options;

    const item = db.prepare(`
      SELECT * FROM return_items WHERE id = ?
    `).get(itemId);

    if (!item) throw new Error('Item not found');

    const now = new Date().toISOString();
    const movements = [];

    switch (disposition) {
      case 'restock':
        // Add back to inventory
        const batchId = require('crypto').randomUUID();
        db.prepare(`
          INSERT INTO inventory_batches (
            id, warehouse_id, sku_id, batch_number, received_qty,
            available_qty, allocated_qty, picked_qty, damaged_qty, scrap_qty,
            received_at, location_bin
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          batchId,
          warehouseId,
          item.sku_id,
          batchNumber || `RESTOCK-${now.split('T')[0]}`,
          item.return_qty,
          item.return_qty,
          0, 0, 0, 0,
          now,
          locationBin
        );

        db.prepare(`
          INSERT INTO inventory_movements (
            sku_id, warehouse_id, movement_type, quantity, batch_id,
            return_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.sku_id,
          warehouseId,
          'return_restock',
          item.return_qty,
          batchId,
          returnId,
          now
        );

        movements.push({ type: 'restock', quantity: item.return_qty, location: locationBin });
        break;

      case 'refund':
        // Create credit memo/refund record
        const memoId = creditMemoNumber || generateCreditMemoNumber(db);
        db.prepare(`
          INSERT INTO credit_memos (
            id, return_id, memo_number, sku_id, quantity,
            unit_cost, total_amount, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          require('crypto').randomUUID(),
          returnId,
          memoId,
          item.sku_id,
          item.return_qty,
          refundAmount || 0,
          (refundAmount || 0) * item.return_qty,
          now
        );

        movements.push({ type: 'refund', quantity: item.return_qty, memoNumber: memoId });
        break;

      case 'scrap':
        // Log as scrap/disposal
        db.prepare(`
          INSERT INTO inventory_movements (
            sku_id, warehouse_id, movement_type, quantity, return_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          item.sku_id,
          warehouseId,
          'disposal',
          item.return_qty,
          returnId,
          now
        );

        movements.push({ type: 'scrap', quantity: item.return_qty });
        break;

      case 'return_to_vendor':
        // Flag for vendor return shipment
        db.prepare(`
          UPDATE return_items SET rtv_pending = 1 WHERE id = ?
        `).run(itemId);

        movements.push({ type: 'return_to_vendor', quantity: item.return_qty });
        break;
    }

    // Mark as processed
    db.prepare(`
      UPDATE return_items SET disposition_processed_at = ? WHERE id = ?
    `).run(now, itemId);

    return {
      returnItemId: itemId,
      disposition,
      movements,
      processedAt: now
    };
  };

  /**
   * Generate credit memo for refund
   */
  const generateCreditMemo = (returnId) => {
    const returnRecord = db.prepare(`
      SELECT * FROM returns WHERE id = ?
    `).get(returnId);

    if (!returnRecord) throw new Error('Return not found');

    const items = db.prepare(`
      SELECT * FROM return_items WHERE return_id = ?
    `).all(returnId);

    const memoId = generateCreditMemoNumber(db);
    const totalAmount = items.reduce((sum, item) => sum + (item.return_qty * (item.unit_cost || 0)), 0);

    return {
      creditMemoNumber: memoId,
      returnId,
      orderId: returnRecord.order_id,
      customerId: returnRecord.customer_name,
      items: items.map(i => ({
        sku: i.sku_id,
        quantity: i.return_qty,
        unitCost: i.unit_cost || 0
      })),
      totalAmount,
      generatedAt: new Date().toISOString()
    };
  };

  /**
   * Complete return processing
   */
  const completeReturn = (returnId, completionNotes = '') => {
    const returnRecord = db.prepare(`
      SELECT * FROM returns WHERE id = ?
    `).get(returnId);

    if (!returnRecord) throw new Error('Return not found');

    // Check all items processed
    const unprocessed = db.prepare(`
      SELECT COUNT(*) as count FROM return_items
      WHERE return_id = ? AND disposition_processed_at IS NULL
    `).get(returnId);

    if (unprocessed.count > 0) {
      throw new Error(`Cannot complete: ${unprocessed.count} items not yet processed`);
    }

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE returns
      SET status = 'completed', completed_at = ?, completion_notes = ?
      WHERE id = ?
    `).run(now, completionNotes, returnId);

    return {
      returnId,
      rmaNumber: returnRecord.rma_number,
      status: 'completed',
      completedAt: now
    };
  };

  /**
   * Get return analytics
   */
  const getReturnAnalytics = (warehouseId = 'wh-main', days = 30) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    // Return rate by reason
    const byReason = db.prepare(`
      SELECT return_reason, COUNT(*) as count, SUM(
        (SELECT SUM(return_qty) FROM return_items WHERE return_id = returns.id)
      ) as total_qty
      FROM returns
      WHERE created_at >= ? AND type = 'customer_return'
      GROUP BY return_reason
      ORDER BY count DESC
    `).all(cutoffDate.toISOString());

    // Disposition summary
    const byDisposition = db.prepare(`
      SELECT disposition, COUNT(*) as count, SUM(return_qty) as total_qty
      FROM return_items
      WHERE inspected_at >= ?
      GROUP BY disposition
      ORDER BY count DESC
    `).all(cutoffDate.toISOString());

    // RTV analysis
    const rtvPending = db.prepare(`
      SELECT vendor_name, COUNT(*) as count, SUM(
        (SELECT SUM(return_qty) FROM return_items WHERE return_id = returns.id)
      ) as total_qty
      FROM returns
      WHERE type = 'return_to_vendor' AND status IN ('pending_shipment', 'shipped')
      AND created_at >= ?
      GROUP BY vendor_name
    `).all(cutoffDate.toISOString());

    return {
      period: { days, from: cutoffDate, to: new Date() },
      returnsByReason: byReason,
      dispositionSummary: byDisposition,
      returnToVendorByVendor: rtvPending,
      totalReturns: byReason.reduce((sum, r) => sum + r.count, 0)
    };
  };

  /**
   * Get high-return SKUs (quality indicators)
   */
  const getHighReturnSKUs = (threshold = 5, days = 90) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const results = db.prepare(`
      SELECT sku_id, COUNT(*) as return_count, SUM(return_qty) as total_qty,
             GROUP_CONCAT(DISTINCT return_reason) as reasons
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      WHERE r.created_at >= ? AND r.type = 'customer_return'
      GROUP BY sku_id
      HAVING COUNT(*) >= ?
      ORDER BY COUNT(*) DESC
    `).all(cutoffDate.toISOString(), threshold);

    return {
      period: { days, from: cutoffDate, to: new Date() },
      threshold,
      highReturnSkus: results
    };
  };

  // Helpers
  function generateRMANumber(db) {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const seq = (db.rmaSeq = (db.rmaSeq || 0) + 1);
    return `RMA-${today}-${String(seq).padStart(4, '0')}`;
  }

  function generateRTVNumber(db) {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const seq = (db.rtvSeq = (db.rtvSeq || 0) + 1);
    return `RTV-${today}-${String(seq).padStart(4, '0')}`;
  }

  function generateCreditMemoNumber(db) {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const seq = (db.creditMemoSeq = (db.creditMemoSeq || 0) + 1);
    return `CM-${today}-${String(seq).padStart(4, '0')}`;
  }

  return {
    createCustomerReturn,
    createReturnToVendor,
    inspectReturnItem,
    processDisposition,
    generateCreditMemo,
    completeReturn,
    getReturnAnalytics,
    getHighReturnSKUs
  };
};
