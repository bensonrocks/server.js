'use strict';

/**
 * Cycle Count Module
 * Manages inventory counts, variance detection, and reconciliation
 * Supports partial counts (by SKU, location, warehouse) or full counts
 */
module.exports = function createCycleCount(db, inventoryWarehouse) {

  // Create a new cycle count batch
  const createCycleCountBatch = (options = {}) => {
    const {
      warehouseId = null,
      countType = 'full',  // 'full', 'sku_based', 'location_based', 'sample'
      skuIds = [],
      locations = [],
      sampleSize = null,
      countedBy = 'staff',
      notes = ''
    } = options;

    if (!warehouseId) throw new Error('Warehouse ID required');

    const batchId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    // Get batches to count based on parameters
    let batchesToCount = [];
    if (countType === 'sku_based' && skuIds.length > 0) {
      batchesToCount = db.prepare(`
        SELECT * FROM inventory_batches
        WHERE warehouse_id = ? AND sku_id IN (${skuIds.map(() => '?').join(',')})
        ORDER BY sku_id, received_at
      `).all(warehouseId, ...skuIds);
    } else if (countType === 'location_based' && locations.length > 0) {
      batchesToCount = db.prepare(`
        SELECT * FROM inventory_batches
        WHERE warehouse_id = ? AND location_bin IN (${locations.map(() => '?').join(',')})
        ORDER BY location_bin, received_at
      `).all(warehouseId, ...locations);
    } else if (countType === 'sample' && sampleSize) {
      batchesToCount = db.prepare(`
        SELECT * FROM inventory_batches
        WHERE warehouse_id = ?
        ORDER BY RANDOM() LIMIT ?
      `).all(warehouseId, sampleSize);
    } else {
      // Full count
      batchesToCount = db.prepare(`
        SELECT * FROM inventory_batches
        WHERE warehouse_id = ?
        ORDER BY location_bin, sku_id, received_at
      `).all(warehouseId);
    }

    try {
      // Insert cycle count batch record
      db.prepare(`
        INSERT INTO cycle_count_batches (
          id, warehouse_id, batch_count, count_type, status,
          counted_by, notes, created_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        warehouseId,
        batchesToCount.length,
        countType,
        'in_progress',
        countedBy,
        notes,
        now,
        now
      );

      // Create count items for each batch
      batchesToCount.forEach((batch, idx) => {
        const itemId = require('crypto').randomUUID();
        db.prepare(`
          INSERT INTO cycle_count_items (
            id, batch_id, batch_id_inventory, sku_id, location_bin,
            expected_qty, counted_qty, variance_qty, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          itemId,
          batchId,
          batch.id,
          batch.sku_id,
          batch.location_bin,
          batch.available_qty,
          null,  // Will be filled during counting
          null,
          'pending',
          now
        );
      });

      return {
        batchId,
        warehouseId,
        countType,
        totalItems: batchesToCount.length,
        status: 'in_progress',
        createdAt: now
      };
    } catch (err) {
      throw new Error(`Failed to create cycle count batch: ${err.message}`);
    }
  };

  // Record count for a specific batch/location
  const recordCount = (countItemId, countedQty, notes = '') => {
    const countItem = db.prepare(`
      SELECT * FROM cycle_count_items WHERE id = ?
    `).get(countItemId);

    if (!countItem) throw new Error('Count item not found');

    const variance = countedQty - countItem.expected_qty;
    const now = new Date().toISOString();

    try {
      db.prepare(`
        UPDATE cycle_count_items
        SET counted_qty = ?, variance_qty = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(countedQty, variance, 'counted', now, countItemId);

      // Log variance if any
      if (variance !== 0) {
        const logId = require('crypto').randomUUID();
        db.prepare(`
          INSERT INTO cycle_count_variances (
            id, count_item_id, sku_id, location_bin,
            expected_qty, counted_qty, variance_qty,
            variance_pct, notes, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          logId,
          countItemId,
          countItem.sku_id,
          countItem.location_bin,
          countItem.expected_qty,
          countedQty,
          variance,
          Math.round((variance / Math.max(countItem.expected_qty, 1)) * 100),
          notes,
          'pending_investigation',
          now
        );
      }

      return {
        countItemId,
        countedQty,
        expectedQty: countItem.expected_qty,
        variance,
        status: 'counted'
      };
    } catch (err) {
      throw new Error(`Failed to record count: ${err.message}`);
    }
  };

  // Get count batch progress
  const getCountBatchProgress = (batchId) => {
    const batch = db.prepare(`
      SELECT * FROM cycle_count_batches WHERE id = ?
    `).get(batchId);

    if (!batch) throw new Error('Batch not found');

    const items = db.prepare(`
      SELECT * FROM cycle_count_items WHERE batch_id = ?
    `).all(batchId);

    const counted = items.filter(i => i.counted_qty !== null).length;
    const pending = items.filter(i => i.counted_qty === null).length;
    const variances = items.filter(i => i.variance_qty !== 0 && i.variance_qty !== null).length;

    const totalVariance = items.reduce((sum, i) => sum + (i.variance_qty || 0), 0);
    const avgVarianceQty = variances > 0 ? Math.round(totalVariance / variances) : 0;
    const accuracyRate = items.length > 0 ? Math.round(((items.length - variances) / items.length) * 100) : 0;

    return {
      batchId,
      countType: batch.count_type,
      totalItems: batch.batch_count,
      countedItems: counted,
      pendingItems: pending,
      percentComplete: Math.round((counted / batch.batch_count) * 100),
      variances,
      accuracyRate,
      totalVariance,
      avgVarianceQty,
      status: batch.status,
      createdAt: batch.created_at,
      items: items.map(i => ({
        id: i.id,
        skuId: i.sku_id,
        location: i.location_bin,
        expectedQty: i.expected_qty,
        countedQty: i.counted_qty,
        variance: i.variance_qty,
        status: i.status
      }))
    };
  };

  // Finalize cycle count batch
  const finalizeCycleCountBatch = (batchId, approverName = '') => {
    const batch = db.prepare(`
      SELECT * FROM cycle_count_batches WHERE id = ?
    `).get(batchId);

    if (!batch) throw new Error('Batch not found');

    const items = db.prepare(`
      SELECT * FROM cycle_count_items WHERE batch_id = ?
    `).all(batchId);

    const pending = items.filter(i => i.counted_qty === null);
    if (pending.length > 0) {
      throw new Error(`${pending.length} items not counted yet`);
    }

    const variances = items.filter(i => i.variance_qty !== 0);
    const now = new Date().toISOString();

    try {
      // Update batch status
      db.prepare(`
        UPDATE cycle_count_batches
        SET status = 'completed', completed_at = ?, approved_by = ?
        WHERE id = ?
      `).run(now, approverName, batchId);

      // Update inventory for items with variances
      variances.forEach(item => {
        const variance = item.variance_qty;
        const batch_id_inv = db.prepare(`
          SELECT id FROM inventory_batches WHERE id = ?
        `).get(item.batch_id_inventory);

        if (batch_id_inv && variance !== 0) {
          // Log movement
          const movementId = require('crypto').randomUUID();
          db.prepare(`
            INSERT INTO inventory_movements (
              id, warehouse_id, batch_id, sku_id, movement_type,
              quantity, reason, reference_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            movementId,
            batch.warehouse_id,
            item.batch_id_inventory,
            item.sku_id,
            variance > 0 ? 'cycle_count_gain' : 'cycle_count_loss',
            Math.abs(variance),
            'Cycle count adjustment',
            batchId,
            now
          );

          // Update available qty in batch
          db.prepare(`
            UPDATE inventory_batches
            SET available_qty = available_qty + ?
            WHERE id = ?
          `).run(variance, item.batch_id_inventory);
        }
      });

      return {
        batchId,
        status: 'completed',
        totalItems: items.length,
        variances: variances.length,
        varianceRate: Math.round((variances.length / items.length) * 100),
        completedAt: now
      };
    } catch (err) {
      throw new Error(`Failed to finalize batch: ${err.message}`);
    }
  };

  // Get variance investigation
  const getVarianceInvestigation = (varianceId) => {
    const variance = db.prepare(`
      SELECT * FROM cycle_count_variances WHERE id = ?
    `).get(varianceId);

    if (!variance) throw new Error('Variance not found');

    const countItem = db.prepare(`
      SELECT * FROM cycle_count_items WHERE id = ?
    `).get(variance.count_item_id);

    const batch = db.prepare(`
      SELECT * FROM cycle_count_batches WHERE id = ?
    `).get(countItem.batch_id);

    // Get related inventory movements
    const movements = db.prepare(`
      SELECT * FROM inventory_movements
      WHERE sku_id = ? AND batch_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(variance.sku_id, countItem.batch_id_inventory);

    return {
      varianceId,
      sku: variance.sku_id,
      location: variance.location_bin,
      expectedQty: variance.expected_qty,
      countedQty: variance.counted_qty,
      variance: variance.variance_qty,
      variancePct: variance.variance_pct,
      notes: variance.notes,
      status: variance.status,
      batchId: batch.id,
      warehouseId: batch.warehouse_id,
      countedBy: batch.counted_by,
      countDate: batch.created_at,
      recentMovements: movements.map(m => ({
        type: m.movement_type,
        quantity: m.quantity,
        reason: m.reason,
        timestamp: m.created_at
      }))
    };
  };

  // Resolve variance
  const resolveVariance = (varianceId, resolution = 'accept', notes = '') => {
    const variance = db.prepare(`
      SELECT * FROM cycle_count_variances WHERE id = ?
    `).get(varianceId);

    if (!variance) throw new Error('Variance not found');

    const now = new Date().toISOString();

    try {
      if (resolution === 'reject') {
        // Revert the inventory adjustment
        const movementId = require('crypto').randomUUID();
        const countItem = db.prepare(`
          SELECT batch_id_inventory FROM cycle_count_items WHERE id = ?
        `).get(variance.count_item_id);

        db.prepare(`
          INSERT INTO inventory_movements (
            id, batch_id, sku_id, movement_type, quantity,
            reason, reference_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          movementId,
          countItem.batch_id_inventory,
          variance.sku_id,
          'variance_reversal',
          Math.abs(variance.variance_qty),
          notes || 'Variance rejected during investigation',
          varianceId,
          now
        );

        // Revert the batch qty
        db.prepare(`
          UPDATE inventory_batches
          SET available_qty = available_qty - ?
          WHERE id = ?
        `).run(variance.variance_qty, countItem.batch_id_inventory);
      }

      db.prepare(`
        UPDATE cycle_count_variances
        SET status = ?, resolved_at = ?, resolution_notes = ?
        WHERE id = ?
      `).run(
        resolution === 'accept' ? 'accepted' : 'rejected',
        now,
        notes,
        varianceId
      );

      return {
        varianceId,
        resolution,
        status: resolution === 'accept' ? 'accepted' : 'rejected',
        resolvedAt: now
      };
    } catch (err) {
      throw new Error(`Failed to resolve variance: ${err.message}`);
    }
  };

  // List pending variances
  const getPendingVariances = (warehouseId = null) => {
    let sql = `
      SELECT cv.*, ccb.warehouse_id, ccb.counted_by
      FROM cycle_count_variances cv
      JOIN cycle_count_items cci ON cv.count_item_id = cci.id
      JOIN cycle_count_batches ccb ON cci.batch_id = ccb.id
      WHERE cv.status = 'pending_investigation'
    `;
    const params = [];

    if (warehouseId) {
      sql += ` AND ccb.warehouse_id = ?`;
      params.push(warehouseId);
    }

    sql += ` ORDER BY cv.variance_qty DESC, cv.created_at DESC`;

    const variances = db.prepare(sql).all(...params);

    return variances.map(v => ({
      varianceId: v.id,
      skuId: v.sku_id,
      location: v.location_bin,
      expectedQty: v.expected_qty,
      countedQty: v.counted_qty,
      variance: v.variance_qty,
      variancePct: v.variance_pct,
      warehouseId: v.warehouse_id,
      countedBy: v.counted_by,
      createdAt: v.created_at
    }));
  };

  // Get cycle count history for SKU
  const getSkuCountHistory = (skuId, limit = 20) => {
    const counts = db.prepare(`
      SELECT cci.*, ccb.warehouse_id, ccb.count_type, ccb.counted_by, ccb.created_at
      FROM cycle_count_items cci
      JOIN cycle_count_batches ccb ON cci.batch_id = ccb.id
      WHERE cci.sku_id = ? AND cci.counted_qty IS NOT NULL
      ORDER BY cci.updated_at DESC
      LIMIT ?
    `).all(skuId, limit);

    return counts.map(c => ({
      batchId: c.batch_id,
      warehouseId: c.warehouse_id,
      countType: c.count_type,
      expectedQty: c.expected_qty,
      countedQty: c.counted_qty,
      variance: c.variance_qty,
      location: c.location_bin,
      countedBy: c.counted_by,
      countedAt: c.updated_at
    }));
  };

  return {
    createCycleCountBatch,
    recordCount,
    getCountBatchProgress,
    finalizeCycleCountBatch,
    getVarianceInvestigation,
    resolveVariance,
    getPendingVariances,
    getSkuCountHistory
  };
};
