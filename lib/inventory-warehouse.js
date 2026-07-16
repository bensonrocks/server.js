'use strict';

/**
 * Multi-Warehouse Inventory Manager
 * Handles batch/lot tracking, FIFO picking, expiry enforcement, allocation
 */
module.exports = function createInventoryWarehouse(db) {

  // Receive goods into warehouse batch
  const receiveGoods = (data) => {
    const {
      warehouseId,
      skuId,
      batchNumber,
      serialNumber = null,
      expiryDate = null,
      quantity,
      location = 'receiving',
      poId = null,
      notes = ''
    } = data;

    if (!warehouseId || !skuId || !batchNumber || !quantity) {
      throw new Error('warehouseId, skuId, batchNumber, quantity required');
    }

    const now = new Date().toISOString();
    const batchId = require('crypto').randomUUID();

    try {
      // Create batch record
      db.prepare(`
        INSERT INTO inventory_batches (
          id, warehouse_id, sku_id, batch_number, serial_number, expiry_date,
          received_qty, available_qty, received_at, location_bin, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        warehouseId,
        skuId,
        batchNumber,
        serialNumber,
        expiryDate,
        quantity,
        quantity,  // Initially all available
        now,
        location,
        notes,
        now,
        now
      );

      // Log movement
      logMovement({
        warehouseId,
        batchId,
        skuId,
        movementType: 'received',
        quantity,
        fromLocation: 'supplier',
        toLocation: location,
        referenceId: poId,
        reason: `Received batch ${batchNumber}`,
      });

      return {
        batchId,
        batchNumber,
        quantity,
        location,
        expiryDate,
        receivedAt: now,
      };
    } catch (err) {
      throw new Error(`Failed to receive goods: ${err.message}`);
    }
  };

  // Check warehouse availability for SKU
  const checkWarehouseAvailability = (warehouseId, skuId, requiredQty) => {
    const batches = db.prepare(`
      SELECT * FROM inventory_batches
      WHERE warehouse_id = ? AND sku_id = ?
      ORDER BY received_at ASC
    `).all(warehouseId, skuId);

    if (!batches.length) {
      return {
        available: false,
        totalAvailable: 0,
        requiredQty,
        oldestBatch: null,
        expiryDaysRemaining: null,
      };
    }

    const totalAvailable = batches.reduce((s, b) => s + b.available_qty, 0);
    const oldestBatch = batches[0];

    // Calculate days until expiry
    let expiryDaysRemaining = null;
    if (oldestBatch.expiry_date) {
      const today = new Date();
      const expiry = new Date(oldestBatch.expiry_date);
      expiryDaysRemaining = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
    }

    return {
      available: totalAvailable >= requiredQty,
      totalAvailable,
      requiredQty,
      oldestBatch: {
        batchId: oldestBatch.id,
        batchNumber: oldestBatch.batch_number,
        available: oldestBatch.available_qty,
        expiryDate: oldestBatch.expiry_date,
      },
      expiryDaysRemaining,
      batches: batches.map(b => ({
        batchId: b.id,
        batchNumber: b.batch_number,
        available: b.available_qty,
        expiry: b.expiry_date,
      })),
    };
  };

  // Get FIFO batch for picking (oldest non-expired)
  const getNextBatchForPicking = (warehouseId, skuId) => {
    const today = new Date().toISOString().split('T')[0];

    const batch = db.prepare(`
      SELECT * FROM inventory_batches
      WHERE warehouse_id = ?
        AND sku_id = ?
        AND available_qty > 0
        AND (expiry_date IS NULL OR expiry_date >= ?)
      ORDER BY received_at ASC
      LIMIT 1
    `).get(warehouseId, skuId, today);

    if (!batch) {
      return null;
    }

    return {
      batchId: batch.id,
      batchNumber: batch.batch_number,
      serialNumber: batch.serial_number,
      expiryDate: batch.expiry_date,
      availableQty: batch.available_qty,
      location: batch.location_bin,
      receivedAt: batch.received_at,
    };
  };

  // Allocate inventory to warehouse for picking
  const allocateForPicking = (batchId, quantity) => {
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(batchId);
    if (!batch) throw new Error('Batch not found');
    if (batch.available_qty < quantity) {
      throw new Error(`Insufficient available qty: ${batch.available_qty} < ${quantity}`);
    }

    try {
      const newAvailable = batch.available_qty - quantity;
      const newAllocated = batch.allocated_qty + quantity;

      db.prepare(`
        UPDATE inventory_batches
        SET available_qty = ?, allocated_qty = ?, updated_at = ?
        WHERE id = ?
      `).run(newAvailable, newAllocated, new Date().toISOString(), batchId);

      logMovement({
        warehouseId: batch.warehouse_id,
        batchId,
        skuId: batch.sku_id,
        movementType: 'allocated',
        quantity,
        reason: 'Allocated for picking wave',
      });

      return {
        batchId,
        allocated: newAllocated,
        available: newAvailable,
      };
    } catch (err) {
      throw new Error(`Failed to allocate: ${err.message}`);
    }
  };

  // Mark items as picked
  const markAsPicked = (batchId, quantity) => {
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(batchId);
    if (!batch) throw new Error('Batch not found');

    const newAllocated = Math.max(0, batch.allocated_qty - quantity);
    const newPicked = batch.picked_qty + quantity;

    db.prepare(`
      UPDATE inventory_batches
      SET allocated_qty = ?, picked_qty = ?, updated_at = ?
      WHERE id = ?
    `).run(newAllocated, newPicked, new Date().toISOString(), batchId);

    logMovement({
      warehouseId: batch.warehouse_id,
      batchId,
      skuId: batch.sku_id,
      movementType: 'picked',
      quantity,
      reason: 'Picked for carton',
    });

    return { batchId, picked: newPicked };
  };

  // Move inventory between locations
  const moveInventory = (batchId, toLocation, reason = '') => {
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(batchId);
    if (!batch) throw new Error('Batch not found');

    try {
      db.prepare(`
        UPDATE inventory_batches
        SET location_bin = ?, updated_at = ?
        WHERE id = ?
      `).run(toLocation, new Date().toISOString(), batchId);

      logMovement({
        warehouseId: batch.warehouse_id,
        batchId,
        skuId: batch.sku_id,
        movementType: 'moved',
        quantity: 0,
        fromLocation: batch.location_bin,
        toLocation,
        reason,
      });

      return { batchId, newLocation: toLocation };
    } catch (err) {
      throw new Error(`Failed to move inventory: ${err.message}`);
    }
  };

  // Adjust batch quantity (damage, scrap, cycle count)
  const adjustBatchQuantity = (batchId, adjustmentQty, reason = '', targetQty = 'available') => {
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(batchId);
    if (!batch) throw new Error('Batch not found');

    try {
      let updateFields = '';
      let newValue = 0;

      if (targetQty === 'available') {
        newValue = Math.max(0, batch.available_qty + adjustmentQty);
        updateFields = `available_qty = ${newValue}`;
      } else if (targetQty === 'damaged') {
        newValue = Math.max(0, batch.damaged_qty + adjustmentQty);
        updateFields = `damaged_qty = ${newValue}`;
      } else if (targetQty === 'scrap') {
        newValue = Math.max(0, batch.scrap_qty + adjustmentQty);
        updateFields = `scrap_qty = ${newValue}`;
      }

      db.prepare(`
        UPDATE inventory_batches
        SET ${updateFields}, updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), batchId);

      logMovement({
        warehouseId: batch.warehouse_id,
        batchId,
        skuId: batch.sku_id,
        movementType: targetQty === 'available' ? 'adjusted' : targetQty,
        quantity: Math.abs(adjustmentQty),
        reason,
      });

      return { batchId, adjustment: adjustmentQty, newValue };
    } catch (err) {
      throw new Error(`Failed to adjust quantity: ${err.message}`);
    }
  };

  // Get warehouse inventory statistics
  const getWarehouseStats = (warehouseId) => {
    const batches = db.prepare(`
      SELECT * FROM inventory_batches WHERE warehouse_id = ?
    `).all(warehouseId);

    const today = new Date().toISOString().split('T')[0];

    const stats = {
      warehouse_id: warehouseId,
      total_skus: new Set(batches.map(b => b.sku_id)).size,
      total_units: 0,
      available_units: 0,
      allocated_units: 0,
      picked_units: 0,
      damaged_units: 0,
      scrap_units: 0,
      low_stock_batches: 0,
      expiring_soon: 0,  // < 30 days
      expired: 0,
      by_batch: [],
    };

    batches.forEach(b => {
      stats.total_units += b.received_qty;
      stats.available_units += b.available_qty;
      stats.allocated_units += b.allocated_qty;
      stats.picked_units += b.picked_qty;
      stats.damaged_units += b.damaged_qty;
      stats.scrap_units += b.scrap_qty;

      if (b.available_qty <= 10) stats.low_stock_batches++;

      if (b.expiry_date) {
        const daysUntilExpiry = Math.floor((new Date(b.expiry_date) - new Date(today)) / (1000 * 60 * 60 * 24));
        if (daysUntilExpiry < 0) {
          stats.expired++;
        } else if (daysUntilExpiry <= 30) {
          stats.expiring_soon++;
        }
      }

      stats.by_batch.push({
        batchId: b.id,
        batchNumber: b.batch_number,
        sku: b.sku_id,
        received: b.received_qty,
        available: b.available_qty,
        expiry: b.expiry_date,
        location: b.location_bin,
      });
    });

    return stats;
  };

  // Get batch audit trail
  const getBatchAudit = (batchId) => {
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(batchId);
    if (!batch) throw new Error('Batch not found');

    const movements = db.prepare(`
      SELECT * FROM inventory_movements
      WHERE batch_id = ?
      ORDER BY created_at DESC
    `).all(batchId);

    return {
      batch: {
        batchId: batch.id,
        batchNumber: batch.batch_number,
        sku: batch.sku_id,
        warehouse: batch.warehouse_id,
        expiry: batch.expiry_date,
        received: batch.received_qty,
        receivedAt: batch.received_at,
      },
      movements: movements.map(m => ({
        type: m.movement_type,
        quantity: m.quantity,
        reason: m.reason,
        timestamp: m.created_at,
        reference: m.reference_id,
      })),
    };
  };

  // Helper: Log inventory movement
  const logMovement = (data) => {
    const {
      warehouseId,
      batchId = null,
      skuId,
      movementType,
      quantity,
      fromLocation = null,
      toLocation = null,
      referenceId = null,
      orderId = null,
      waveId = null,
      cartonId = null,
      customsLotId = null,
      reason = '',
    } = data;

    const movementId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO inventory_movements (
        id, warehouse_id, batch_id, sku_id, movement_type, quantity,
        from_location, to_location, reference_id, order_id, wave_id, carton_id,
        customs_lot_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      movementId,
      warehouseId,
      batchId,
      skuId,
      movementType,
      quantity,
      fromLocation,
      toLocation,
      referenceId,
      orderId,
      waveId,
      cartonId,
      customsLotId,
      reason,
      now
    );

    return movementId;
  };

  return {
    receiveGoods,
    checkWarehouseAvailability,
    getNextBatchForPicking,
    allocateForPicking,
    markAsPicked,
    moveInventory,
    adjustBatchQuantity,
    getWarehouseStats,
    getBatchAudit,
    logMovement,
  };
};
