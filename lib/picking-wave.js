'use strict';

/**
 * Picking Wave Management
 * Groups orders into waves for batch fulfillment
 * Includes THU (Temporary Handling Unit) code generation and smart wave mode suggestion
 */
module.exports = function createPickingWave(db) {

  // ── THU Code Generation ────────────────────────────────────────────────────
  // THU = Temporary Handling Unit (barcode for carton identification during picking)
  const generateThuCode = () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const { cnt } = db.prepare(`
      SELECT COUNT(*) as cnt FROM picking_waves WHERE id LIKE ?
    `).get(today + '%') || { cnt: 0 };
    return `THU${today}${String(cnt + 1).padStart(4, '0')}`;
  };

  // ── Wave Mode Suggestion ───────────────────────────────────────────────────
  // Recommends batch vs single-order picking based on SKU overlap
  const suggestWaveMode = (orderIds) => {
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      throw new Error('orderIds array required');
    }

    const orders = orderIds.map(id => {
      const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(id);
      if (!order) return null;
      const lines = db.prepare('SELECT sku_code FROM order_lines WHERE order_id = ?').all(id);
      return { id, lines };
    }).filter(Boolean);

    if (orders.length === 0) throw new Error('No valid orders found');

    if (orders.length === 1) {
      return {
        suggestion: 'single',
        orderCount: 1,
        totalLines: orders[0].lines.length,
        uniqueSkus: orders[0].lines.length,
        sharedSkus: 0,
        savedTrips: 0,
        thuRequired: false,
        reason: 'Single order — picker goes directly to packing station with items',
      };
    }

    // Analyze SKU overlap across orders
    const skuCounts = {};
    let totalLines = 0;
    for (const order of orders) {
      for (const line of order.lines) {
        skuCounts[line.sku_code] = (skuCounts[line.sku_code] || 0) + 1;
        totalLines++;
      }
    }

    const uniqueSkus = Object.keys(skuCounts).length;
    const sharedSkus = Object.values(skuCounts).filter(c => c > 1).length;
    const savedTrips = Object.values(skuCounts).reduce((s, c) => s + (c > 1 ? c - 1 : 0), 0);
    const overlapPct = uniqueSkus > 0 ? Math.round((sharedSkus / uniqueSkus) * 100) : 0;

    const reason = sharedSkus > 0
      ? `Batch saves ${savedTrips} redundant shelf trip${savedTrips === 1 ? '' : 's'} — ${sharedSkus} SKU${sharedSkus === 1 ? '' : 's'} shared across ${orders.length} orders (${overlapPct}% overlap)`
      : `Batch consolidates ${orders.length} pick lists into one run — assigned THU for sort at packing station`;

    return {
      suggestion: 'batch',
      orderCount: orders.length,
      totalLines,
      uniqueSkus,
      sharedSkus,
      savedTrips,
      overlapPct,
      thuRequired: true,
      reason,
    };
  };

  const createWave = (options = {}) => {
    const { name, warehouseId, priority = 'normal', maxOrders = 50, orderIds = [] } = options;

    const waveId = require('crypto').randomUUID();
    const now = new Date().toISOString();
    const thuCode = orderIds.length > 1 ? generateThuCode() : null;

    db.prepare(`
      INSERT INTO picking_waves (id, name, warehouse_id, status, priority, max_orders, thu_code, created_at, updated_at)
      VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?)
    `).run(waveId, name || `Wave-${Date.now()}`, warehouseId || null, priority, maxOrders, thuCode, now, now);

    return { id: waveId, name, status: 'created', orders: 0, thuCode };
  };

  const addOrdersToWave = (waveId, orderIds) => {
    const wave = db.prepare('SELECT * FROM picking_waves WHERE id = ?').get(waveId);
    if (!wave) throw new Error('Wave not found');
    if (wave.status !== 'created') throw new Error(`Cannot add orders to wave in ${wave.status} status`);

    const added = [];
    const failed = [];

    for (const orderId of orderIds) {
      try {
        // Check order exists and is in processing state
        const order = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(orderId);
        if (!order) {
          failed.push({ orderId, error: 'Order not found' });
          continue;
        }
        if (order.status !== 'processing') {
          failed.push({ orderId, error: `Order status is ${order.status}, expected processing` });
          continue;
        }

        db.prepare(`
          INSERT INTO wave_orders (wave_id, order_id, sequence, added_at)
          VALUES (?, ?, ?, datetime('now'))
        `).run(waveId, orderId, added.length + 1);

        added.push(orderId);
      } catch (err) {
        failed.push({ orderId, error: err.message });
      }
    }

    // Update wave order count
    const count = db.prepare('SELECT COUNT(*) as cnt FROM wave_orders WHERE wave_id = ?').get(waveId).cnt;
    db.prepare('UPDATE picking_waves SET order_count = ? WHERE id = ?').run(count, waveId);

    return {
      waveId,
      added: added.length,
      failed: failed.length,
      orders: added,
      failures: failed,
    };
  };

  const getWaveDetails = (waveId) => {
    const wave = db.prepare('SELECT * FROM picking_waves WHERE id = ?').get(waveId);
    if (!wave) return null;

    const orders = db.prepare(`
      SELECT wo.sequence, o.id, o.order_number, o.status, o.customer_name, COUNT(ol.id) as line_count
      FROM wave_orders wo
      JOIN orders o ON wo.order_id = o.id
      LEFT JOIN order_lines ol ON o.id = ol.order_id
      WHERE wo.wave_id = ?
      GROUP BY o.id
      ORDER BY wo.sequence
    `).all(waveId);

    const lines = db.prepare(`
      SELECT ol.id, ol.order_id, ol.sku_code, ol.ordered_qty, ol.picked_qty,
             s.name as sku_name, s.barcode
      FROM order_lines ol
      JOIN skus s ON ol.sku_id = s.id
      WHERE ol.order_id IN (SELECT order_id FROM wave_orders WHERE wave_id = ?)
      ORDER BY ol.order_id, ol.line_number
    `).all(waveId);

    return {
      ...wave,
      orders,
      lines,
      totalLines: lines.length,
      pickedLines: lines.filter(l => l.picked_qty > 0).length,
    };
  };

  const startWave = (waveId) => {
    const wave = db.prepare('SELECT * FROM picking_waves WHERE id = ?').get(waveId);
    if (!wave) throw new Error('Wave not found');
    if (wave.status !== 'created') throw new Error(`Cannot start wave in ${wave.status} status`);

    db.prepare(`
      UPDATE picking_waves
      SET status = 'picking', started_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(waveId);

    return { id: waveId, status: 'picking' };
  };

  const completeWave = (waveId) => {
    const wave = db.prepare('SELECT * FROM picking_waves WHERE id = ?').get(waveId);
    if (!wave) throw new Error('Wave not found');

    // Check all orders are packed
    const unpacked = db.prepare(`
      SELECT COUNT(*) as cnt FROM orders o
      JOIN wave_orders wo ON o.id = wo.order_id
      WHERE wo.wave_id = ? AND o.status != 'packed'
    `).get(waveId).cnt;

    if (unpacked > 0) {
      throw new Error(`Cannot complete wave: ${unpacked} orders not yet packed`);
    }

    db.prepare(`
      UPDATE picking_waves
      SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(waveId);

    return { id: waveId, status: 'completed' };
  };

  const listWaves = (filters = {}) => {
    const { status, warehouseId, limit = 50 } = filters;

    let sql = 'SELECT * FROM picking_waves WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (warehouseId) {
      sql += ' AND warehouse_id = ?';
      params.push(warehouseId);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const waves = db.prepare(sql).all(...params);

    return waves.map(w => ({
      ...w,
      orders: db.prepare('SELECT COUNT(*) as cnt FROM wave_orders WHERE wave_id = ?').get(w.id).cnt,
    }));
  };

  const getWaveStats = (waveId) => {
    const lines = db.prepare(`
      SELECT SUM(ol.ordered_qty) as total_qty,
             SUM(ol.picked_qty) as picked_qty,
             COUNT(*) as line_count,
             SUM(CASE WHEN ol.picked_qty >= ol.ordered_qty THEN 1 ELSE 0 END) as completed_lines
      FROM order_lines ol
      WHERE ol.order_id IN (SELECT order_id FROM wave_orders WHERE wave_id = ?)
    `).get(waveId);

    return {
      totalLines: lines.line_count || 0,
      completedLines: lines.completed_lines || 0,
      totalQty: lines.total_qty || 0,
      pickedQty: lines.picked_qty || 0,
      percentComplete: lines.line_count ? Math.round((lines.picked_qty / lines.total_qty) * 100) : 0,
    };
  };

  return {
    generateThuCode,
    suggestWaveMode,
    createWave,
    addOrdersToWave,
    getWaveDetails,
    startWave,
    completeWave,
    listWaves,
    getWaveStats,
  };
};
