'use strict';

/**
 * Auto-Allocation Service
 * Automatically allocates orders to warehouses and reserves inventory
 */
module.exports = function createAutoAllocator(db, inventory, store) {

  const allocateOrder = (orderId, options = {}) => {
    const { warehouseId = null, strategy = 'nearest', force = false } = options;

    const order = store.getOrder(orderId);
    if (!order) throw new Error('Order not found');

    // Check if already allocated
    if (order.warehouse_id && !force) {
      return { orderId, status: 'already_allocated', warehouseId: order.warehouse_id };
    }

    // Get all order lines with inventory requirements
    const lines = db.prepare(`
      SELECT ol.id, ol.sku_id, ol.ordered_qty, s.code as sku_code
      FROM order_lines ol
      JOIN skus s ON ol.sku_id = s.id
      WHERE ol.order_id = ?
    `).all(orderId);

    if (!lines.length) {
      throw new Error('No order lines found');
    }

    // Determine target warehouse
    let targetWarehouse = warehouseId;

    if (!targetWarehouse) {
      if (strategy === 'nearest') {
        targetWarehouse = findNearestWarehouse(order, lines);
      } else if (strategy === 'highest_stock') {
        targetWarehouse = findWarehouseWithMostStock(lines);
      } else if (strategy === 'smallest') {
        targetWarehouse = findSmallestWarehouse();
      }
    }

    if (!targetWarehouse) {
      throw new Error('No suitable warehouse found for allocation');
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

    // Allocate inventory
    const allocated = [];
    const failed = [];

    for (const line of lines) {
      try {
        const allocResult = inventory.allocateLineItem(line.id, targetWarehouse, line.ordered_qty);
        allocated.push({
          lineId: line.id,
          sku: line.sku_code,
          qty: line.ordered_qty,
          warehouse: targetWarehouse,
        });
      } catch (err) {
        failed.push({
          lineId: line.id,
          sku: line.sku_code,
          error: err.message,
        });
      }
    }

    // Update order warehouse
    db.prepare('UPDATE orders SET warehouse_id = ?, status = ? WHERE id = ?')
      .run(targetWarehouse, 'processing', orderId);

    // Log allocation
    db.prepare(`
      INSERT INTO allocation_log (order_id, warehouse_id, strategy, allocated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(orderId, targetWarehouse, strategy);

    return {
      orderId,
      status: failed.length > 0 ? 'partial_allocation' : 'allocated',
      warehouse: targetWarehouse,
      allocated,
      failed,
    };
  };

  const allocateBatch = (orderIds, options = {}) => {
    const results = [];
    const errors = [];

    for (const orderId of orderIds) {
      try {
        results.push(allocateOrder(orderId, options));
      } catch (err) {
        errors.push({ orderId, error: err.message });
      }
    }

    return { results, errors, total: orderIds.length, allocated: results.length };
  };

  const findNearestWarehouse = (order, lines) => {
    // Parse shipping address
    const address = order.delivery_address ? JSON.parse(order.delivery_address) : {};
    const zip = address.zip || address.postal_code || '';

    // Get warehouses sorted by distance (in real world, use actual zip distance)
    const warehouses = db.prepare(`
      SELECT id, name, location_zip, location_lat, location_lon
      FROM warehouses
      WHERE is_active = 1
      ORDER BY location_zip = ? DESC, id ASC
    `).all(zip);

    return warehouses[0]?.id || null;
  };

  const findWarehouseWithMostStock = (lines) => {
    const skuIds = lines.map(l => l.sku_id);

    const warehouse = db.prepare(`
      SELECT w.id, w.name, SUM(ib.available_qty) as total_stock
      FROM warehouses w
      LEFT JOIN inventory_balance ib ON w.id = ib.warehouse_id
      WHERE ib.sku_id IN (${skuIds.map(() => '?').join(',')})
      AND w.is_active = 1
      GROUP BY w.id
      ORDER BY total_stock DESC
      LIMIT 1
    `).get(...skuIds);

    return warehouse?.id || null;
  };

  const findSmallestWarehouse = () => {
    const wh = db.prepare(`
      SELECT id FROM warehouses
      WHERE is_active = 1
      ORDER BY name ASC
      LIMIT 1
    `).get();
    return wh?.id || null;
  };

  const checkWarehouseAvailability = (warehouseId, lines) => {
    const available = [];
    const missing = [];

    for (const line of lines) {
      const stock = db.prepare(`
        SELECT available_qty FROM inventory_balance
        WHERE warehouse_id = ? AND sku_id = ?
      `).get(warehouseId, line.sku_id);

      const available_qty = stock?.available_qty || 0;

      if (available_qty >= line.ordered_qty) {
        available.push({ sku: line.sku_code, have: available_qty, need: line.ordered_qty });
      } else {
        missing.push({ sku: line.sku_code, have: available_qty, need: line.ordered_qty, short: line.ordered_qty - available_qty });
      }
    }

    return {
      allAvailable: missing.length === 0,
      available,
      missing,
    };
  };

  return {
    allocateOrder,
    allocateBatch,
    checkWarehouseAvailability,
  };
};
