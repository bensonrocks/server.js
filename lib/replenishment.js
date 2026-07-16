'use strict';

/**
 * Replenishment Module
 * Manages stock replenishment from high-tier racks to pick face locations
 * Optimizes for fast-moving items based on velocity data
 */
module.exports = function createReplenishment(db, inventoryWarehouse) {

  // Calculate SKU velocity (picks per day) from recent history
  const calculateSkuVelocity = (skuId, days = 30) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const picks = db.prepare(`
      SELECT COUNT(*) as pick_count FROM inventory_movements
      WHERE sku_id = ? AND movement_type = 'picked' AND created_at >= ?
    `).get(skuId, cutoffDate.toISOString());

    const velocity = picks.pick_count / days;
    return {
      skuId,
      picksLast30Days: picks.pick_count || 0,
      velocityPerDay: Math.round(velocity * 100) / 100,
      velocityPerWeek: Math.round(velocity * 7 * 100) / 100,
      classification: velocity > 2 ? 'fast_moving' : velocity > 0.5 ? 'moderate' : 'slow_moving'
    };
  };

  // Suggest replenishment tasks based on pick face levels
  const suggestReplenishmentTasks = (options = {}) => {
    const {
      warehouseId = 'wh-main',
      minVelocity = 0.5,  // picks per day
      maxPickFaceQty = 50,
      thresholdPct = 50,  // Trigger when pick face < 50% of max
      limitTasks = 50
    } = options;

    // Get high-velocity SKUs that need restocking
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);

    const recommendations = db.prepare(`
      SELECT DISTINCT sku_id
      FROM inventory_movements
      WHERE warehouse_id = ? AND movement_type = 'picked' AND created_at >= ?
      GROUP BY sku_id
      HAVING COUNT(*) >= ?
      ORDER BY COUNT(*) DESC
      LIMIT ?
    `).all(warehouseId, cutoffDate.toISOString(), Math.ceil(minVelocity * 30), limitTasks);

    const tasks = [];

    recommendations.forEach(rec => {
      const velocity = calculateSkuVelocity(rec.sku_id);

      if (velocity.classification !== 'fast_moving') return;

      // Get batches in pick face (typically lower bins like A1-01)
      const pickFaceBatches = db.prepare(`
        SELECT * FROM inventory_batches
        WHERE warehouse_id = ? AND sku_id = ? AND location_bin LIKE 'A1-%'
        ORDER BY received_at ASC
      `).all(warehouseId, rec.sku_id);

      const pickFaceQty = pickFaceBatches.reduce((sum, b) => sum + b.available_qty, 0);

      // Trigger replenishment if pick face < threshold
      if (pickFaceQty < (maxPickFaceQty * thresholdPct / 100)) {
        // Find high-tier rack inventory (B, C, D levels)
        const highTierBatches = db.prepare(`
          SELECT * FROM inventory_batches
          WHERE warehouse_id = ? AND sku_id = ?
          AND location_bin NOT LIKE 'A1-%'
          AND available_qty > 0
          AND (expiry_date IS NULL OR expiry_date >= date('now'))
          ORDER BY received_at ASC
          LIMIT 5
        `).all(warehouseId, rec.sku_id);

        if (highTierBatches.length > 0) {
          const source = highTierBatches[0];
          const replenishQty = Math.min(
            maxPickFaceQty - pickFaceQty,  // How much space in pick face
            source.available_qty,            // What's available to move
            Math.ceil(velocity.velocityPerDay * 7)  // 1 week supply
          );

          if (replenishQty > 0) {
            tasks.push({
              skuId: rec.sku_id,
              velocityPerDay: velocity.velocityPerDay,
              currentPickFaceQty: pickFaceQty,
              targetPickFaceQty: maxPickFaceQty,
              replenishQty,
              sourceBatchId: source.id,
              sourceBatchNumber: source.batch_number,
              sourceLocation: source.location_bin,
              targetLocation: 'A1-01',
              priority: Math.ceil(velocity.velocityPerDay),
              estimatedDaysOfStock: Math.round(pickFaceQty / velocity.velocityPerDay)
            });
          }
        }
      }
    });

    return {
      warehouseId,
      suggestedTasks: tasks.sort((a, b) => b.priority - a.priority),
      totalSuggested: tasks.length
    };
  };

  // Create replenishment wave (batch multiple tasks)
  const createReplenishmentWave = (taskIds = [], options = {}) => {
    const {
      warehouseId = 'wh-main',
      supervisor = 'System',
      notes = ''
    } = options;

    const waveId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    if (!taskIds || taskIds.length === 0) {
      throw new Error('At least one task ID required');
    }

    try {
      // Create replenishment wave record
      db.prepare(`
        INSERT INTO replenishment_waves (
          id, warehouse_id, task_count, status, supervisor, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        waveId,
        warehouseId,
        taskIds.length,
        'planned',
        supervisor,
        notes,
        now
      );

      // Create individual replenishment tasks
      let totalQty = 0;
      taskIds.forEach((taskSpec, idx) => {
        const {
          skuId,
          sourceBatchId,
          targetQty,
          priority = 5
        } = typeof taskSpec === 'string' ? { skuId: taskSpec } : taskSpec;

        const taskId = require('crypto').randomUUID();

        db.prepare(`
          INSERT INTO replenishment_tasks (
            id, wave_id, sku_id, source_batch_id, target_qty,
            priority, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          waveId,
          skuId,
          sourceBatchId || null,
          targetQty || null,
          priority,
          'pending',
          now
        );

        totalQty += targetQty || 0;
      });

      return {
        waveId,
        warehouseId,
        taskCount: taskIds.length,
        totalQtyToMove: totalQty,
        status: 'planned',
        createdAt: now
      };
    } catch (err) {
      throw new Error(`Failed to create replenishment wave: ${err.message}`);
    }
  };

  // Execute replenishment task (move stock)
  const executeReplenishmentTask = (taskId, movedQty, notes = '') => {
    const task = db.prepare(`
      SELECT * FROM replenishment_tasks WHERE id = ?
    `).get(taskId);

    if (!task) throw new Error('Task not found');

    const sourceBatch = db.prepare(`
      SELECT * FROM inventory_batches WHERE id = ?
    `).get(task.source_batch_id);

    if (!sourceBatch) throw new Error('Source batch not found');

    // Find or create target batch in A1 (pick face)
    let targetBatch = db.prepare(`
      SELECT * FROM inventory_batches
      WHERE warehouse_id = ? AND sku_id = ? AND location_bin = 'A1-01'
      ORDER BY received_at DESC LIMIT 1
    `).get(sourceBatch.warehouse_id, task.sku_id);

    const now = new Date().toISOString();

    try {
      // Move quantity
      if (movedQty > sourceBatch.available_qty) {
        throw new Error(`Cannot move ${movedQty}, only ${sourceBatch.available_qty} available`);
      }

      // Update source batch
      db.prepare(`
        UPDATE inventory_batches
        SET available_qty = available_qty - ?
        WHERE id = ?
      `).run(movedQty, sourceBatch.id);

      // Update or create target batch in pick face
      if (targetBatch) {
        db.prepare(`
          UPDATE inventory_batches
          SET available_qty = available_qty + ?
          WHERE id = ?
        `).run(movedQty, targetBatch.id);
      } else {
        // Create new batch in pick face (consolidate existing batches)
        const newBatchId = require('crypto').randomUUID();
        db.prepare(`
          INSERT INTO inventory_batches (
            id, warehouse_id, sku_id, batch_number, serial_number,
            expiry_date, received_qty, available_qty, allocated_qty,
            picked_qty, damaged_qty, scrap_qty, received_at, location_bin
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newBatchId,
          sourceBatch.warehouse_id,
          sourceBatch.sku_id,
          sourceBatch.batch_number + '_REPLEN',
          sourceBatch.serial_number,
          sourceBatch.expiry_date,
          movedQty,
          movedQty,
          0, 0, 0, 0,
          now,
          'A1-01'
        );

        targetBatch = { id: newBatchId };
      }

      // Log movement
      const movementId = require('crypto').randomUUID();
      db.prepare(`
        INSERT INTO inventory_movements (
          id, warehouse_id, batch_id, sku_id, movement_type,
          quantity, from_location, to_location, reason, reference_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        movementId,
        sourceBatch.warehouse_id,
        sourceBatch.id,
        task.sku_id,
        'replenishment_move',
        movedQty,
        sourceBatch.location_bin,
        'A1-01',
        notes || 'Replenishment to pick face',
        taskId,
        now
      );

      // Update task
      db.prepare(`
        UPDATE replenishment_tasks
        SET moved_qty = moved_qty + ?, status = 'completed', completed_at = ?
        WHERE id = ?
      `).run(movedQty, now, taskId);

      return {
        taskId,
        skuId: task.sku_id,
        movedQty,
        sourceBatch: sourceBatch.id,
        targetBatch: targetBatch.id,
        sourceLocation: sourceBatch.location_bin,
        targetLocation: 'A1-01',
        status: 'completed',
        completedAt: now
      };
    } catch (err) {
      throw new Error(`Failed to execute replenishment task: ${err.message}`);
    }
  };

  // Get replenishment wave status
  const getReplenishmentWaveStatus = (waveId) => {
    const wave = db.prepare(`
      SELECT * FROM replenishment_waves WHERE id = ?
    `).get(waveId);

    if (!wave) throw new Error('Wave not found');

    const tasks = db.prepare(`
      SELECT * FROM replenishment_tasks WHERE wave_id = ?
    `).all(waveId);

    const completed = tasks.filter(t => t.status === 'completed').length;
    const pending = tasks.filter(t => t.status === 'pending').length;
    const inProgress = tasks.filter(t => t.status === 'in_progress').length;

    const totalMoved = tasks.reduce((sum, t) => sum + (t.moved_qty || 0), 0);

    return {
      waveId,
      warehouseId: wave.warehouse_id,
      status: wave.status,
      totalTasks: tasks.length,
      completedTasks: completed,
      pendingTasks: pending,
      inProgressTasks: inProgress,
      percentComplete: Math.round((completed / tasks.length) * 100),
      totalQtyMoved: totalMoved,
      createdAt: wave.created_at,
      completedAt: wave.completed_at,
      tasks: tasks.map(t => ({
        id: t.id,
        skuId: t.sku_id,
        targetQty: t.target_qty,
        movedQty: t.moved_qty || 0,
        status: t.status,
        priority: t.priority
      }))
    };
  };

  // Auto-trigger replenishment based on thresholds
  const autoTriggerReplenishment = (warehouseId = 'wh-main') => {
    const suggestions = suggestReplenishmentTasks({
      warehouseId,
      minVelocity: 0.5
    });

    if (suggestions.suggestedTasks.length === 0) {
      return {
        warehouseId,
        tasksSuggested: 0,
        waveCreated: false
      };
    }

    // Group by priority and create wave
    const highPriority = suggestions.suggestedTasks.filter(t => t.priority >= 5);

    if (highPriority.length > 0) {
      const waveData = createReplenishmentWave(
        highPriority.map(t => ({
          skuId: t.skuId,
          sourceBatchId: t.sourceBatchId,
          targetQty: t.replenishQty,
          priority: t.priority
        })),
        {
          warehouseId,
          supervisor: 'Auto-trigger',
          notes: 'Automatically triggered by replenishment system'
        }
      );

      return {
        warehouseId,
        tasksSuggested: suggestions.suggestedTasks.length,
        waveCreated: true,
        waveId: waveData.waveId,
        tasksInWave: waveData.taskCount
      };
    }

    return {
      warehouseId,
      tasksSuggested: suggestions.suggestedTasks.length,
      waveCreated: false
    };
  };

  // Get pick face status (monitor current inventory)
  const getPickFaceStatus = (warehouseId = 'wh-main') => {
    const batches = db.prepare(`
      SELECT sku_id, SUM(available_qty) as qty
      FROM inventory_batches
      WHERE warehouse_id = ? AND location_bin LIKE 'A1-%'
      GROUP BY sku_id
      ORDER BY qty DESC
    `).all(warehouseId);

    const stats = batches.map(b => {
      const velocity = calculateSkuVelocity(b.sku_id);
      const daysOfStock = velocity.velocityPerDay > 0
        ? Math.round(b.qty / velocity.velocityPerDay)
        : 999;

      return {
        skuId: b.sku_id,
        currentQty: b.qty,
        velocityPerDay: velocity.velocityPerDay,
        daysOfStock,
        lowStock: b.qty < velocity.velocityPerDay * 3  // Less than 3 days
      };
    });

    const totalQty = stats.reduce((sum, s) => sum + s.currentQty, 0);
    const lowStockItems = stats.filter(s => s.lowStock).length;

    return {
      warehouseId,
      pickFaceQty: totalQty,
      totalSkus: stats.length,
      lowStockItems,
      items: stats
    };
  };

  // Get replenishment history
  const getReplenishmentHistory = (warehouseId = 'wh-main', days = 30) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const movements = db.prepare(`
      SELECT * FROM inventory_movements
      WHERE warehouse_id = ? AND movement_type = 'replenishment_move'
      AND created_at >= ?
      ORDER BY created_at DESC
    `).all(warehouseId, cutoffDate.toISOString());

    const bySkuId = {};
    movements.forEach(m => {
      if (!bySkuId[m.sku_id]) {
        bySkuId[m.sku_id] = {
          skuId: m.sku_id,
          totalReplenished: 0,
          replenishmentCount: 0,
          lastReplenishedAt: null
        };
      }
      bySkuId[m.sku_id].totalReplenished += m.quantity;
      bySkuId[m.sku_id].replenishmentCount += 1;
      bySkuId[m.sku_id].lastReplenishedAt = m.created_at;
    });

    return {
      warehouseId,
      period: `Last ${days} days`,
      totalMovements: movements.length,
      totalQtyReplenished: movements.reduce((sum, m) => sum + m.quantity, 0),
      skuReplenishmentData: Object.values(bySkuId).sort((a, b) => b.totalReplenished - a.totalReplenished)
    };
  };

  return {
    calculateSkuVelocity,
    suggestReplenishmentTasks,
    createReplenishmentWave,
    executeReplenishmentTask,
    getReplenishmentWaveStatus,
    autoTriggerReplenishment,
    getPickFaceStatus,
    getReplenishmentHistory
  };
};
