'use strict';

const { randomUUID } = require('crypto');

/**
 * Virtual Item Fulfillment Tracker
 * Manages client fulfillment of virtual items in mixed orders
 */
module.exports = function createVirtualFulfillment(db, clientConfig) {

  /**
   * Create fulfillment tracking for virtual items in an order
   * Called after order is approved
   */
  const createFulfillmentTracking = (orderId, clientId) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new Error('Order not found');

    const lines = db.prepare(`
      SELECT id, sku_code, ordered_qty FROM order_lines WHERE order_id = ?
    `).all(orderId);

    const virtualItems = [];
    const now = new Date().toISOString();

    db.transaction(() => {
      for (const line of lines) {
        const isVirtual = clientConfig && clientConfig.isVirtualSku(clientId, line.sku_code);
        if (isVirtual) {
          const id = 'VF-' + randomUUID();
          db.prepare(`
            INSERT OR IGNORE INTO virtual_item_fulfillment (
              id, order_id, client_id, sku_code, qty_required, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
          `).run(id, orderId, clientId, line.sku_code, line.ordered_qty, now, now);

          virtualItems.push({
            fulfillmentId: id,
            sku: line.sku_code,
            qtyRequired: line.ordered_qty,
            status: 'pending'
          });
        }
      }
    })();

    return {
      orderId,
      clientId,
      virtualItemsTracked: virtualItems.length,
      items: virtualItems
    };
  };

  /**
   * Get all pending virtual items for a client
   */
  const getClientPendingVirtualItems = (clientId, options = {}) => {
    const { status = 'pending', limit = 50, offset = 0 } = options;

    let sql = `
      SELECT vf.*, ol.sku_name, cvs.fulfillment_method, o.total as orderTotal, o.created_at as orderCreatedAt
      FROM virtual_item_fulfillment vf
      JOIN order_lines ol ON ol.sku_code = vf.sku_code AND ol.order_id = vf.order_id
      JOIN orders o ON o.id = vf.order_id
      LEFT JOIN client_virtual_skus cvs ON cvs.client_id = vf.client_id AND cvs.sku = vf.sku_code
      WHERE vf.client_id = ?
    `;
    const params = [clientId];

    if (status) {
      sql += ` AND vf.status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY vf.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const results = db.prepare(sql).all(...params);

    return results.map(row => ({
      fulfillmentId: row.id,
      orderId: row.order_id,
      sku: row.sku_code,
      skuName: row.sku_name,
      qtyRequired: row.qty_required,
      qtyFulfilled: row.qty_fulfilled,
      status: row.status,
      fulfillmentMethod: row.fulfillment_method || 'virtual',
      orderTotal: row.orderTotal,
      orderCreatedAt: row.orderCreatedAt,
      fulfillmentDate: row.fulfillment_date,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  };

  /**
   * Get client orders with virtual items breakdown
   */
  const getClientOrdersWithVirtualItems = (clientId, options = {}) => {
    const { limit = 50, offset = 0 } = options;

    const sql = `
      SELECT DISTINCT o.id, o.status, o.created_at, o.total, o.channel,
             COUNT(vf.id) as virtualItemCount
      FROM orders o
      LEFT JOIN virtual_item_fulfillment vf ON o.id = vf.order_id AND vf.client_id = ?
      WHERE o.client_id = ? AND vf.id IS NOT NULL
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const orders = db.prepare(sql).all(clientId, clientId, limit, offset);

    // Enrich with item details
    return orders.map(order => {
      const virtualItems = db.prepare(`
        SELECT vf.id, vf.sku_code, vf.qty_required, vf.qty_fulfilled, vf.status,
               ol.sku_name, cvs.fulfillment_method
        FROM virtual_item_fulfillment vf
        JOIN order_lines ol ON ol.sku_code = vf.sku_code AND ol.order_id = vf.order_id
        LEFT JOIN client_virtual_skus cvs ON cvs.client_id = vf.client_id AND cvs.sku = vf.sku_code
        WHERE vf.order_id = ? AND vf.client_id = ?
      `).all(order.id, clientId);

      const regularItems = db.prepare(`
        SELECT ol.id, ol.sku_code, ol.sku_name, ol.ordered_qty
        FROM order_lines ol
        WHERE ol.order_id = ? AND ol.sku_code NOT IN (
          SELECT sku_code FROM virtual_item_fulfillment WHERE order_id = ?
        )
      `).all(order.id, order.id);

      const allVirtualFulfilled = virtualItems.length > 0 &&
        virtualItems.every(vi => vi.status === 'fulfilled');

      return {
        orderId: order.id,
        status: order.status,
        channel: order.channel,
        orderTotal: order.total,
        createdAt: order.created_at,
        requiresClientAction: !allVirtualFulfilled,
        virtualItems: virtualItems.map(vi => ({
          fulfillmentId: vi.id,
          sku: vi.sku_code,
          skuName: vi.sku_name,
          qtyRequired: vi.qty_required,
          qtyFulfilled: vi.qty_fulfilled,
          status: vi.status,
          fulfillmentMethod: vi.fulfillment_method || 'virtual'
        })),
        regularItems: regularItems.map(ri => ({
          sku: ri.sku_code,
          skuName: ri.sku_name,
          qty: ri.ordered_qty
        })),
        virtualItemsCount: virtualItems.length,
        allVirtualFulfilled
      };
    });
  };

  /**
   * Update virtual item fulfillment status
   */
  const updateVirtualItemFulfillment = (fulfillmentId, updates = {}) => {
    const { status, qtyFulfilled, notes } = updates;

    const fulfillment = db.prepare(`
      SELECT * FROM virtual_item_fulfillment WHERE id = ?
    `).get(fulfillmentId);

    if (!fulfillment) throw new Error('Fulfillment record not found');

    const now = new Date().toISOString();
    const newStatus = status || fulfillment.status;
    const newQty = qtyFulfilled !== undefined ? qtyFulfilled : fulfillment.qty_fulfilled;
    const newNotes = notes !== undefined ? notes : fulfillment.notes;
    const fulfillmentDate = (newStatus === 'fulfilled' && !fulfillment.fulfillment_date) ? now : fulfillment.fulfillment_date;

    db.prepare(`
      UPDATE virtual_item_fulfillment
      SET status = ?, qty_fulfilled = ?, notes = ?, fulfillment_date = ?, updated_at = ?
      WHERE id = ?
    `).run(newStatus, newQty, newNotes, fulfillmentDate, now, fulfillmentId);

    const updated = db.prepare('SELECT * FROM virtual_item_fulfillment WHERE id = ?').get(fulfillmentId);
    return {
      fulfillmentId: updated.id,
      orderId: updated.order_id,
      sku: updated.sku_code,
      qtyRequired: updated.qty_required,
      qtyFulfilled: updated.qty_fulfilled,
      status: updated.status,
      fulfillmentDate: updated.fulfillment_date,
      notes: updated.notes,
      updatedAt: updated.updated_at
    };
  };

  /**
   * Get client fulfillment dashboard summary
   */
  const getClientDashboardSummary = (clientId) => {
    const pending = db.prepare(`
      SELECT COUNT(*) as cnt FROM virtual_item_fulfillment
      WHERE client_id = ? AND status = 'pending'
    `).get(clientId).cnt;

    const inProgress = db.prepare(`
      SELECT COUNT(*) as cnt FROM virtual_item_fulfillment
      WHERE client_id = ? AND status = 'in_progress'
    `).get(clientId).cnt;

    const fulfilled = db.prepare(`
      SELECT COUNT(*) as cnt FROM virtual_item_fulfillment
      WHERE client_id = ? AND status = 'fulfilled'
    `).get(clientId).cnt;

    const failed = db.prepare(`
      SELECT COUNT(*) as cnt FROM virtual_item_fulfillment
      WHERE client_id = ? AND status = 'failed'
    `).get(clientId).cnt;

    const ordersWithVirtualItems = db.prepare(`
      SELECT COUNT(DISTINCT order_id) as cnt FROM virtual_item_fulfillment
      WHERE client_id = ?
    `).get(clientId).cnt;

    const pendingOrders = db.prepare(`
      SELECT DISTINCT vf.order_id, o.created_at, COUNT(vf.id) as itemCount
      FROM virtual_item_fulfillment vf
      JOIN orders o ON o.id = vf.order_id
      WHERE vf.client_id = ? AND vf.status IN ('pending', 'in_progress')
      GROUP BY vf.order_id
      ORDER BY o.created_at DESC
      LIMIT 5
    `).all(clientId);

    const fulfilledToday = db.prepare(`
      SELECT COUNT(*) as cnt FROM virtual_item_fulfillment
      WHERE client_id = ? AND status = 'fulfilled' AND DATE(fulfillment_date) = DATE('now')
    `).get(clientId).cnt;

    const pastDue = db.prepare(`
      SELECT COUNT(*) as cnt FROM virtual_item_fulfillment vf
      JOIN orders o ON o.id = vf.order_id
      WHERE vf.client_id = ? AND vf.status IN ('pending', 'in_progress')
      AND datetime(o.created_at, '+24 hours') < datetime('now')
    `).get(clientId).cnt;

    return {
      summary: {
        pendingItems: pending,
        inProgressItems: inProgress,
        fulfilledItems: fulfilled,
        failedItems: failed,
        ordersWithVirtualItems,
        fulfilledToday,
        pastDueItems: pastDue
      },
      recentOrders: pendingOrders.map(row => ({
        orderId: row.order_id,
        virtualItemsCount: row.itemCount,
        createdAt: row.created_at
      }))
    };
  };

  /**
   * Mark all virtual items in an order as fulfilled
   */
  const fulfillAllOrderItems = (orderId, clientId, notes = '') => {
    const now = new Date().toISOString();

    const result = db.prepare(`
      UPDATE virtual_item_fulfillment
      SET status = 'fulfilled', qty_fulfilled = qty_required, notes = ?, fulfillment_date = ?, updated_at = ?
      WHERE order_id = ? AND client_id = ? AND status != 'fulfilled'
    `).run(notes, now, now, orderId, clientId);

    return {
      orderId,
      itemsUpdated: result.changes,
      status: 'fulfilled',
      fulfilledAt: now
    };
  };

  return {
    createFulfillmentTracking,
    getClientPendingVirtualItems,
    getClientOrdersWithVirtualItems,
    updateVirtualItemFulfillment,
    getClientDashboardSummary,
    fulfillAllOrderItems
  };
};
