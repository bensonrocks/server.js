'use strict';

const crypto = require('crypto');

/**
 * Order Approval Workflow Manager
 * Handles client order submissions, staff approval/rejection, and order finalization
 */
module.exports = function createOrderApproval(db, clientConfig, virtualFulfillment = null) {
  /**
   * Submit orders for approval (from client upload)
   */
  const submitOrdersForApproval = (tenantId, clientId, clientName, orders, filename = '') => {
    const now = new Date().toISOString();
    const results = {
      submitted: 0,
      errors: [],
      submissionId: crypto.randomUUID()
    };

    const stmt = db.prepare(`
      INSERT INTO pending_orders (id, tenant_id, client_id, client_name, order_data, status, upload_filename, uploaded_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `);

    orders.forEach((order, index) => {
      try {
        const pendingId = `PND-${Date.now()}-${String(index).padStart(3, '0')}-${crypto.randomBytes(4).toString('hex')}`;
        stmt.run(
          pendingId,
          tenantId,
          clientId,
          clientName,
          JSON.stringify(order),
          filename,
          now
        );
        results.submitted++;
      } catch (err) {
        results.errors.push({
          orderId: order.id || `order-${index}`,
          error: err.message
        });
      }
    });

    return results;
  };

  /**
   * Get pending orders for a client
   */
  const getClientPendingOrders = (clientId) => {
    const orders = db.prepare(`
      SELECT id, client_id, client_name, order_data, status, uploaded_at, reviewed_at, reviewed_by, rejection_reason
      FROM pending_orders
      WHERE client_id = ? AND status IN ('pending', 'rejected')
      ORDER BY uploaded_at DESC
    `).all(clientId);

    return orders.map(row => ({
      ...row,
      order_data: JSON.parse(row.order_data)
    }));
  };

  /**
   * Get all pending orders for staff review
   */
  const getAllPendingOrders = (tenantId, filter = {}) => {
    const { clientId, status = 'pending', limit = 50, offset = 0 } = filter;

    let sql = `
      SELECT id, tenant_id, client_id, client_name, order_data, status, uploaded_at, reviewed_at, reviewed_by
      FROM pending_orders
      WHERE tenant_id = ? AND status = ?
    `;
    const params = [tenantId, status];

    if (clientId) {
      sql += ` AND client_id = ?`;
      params.push(clientId);
    }

    sql += ` ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const orders = db.prepare(sql).all(...params);

    return orders.map(row => ({
      ...row,
      order_data: JSON.parse(row.order_data)
    }));
  };

  /**
   * Get count of pending orders for a client
   */
  const getPendingOrderCount = (clientId, status = 'pending') => {
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM pending_orders
      WHERE client_id = ? AND status = ?
    `).get(clientId, status);

    return result.count;
  };

  /**
   * Approve pending order and move to active orders
   */
  const approvePendingOrder = (pendingOrderId, approvedBy) => {
    const pending = db.prepare(`
      SELECT id, tenant_id, client_id, client_name, order_data
      FROM pending_orders
      WHERE id = ?
    `).get(pendingOrderId);

    if (!pending) throw new Error('Pending order not found');

    let order = JSON.parse(pending.order_data);
    const now = new Date().toISOString();

    // Expand bundles if clientConfig is available
    if (clientConfig && order.items && Array.isArray(order.items)) {
      order.items = clientConfig.expandOrderItems(pending.client_id, order.items);
      // Recalculate totals after expansion
      order.subtotal = order.items.reduce((sum, item) => sum + (item.qty * item.unitPrice), 0);
      order.total = order.subtotal + (order.shippingCost || 0) + (order.tax || 0);
    }

    // Determine order ID
    const orderId = order.id || crypto.randomUUID();

    // Begin transaction
    const transaction = db.transaction(() => {
      // Update pending order status
      db.prepare(`
        UPDATE pending_orders
        SET status = 'approved', reviewed_at = ?, reviewed_by = ?
        WHERE id = ?
      `).run(now, approvedBy, pendingOrderId);

      // Create order in active orders table
      db.prepare(`
        INSERT INTO orders (
          id, client_id, client_name, channel, order_date, status, currency, notes,
          items, shipping, subtotal, shipping_cost, tax, total, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId,
        pending.client_id,
        pending.client_name,
        order.channel || 'portal',
        order.orderDate || now,
        order.status || 'pending',
        order.currency || 'SGD',
        order.notes || '',
        JSON.stringify(order.items || []),
        JSON.stringify(order.shipping || {}),
        order.subtotal || 0,
        order.shippingCost || 0,
        order.tax || 0,
        order.total || 0,
        JSON.stringify({ type: 'approved-portal-upload', approvedBy, approvedAt: now }),
        now
      );
    });

    transaction();

    // Create fulfillment tracking for virtual items if applicable
    let fulfillmentTracking = null;
    if (virtualFulfillment) {
      try {
        fulfillmentTracking = virtualFulfillment.createFulfillmentTracking(orderId, pending.client_id);
      } catch (err) {
        // Log but don't fail on fulfillment tracking creation
        console.error(`Failed to create fulfillment tracking for order ${orderId}:`, err.message);
      }
    }

    return {
      pendingId: pendingOrderId,
      orderId: orderId,
      status: 'approved',
      approvedAt: now,
      approvedBy,
      virtualItemsTracked: fulfillmentTracking ? fulfillmentTracking.virtualItemsTracked : 0
    };
  };

  /**
   * Reject pending order with reason
   */
  const rejectPendingOrder = (pendingOrderId, rejectionReason, rejectedBy) => {
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE pending_orders
      SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, rejection_reason = ?
      WHERE id = ?
    `).run(now, rejectedBy, rejectionReason, pendingOrderId);

    return {
      pendingId: pendingOrderId,
      status: 'rejected',
      rejectionReason,
      rejectedAt: now,
      rejectedBy
    };
  };

  /**
   * Bulk approve pending orders
   */
  const bulkApprovePendingOrders = (pendingIds, approvedBy) => {
    const results = { approved: 0, failed: 0, errors: [] };

    pendingIds.forEach(id => {
      try {
        approvePendingOrder(id, approvedBy);
        results.approved++;
      } catch (err) {
        results.failed++;
        results.errors.push({ pendingId: id, error: err.message });
      }
    });

    return results;
  };

  /**
   * Get pending order details with parsed data
   */
  const getPendingOrderDetails = (pendingId) => {
    const order = db.prepare(`
      SELECT id, tenant_id, client_id, client_name, order_data, status, uploaded_at, reviewed_at, reviewed_by, rejection_reason, notes
      FROM pending_orders
      WHERE id = ?
    `).get(pendingId);

    if (!order) return null;

    return {
      ...order,
      order_data: JSON.parse(order.order_data)
    };
  };

  return {
    submitOrdersForApproval,
    getClientPendingOrders,
    getAllPendingOrders,
    getPendingOrderCount,
    approvePendingOrder,
    rejectPendingOrder,
    bulkApprovePendingOrders,
    getPendingOrderDetails
  };
};
