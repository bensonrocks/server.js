'use strict';

/**
 * Picking Integration
 * Connects picking waves with inventory batches
 * Enforces FIFO, expiry validation, batch assignment to cartons
 */
module.exports = function createPickingIntegration(db, inventoryWarehouse) {

  // Generate FIFO picking list for wave
  const generatePickingList = (waveId) => {
    const wave = db.prepare('SELECT * FROM picking_waves WHERE id = ?').get(waveId);
    if (!wave) throw new Error('Wave not found');
    if (!wave.warehouse_id) throw new Error('Wave not assigned to warehouse');

    // Get all orders in wave
    const waveOrders = db.prepare(`
      SELECT o.id as order_id, o.id as order_num
      FROM wave_orders wo
      JOIN orders o ON wo.order_id = o.id
      WHERE wo.wave_id = ?
      ORDER BY wo.sequence ASC
    `).all(waveId);

    const pickingList = [];
    const issues = [];

    waveOrders.forEach((wo, orderIdx) => {
      // Get lines for this order
      const lines = db.prepare(`
        SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_number ASC
      `).all(wo.order_id);

      const orderItems = [];

      lines.forEach((line, lineIdx) => {
        // Get FIFO batch for this SKU
        const batch = db.prepare(`
          SELECT * FROM inventory_batches
          WHERE warehouse_id = ? AND sku_id = ?
          AND available_qty > 0
          AND (expiry_date IS NULL OR expiry_date >= date('now'))
          ORDER BY received_at ASC
          LIMIT 1
        `).get(wave.warehouse_id, line.sku_id);

        if (!batch) {
          issues.push({
            order: wo.order_id,
            lineNum: lineIdx + 1,
            sku: line.sku_id,
            issue: 'No available batch',
          });
          return;
        }

        if (batch.available_qty < line.ordered_qty) {
          issues.push({
            order: wo.order_id,
            lineNum: lineIdx + 1,
            sku: line.sku_id,
            issue: `Insufficient qty: ${batch.available_qty} < ${line.ordered_qty}`,
          });
          return;
        }

        // Check expiry
        const expiryWarning = batch.expiry_date ? calculateExpiryDays(batch.expiry_date) : null;

        orderItems.push({
          lineId: line.id,
          sequence: (orderIdx * 1000) + lineIdx,  // For picking sequence
          orderNum: wo.order_id,
          sku: line.sku_id,
          quantity: line.ordered_qty,
          batchId: batch.id,
          batchNumber: batch.batch_number,
          serialNumber: batch.serial_number,
          expiryDate: batch.expiry_date,
          expiryDaysRemaining: expiryWarning?.days,
          expiryWarning: expiryWarning?.warning,
          location: batch.location_bin,
          receivedAt: batch.received_at,
        });
      });

      orderItems.forEach(item => {
        pickingList.push(item);
      });
    });

    // Sort by location for bin optimization
    const sortedList = pickingList.sort((a, b) => {
      // Primary: location (minimize travel)
      if (a.location !== b.location) {
        return a.location.localeCompare(b.location);
      }
      // Secondary: oldest batch (FIFO)
      return new Date(a.receivedAt) - new Date(b.receivedAt);
    });

    return {
      waveId,
      warehouse: wave.warehouse_id,
      totalItems: sortedList.length,
      issues: issues.length,
      pickingList: sortedList.map((item, idx) => ({
        pickSequence: idx + 1,
        ...item,
      })),
      issues,
    };
  };

  // Validate item at picking time (expiry + batch check)
  const validatePickItem = (pickItemData) => {
    const {
      batchId,
      orderedQty,
      expiryDate
    } = pickItemData;

    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(batchId);
    if (!batch) throw new Error('Batch not found');

    const errors = [];
    const warnings = [];

    // Check expiry
    if (expiryDate) {
      const today = new Date();
      const expiry = new Date(expiryDate);

      if (expiry < today) {
        errors.push('Item is expired - cannot pick');
      } else {
        const daysRemaining = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
        if (daysRemaining <= 7) {
          warnings.push(`Item expires in ${daysRemaining} days - flagged for early review`);
        }
      }
    }

    // Check qty available
    if (batch.available_qty < orderedQty) {
      errors.push(`Insufficient qty: ${batch.available_qty} < ${orderedQty}`);
    }

    return {
      valid: errors.length === 0,
      batchId,
      batch: {
        batchNumber: batch.batch_number,
        available: batch.available_qty,
      },
      errors,
      warnings,
    };
  };

  // Mark item as picked (scan)
  const markItemPicked = (lineId, batchId, pickedQty, cartonId = null) => {
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(batchId);
    if (!batch) throw new Error('Batch not found');

    const line = db.prepare('SELECT * FROM order_lines WHERE id = ?').get(lineId);
    if (!line) throw new Error('Line not found');

    // Mark as picked in inventory
    inventoryWarehouse.markAsPicked(batchId, pickedQty);

    // Record carton assignment if provided
    if (cartonId) {
      const cartonLineId = require('crypto').randomUUID();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO carton_lines (
          id, carton_id, sku_id, item_name, qty, batch_number, expiry_date,
          picked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cartonLineId,
        cartonId,
        line.sku_id,
        line.sku_name || '',
        pickedQty,
        batch.batch_number,
        batch.expiry_date,
        now,
        now
      );

      // Update carton stats
      const carton = db.prepare('SELECT * FROM cartons WHERE id = ?').get(cartonId);
      if (carton) {
        const newQty = (carton.total_qty || 0) + pickedQty;
        db.prepare(`
          UPDATE cartons SET total_qty = ?, updated_at = ? WHERE id = ?
        `).run(newQty, now, cartonId);
      }

      return {
        lineId,
        batchId,
        pickedQty,
        cartonId,
        cartonLineCreated: cartonLineId,
        status: 'packed_to_carton',
      };
    }

    return {
      lineId,
      batchId,
      pickedQty,
      status: 'picked_awaiting_carton',
    };
  };

  // Assign batch to carton (linking phase)
  const assignBatchToCarton = (cartonLineId, batchId, quantity, customsLotId = null) => {
    const batch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(batchId);
    if (!batch) throw new Error('Batch not found');

    const cartonLine = db.prepare('SELECT * FROM carton_lines WHERE id = ?').get(cartonLineId);
    if (!cartonLine) throw new Error('Carton line not found');

    const now = new Date().toISOString();

    try {
      // Link batch to carton line
      db.prepare(`
        UPDATE carton_lines
        SET batch_id = ?, batch_number = ?, expiry_date = ?, picked_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        batchId,
        batch.batch_number,
        batch.expiry_date,
        now,
        now,
        cartonLineId
      );

      // Link customs lot if export
      if (customsLotId) {
        const carton = db.prepare(
          'SELECT carton_id FROM carton_lines WHERE id = ?'
        ).get(cartonLineId);

        db.prepare(`
          UPDATE cartons SET customs_lot_id = ? WHERE id = ?
        `).run(customsLotId, carton.carton_id);
      }

      return {
        cartonLineId,
        batchId,
        batchNumber: batch.batch_number,
        expiryDate: batch.expiry_date,
        assigned: true,
      };
    } catch (err) {
      throw new Error(`Failed to assign batch: ${err.message}`);
    }
  };

  // Close carton (finalize packing)
  const closeCarton = (cartonId, customsLotId = null) => {
    const carton = db.prepare('SELECT * FROM cartons WHERE id = ?').get(cartonId);
    if (!carton) throw new Error('Carton not found');

    const now = new Date().toISOString();

    try {
      // Get carton lines to verify all have batches
      const lines = db.prepare('SELECT * FROM carton_lines WHERE carton_id = ?').all(cartonId);

      const unassigned = lines.filter(l => !l.batch_id);
      if (unassigned.length > 0) {
        throw new Error(`${unassigned.length} lines not assigned to batch`);
      }

      // Update carton status
      db.prepare(`
        UPDATE cartons SET status = 'packed', packed_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, cartonId);

      // If export carton, verify customs lot
      if (customsLotId) {
        const customsLot = db.prepare('SELECT * FROM customs_lots WHERE id = ?').get(customsLotId);
        if (!customsLot) {
          throw new Error('Customs lot not found');
        }
        if (!customsLot.locked_at) {
          throw new Error('Customs lot not locked');
        }

        db.prepare(`
          UPDATE cartons SET customs_lot_id = ? WHERE id = ?
        `).run(customsLotId, cartonId);
      }

      return {
        cartonId,
        status: 'packed',
        lines: lines.length,
        closedAt: now,
      };
    } catch (err) {
      throw new Error(`Failed to close carton: ${err.message}`);
    }
  };

  // Get picking status for wave
  const getWavePickingStatus = (waveId) => {
    const wave = db.prepare('SELECT * FROM picking_waves WHERE id = ?').get(waveId);
    if (!wave) throw new Error('Wave not found');

    // Get all lines in wave
    const allLines = db.prepare(`
      SELECT ol.id FROM order_lines ol
      JOIN orders o ON ol.order_id = o.id
      JOIN wave_orders wo ON o.id = wo.order_id
      WHERE wo.wave_id = ?
    `).all(waveId);

    // Get picked lines
    const pickedLines = db.prepare(`
      SELECT COUNT(DISTINCT cl.id) as count FROM carton_lines cl
      JOIN cartons c ON cl.carton_id = c.id
      JOIN wave_orders wo ON c.order_id = wo.order_id
      WHERE wo.wave_id = ?
    `).get(waveId);

    const picked = pickedLines?.count || 0;
    const total = allLines.length;
    const percentComplete = total > 0 ? Math.round((picked / total) * 100) : 0;

    // Get cartons
    const cartons = db.prepare(`
      SELECT c.id, c.status, COUNT(cl.id) as lineCount
      FROM cartons c
      LEFT JOIN carton_lines cl ON c.id = cl.carton_id
      JOIN wave_orders wo ON c.order_id = wo.order_id
      WHERE wo.wave_id = ?
      GROUP BY c.id
    `).all(waveId);

    return {
      waveId,
      status: wave.status,
      pickingProgress: {
        picked,
        total,
        percentComplete,
      },
      cartons: cartons.map(c => ({
        cartonId: c.id,
        status: c.status,
        linesPacked: c.lineCount,
      })),
    };
  };

  // Helper: Calculate expiry days remaining
  const calculateExpiryDays = (expiryDate) => {
    const today = new Date();
    const expiry = new Date(expiryDate);
    const daysRemaining = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));

    return {
      days: daysRemaining,
      warning: daysRemaining < 0 ? 'EXPIRED' : (daysRemaining <= 30 ? 'EXPIRING_SOON' : null),
    };
  };

  return {
    generatePickingList,
    validatePickItem,
    markItemPicked,
    assignBatchToCarton,
    closeCarton,
    getWavePickingStatus,
  };
};
