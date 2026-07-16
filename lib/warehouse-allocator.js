'use strict';

/**
 * Warehouse Allocator
 * Assigns orders to warehouses using configurable strategies
 * Integrates with inventory_batches for real-time availability
 */
module.exports = function createWarehouseAllocator(db, inventoryWarehouse) {

  // Allocate order to warehouse using strategy
  const allocateOrderToWarehouse = (orderId, options = {}) => {
    const {
      warehouseId = null,
      strategy = 'highest_stock',  // 'highest_stock', 'nearest', 'smallest'
      force = false
    } = options;

    // Get order
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new Error('Order not found');

    // Check if already allocated
    if (order.warehouse_id && !force) {
      return {
        orderId,
        status: 'already_allocated',
        warehouseId: order.warehouse_id,
      };
    }

    // Get order lines
    const lines = db.prepare(`
      SELECT * FROM order_lines WHERE order_id = ?
    `).all(orderId);

    if (!lines.length) {
      throw new Error('No order lines found');
    }

    // Determine target warehouse
    let targetWarehouse = warehouseId;

    if (!targetWarehouse) {
      if (strategy === 'highest_stock') {
        targetWarehouse = findWarehouseWithMostStock(lines);
      } else if (strategy === 'nearest') {
        targetWarehouse = findNearestWarehouse(order);
      } else if (strategy === 'smallest') {
        targetWarehouse = findSmallestWarehouse();
      }
    }

    if (!targetWarehouse) {
      return {
        orderId,
        status: 'no_warehouse_available',
        lines: lines.length,
      };
    }

    // Check availability at warehouse
    const availability = checkWarehouseAvailability(targetWarehouse, lines);

    if (!availability.allAvailable && !force) {
      return {
        orderId,
        status: 'insufficient_stock',
        warehouse: targetWarehouse,
        available: availability.available,
        missing: availability.missing,
      };
    }

    // Allocate order to warehouse
    try {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE orders
        SET warehouse_id = ?, updated_at = ?
        WHERE id = ?
      `).run(targetWarehouse, now, orderId);

      // Log allocation
      const allocationId = require('crypto').randomUUID();
      db.prepare(`
        INSERT INTO allocation_log (id, order_id, warehouse_id, strategy, allocated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(allocationId, orderId, targetWarehouse, strategy, now);

      return {
        orderId,
        status: 'allocated',
        warehouse: targetWarehouse,
        strategy,
        lines: lines.length,
        allocatedAt: now,
      };
    } catch (err) {
      throw new Error(`Failed to allocate order: ${err.message}`);
    }
  };

  // Check warehouse availability for order lines
  const checkWarehouseAvailability = (warehouseId, orderLines) => {
    const available = [];
    const missing = [];

    orderLines.forEach(line => {
      const batch = db.prepare(`
        SELECT * FROM inventory_batches
        WHERE warehouse_id = ? AND sku_id = ?
        AND available_qty > 0
        AND (expiry_date IS NULL OR expiry_date >= date('now'))
        ORDER BY received_at ASC
        LIMIT 1
      `).get(warehouseId, line.sku_id);

      if (batch && batch.available_qty >= line.ordered_qty) {
        available.push({
          lineId: line.id,
          sku: line.sku_id,
          required: line.ordered_qty,
          available: batch.available_qty,
          batchId: batch.id,
        });
      } else {
        missing.push({
          lineId: line.id,
          sku: line.sku_id,
          required: line.ordered_qty,
          available: batch ? batch.available_qty : 0,
        });
      }
    });

    return {
      allAvailable: missing.length === 0,
      available,
      missing,
    };
  };

  // Find warehouse with highest total stock for order
  const findWarehouseWithMostStock = (orderLines) => {
    const warehouses = db.prepare('SELECT id FROM warehouses WHERE is_active = 1').all();

    let bestWarehouse = null;
    let bestScore = 0;

    warehouses.forEach(wh => {
      let score = 0;
      let allAvailable = true;

      orderLines.forEach(line => {
        const batch = db.prepare(`
          SELECT SUM(available_qty) as total FROM inventory_batches
          WHERE warehouse_id = ? AND sku_id = ?
          AND available_qty > 0
          AND (expiry_date IS NULL OR expiry_date >= date('now'))
        `).get(wh.id, line.sku_id);

        const available = batch?.total || 0;
        if (available >= line.ordered_qty) {
          score += available;  // More stock = higher score
        } else {
          allAvailable = false;
        }
      });

      if (allAvailable && score > bestScore) {
        bestScore = score;
        bestWarehouse = wh.id;
      }
    });

    return bestWarehouse;
  };

  // Find nearest warehouse by zip code proximity
  const findNearestWarehouse = (order) => {
    if (!order.delivery_zip) {
      return null;
    }

    // Simple prefix match: order from 650xx → warehouse in 650xx area
    const orderPrefix = order.delivery_zip.substring(0, 3);

    const warehouse = db.prepare(`
      SELECT * FROM warehouses
      WHERE is_active = 1
      AND location_zip LIKE ?
      LIMIT 1
    `).get(orderPrefix + '%');

    if (warehouse) {
      return warehouse.id;
    }

    // Fallback to first active warehouse
    const fallback = db.prepare(
      'SELECT id FROM warehouses WHERE is_active = 1 LIMIT 1'
    ).get();

    return fallback?.id || null;
  };

  // Find smallest warehouse (load balancing)
  const findSmallestWarehouse = () => {
    const warehouse = db.prepare(`
      SELECT w.id
      FROM warehouses w
      LEFT JOIN inventory_batches ib ON w.id = ib.warehouse_id
      WHERE w.is_active = 1
      GROUP BY w.id
      ORDER BY COALESCE(SUM(ib.available_qty), 0) ASC
      LIMIT 1
    `).get();

    return warehouse?.id || null;
  };

  // Allocate batches to picking wave
  const allocateBatchesForWave = (waveId) => {
    const wave = db.prepare('SELECT * FROM picking_waves WHERE id = ?').get(waveId);
    if (!wave) throw new Error('Wave not found');

    // Get all orders in wave
    const waveOrders = db.prepare(`
      SELECT o.id as order_id, o.warehouse_id
      FROM wave_orders wo
      JOIN orders o ON wo.order_id = o.id
      WHERE wo.wave_id = ?
    `).all(waveId);

    if (!waveOrders.length) {
      throw new Error('No orders in wave');
    }

    // All orders should be in same warehouse for a wave
    const warehouse = waveOrders[0].warehouse_id;
    if (!warehouse) {
      throw new Error('Wave orders not allocated to warehouse');
    }

    // Get all lines for this wave
    const lines = db.prepare(`
      SELECT ol.* FROM order_lines ol
      JOIN orders o ON ol.order_id = o.id
      JOIN wave_orders wo ON o.id = wo.order_id
      WHERE wo.wave_id = ?
    `).all(waveId);

    // Allocate batches
    const allocations = [];
    const failures = [];

    lines.forEach(line => {
      try {
        // Get next batch for picking
        const batch = db.prepare(`
          SELECT * FROM inventory_batches
          WHERE warehouse_id = ? AND sku_id = ?
          AND available_qty > 0
          AND (expiry_date IS NULL OR expiry_date >= date('now'))
          ORDER BY received_at ASC
          LIMIT 1
        `).get(warehouse, line.sku_id);

        if (!batch) {
          failures.push({
            lineId: line.id,
            sku: line.sku_id,
            error: 'No available batch',
          });
          return;
        }

        if (batch.available_qty < line.ordered_qty) {
          failures.push({
            lineId: line.id,
            sku: line.sku_id,
            error: `Insufficient qty: ${batch.available_qty} < ${line.ordered_qty}`,
          });
          return;
        }

        // Allocate batch for picking
        inventoryWarehouse.allocateForPicking(batch.id, line.ordered_qty);

        allocations.push({
          lineId: line.id,
          sku: line.sku_id,
          batchId: batch.id,
          batchNumber: batch.batch_number,
          quantity: line.ordered_qty,
          expiryDate: batch.expiry_date,
          location: batch.location_bin,
        });
      } catch (err) {
        failures.push({
          lineId: line.id,
          sku: line.sku_id,
          error: err.message,
        });
      }
    });

    return {
      waveId,
      warehouse,
      allocated: allocations.length,
      failed: failures.length,
      allocations,
      failures,
    };
  };

  // Get warehouse statistics
  const getWarehouseStatistics = () => {
    const warehouses = db.prepare('SELECT * FROM warehouses WHERE is_active = 1').all();

    return warehouses.map(wh => {
      const stats = inventoryWarehouse.getWarehouseStats(wh.id);

      return {
        warehouseId: wh.id,
        name: wh.name,
        location: `${wh.location_city}, ${wh.location_state}`,
        ...stats,
      };
    });
  };

  // Get allocation log for order
  const getAllocationHistory = (orderId) => {
    const allocations = db.prepare(`
      SELECT * FROM allocation_log WHERE order_id = ? ORDER BY allocated_at DESC
    `).all(orderId);

    return allocations.map(a => ({
      strategy: a.strategy,
      warehouse: a.warehouse_id,
      timestamp: a.allocated_at,
    }));
  };

  // Suggest best warehouse for order (dry-run, no allocation)
  const suggestWarehouse = (orderId) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new Error('Order not found');

    const lines = db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(orderId);
    if (!lines.length) throw new Error('No order lines');

    const strategies = {
      highest_stock: findWarehouseWithMostStock(lines),
      nearest: findNearestWarehouse(order),
      smallest: findSmallestWarehouse(),
    };

    const suggestions = [];

    Object.entries(strategies).forEach(([strategy, warehouseId]) => {
      if (!warehouseId) return;

      const wh = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(warehouseId);
      const availability = checkWarehouseAvailability(warehouseId, lines);

      suggestions.push({
        strategy,
        warehouseId,
        name: wh.name,
        location: `${wh.location_city}, ${wh.location_state}`,
        available: availability.available.length,
        missing: availability.missing.length,
        canFulfill: availability.allAvailable,
      });
    });

    return suggestions;
  };

  return {
    allocateOrderToWarehouse,
    checkWarehouseAvailability,
    allocateBatchesForWave,
    getWarehouseStatistics,
    getAllocationHistory,
    suggestWarehouse,
  };
};
