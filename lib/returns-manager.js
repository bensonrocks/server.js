'use strict';

/**
 * Returns Management
 * Handles returns from customers, inspections, and restock
 */
module.exports = function createReturnsManager(db) {

  const createReturn = (params) => {
    const { orderId, items, reason, notes = '', source = 'platform' } = params;

    if (!orderId || !items || !items.length) {
      throw new Error('orderId and items are required');
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new Error('Order not found');

    const returnId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO returns (id, order_id, reason, status, source, notes, created_at, updated_at)
      VALUES (?, ?, ?, 'received', ?, ?, ?, ?)
    `).run(returnId, orderId, reason, source, notes, now, now);

    // Add return items
    for (const item of items) {
      db.prepare(`
        INSERT INTO return_items (return_id, order_line_id, return_qty, condition, added_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(returnId, item.orderLineId, item.qty, item.condition || 'unknown', now);
    }

    return {
      id: returnId,
      orderId,
      status: 'received',
      itemCount: items.length,
      createdAt: now,
    };
  };

  const inspectReturn = (returnId, inspectionResult) => {
    const { items, notes = '' } = inspectionResult;

    const ret = db.prepare('SELECT * FROM returns WHERE id = ?').get(returnId);
    if (!ret) throw new Error('Return not found');

    const now = new Date().toISOString();

    // Update return items with inspection results
    for (const item of items) {
      const itemRecord = db.prepare('SELECT * FROM return_items WHERE id = ?').get(item.id);
      if (!itemRecord) continue;

      db.prepare(`
        UPDATE return_items
        SET condition = ?, inspection_notes = ?, inspected_at = ?
        WHERE id = ?
      `).run(item.finalCondition || 'unknown', item.notes || '', now, item.id);
    }

    // Determine overall status based on conditions
    const conditions = db.prepare(`
      SELECT condition, COUNT(*) as cnt
      FROM return_items
      WHERE return_id = ?
      GROUP BY condition
    `).all(returnId);

    let nextStatus = 'inspected';
    const conditionMap = {};
    for (const c of conditions) {
      conditionMap[c.condition] = c.cnt;
    }

    // If all items are restockable, mark for restock
    if (conditionMap['good'] === conditions.length || (conditionMap['good'] && !conditionMap['damaged'])) {
      nextStatus = 'approved_restock';
    } else if (conditionMap['damaged']) {
      nextStatus = 'approved_disposal';
    }

    db.prepare(`
      UPDATE returns SET status = ?, inspection_notes = ?, inspected_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nextStatus, notes, now, now, returnId);

    return { id: returnId, status: nextStatus, conditions: conditionMap };
  };

  const approveRestock = (returnId) => {
    const ret = db.prepare('SELECT * FROM returns WHERE id = ?').get(returnId);
    if (!ret) throw new Error('Return not found');

    const items = db.prepare(`
      SELECT ri.*, ol.sku_id, ol.warehouse_id
      FROM return_items ri
      JOIN order_lines ol ON ri.order_line_id = ol.id
      WHERE ri.return_id = ? AND ri.condition IN ('good', 'like-new')
    `).all(returnId);

    const restocked = [];
    const failed = [];

    for (const item of items) {
      try {
        // Add back to inventory
        db.prepare(`
          INSERT INTO inventory_movements
          (return_id, sku_id, warehouse_id, quantity, movement_type, notes, created_at)
          VALUES (?, ?, ?, ?, 'return_restock', ?, datetime('now'))
        `).run(returnId, item.sku_id, item.warehouse_id || 'main', item.return_qty, 'Return from RMA: ' + returnId);

        restocked.push({ itemId: item.id, skuId: item.sku_id, qty: item.return_qty });
      } catch (err) {
        failed.push({ itemId: item.id, error: err.message });
      }
    }

    const status = failed.length > 0 ? 'partial_restock' : 'restocked';
    db.prepare('UPDATE returns SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), returnId);

    return { id: returnId, status, restocked, failed };
  };

  const disposeReturn = (returnId) => {
    const ret = db.prepare('SELECT * FROM returns WHERE id = ?').get(returnId);
    if (!ret) throw new Error('Return not found');

    const items = db.prepare(`
      SELECT * FROM return_items WHERE return_id = ? AND condition IN ('damaged', 'defective')
    `).all(returnId);

    for (const item of items) {
      db.prepare(`
        INSERT INTO returns_disposal (return_item_id, disposal_date, method, notes)
        VALUES (?, datetime('now'), 'waste', 'Disposed due to damage')
      `).run(item.id);

      db.prepare('UPDATE return_items SET disposed_at = datetime("now") WHERE id = ?').run(item.id);
    }

    db.prepare('UPDATE returns SET status = ?, disposed_at = ?, updated_at = ? WHERE id = ?')
      .run('disposed', new Date().toISOString(), new Date().toISOString(), returnId);

    return { id: returnId, status: 'disposed', itemsDisposed: items.length };
  };

  const getReturnDetails = (returnId) => {
    const ret = db.prepare('SELECT * FROM returns WHERE id = ?').get(returnId);
    if (!ret) return null;

    const items = db.prepare(`
      SELECT ri.*, ol.sku_code, ol.sku_name, s.name
      FROM return_items ri
      JOIN order_lines ol ON ri.order_line_id = ol.id
      LEFT JOIN skus s ON ol.sku_id = s.id
      WHERE ri.return_id = ?
      ORDER BY ri.added_at
    `).all(returnId);

    return {
      ...ret,
      items,
      itemCount: items.length,
    };
  };

  const getReturnStats = (filters = {}) => {
    const { startDate, endDate } = filters;

    let sql = `
      SELECT status, COUNT(*) as count
      FROM returns
      WHERE 1=1
    `;
    const params = [];

    if (startDate) {
      sql += ' AND created_at >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND created_at <= ?';
      params.push(endDate);
    }

    sql += ' GROUP BY status';

    const stats = db.prepare(sql).all(...params);

    const result = {
      total: 0,
      byStatus: {},
      restockableItems: 0,
      disposableItems: 0,
    };

    for (const s of stats) {
      result.byStatus[s.status] = s.count;
      result.total += s.count;
    }

    // Count restockable items
    const restockable = db.prepare(`
      SELECT COUNT(*) as cnt FROM return_items
      WHERE condition IN ('good', 'like-new')
    `).get();
    result.restockableItems = restockable.cnt || 0;

    // Count disposable items
    const disposable = db.prepare(`
      SELECT COUNT(*) as cnt FROM return_items
      WHERE condition IN ('damaged', 'defective')
    `).get();
    result.disposableItems = disposable.cnt || 0;

    return result;
  };

  const listReturns = (filters = {}) => {
    const { status, limit = 50, offset = 0 } = filters;

    let sql = 'SELECT * FROM returns WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(sql).all(...params);
  };

  return {
    createReturn,
    inspectReturn,
    approveRestock,
    disposeReturn,
    getReturnDetails,
    getReturnStats,
    listReturns,
  };
};
