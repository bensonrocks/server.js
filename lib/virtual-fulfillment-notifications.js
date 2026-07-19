'use strict';

/**
 * Virtual Item Fulfillment Notifications
 * Sends email alerts for virtual items requiring client fulfillment
 */
module.exports = function createVirtualFulfillmentNotifications(db, emailer = null) {

  /**
   * Email template: Order approved with virtual items
   */
  const getOrderApprovedTemplate = (clientName, order, virtualItems) => {
    const itemsList = virtualItems
      .map(item => `- ${item.sku} (${item.skuName}) - Qty: ${item.qtyRequired} - Method: ${item.fulfillmentMethod}`)
      .join('\n');

    return {
      subject: `Order ${order.id} Approved - Virtual Items Require Your Fulfillment`,
      body: `
Dear ${clientName},

Your order has been approved and is ready for fulfillment.

ORDER DETAILS:
- Order ID: ${order.id}
- Order Total: $${(order.total || 0).toFixed(2)}
- Status: Approved on ${new Date(order.createdAt).toLocaleDateString()}

VIRTUAL ITEMS REQUIRING YOUR FULFILLMENT:
${itemsList}

NEXT STEPS:
1. Log in to your client portal at https://app.idealomz.com/client
2. Navigate to "Virtual Items Fulfillment"
3. Update the status of each virtual item as you fulfill them
4. Once all virtual items are marked as fulfilled, warehouse will complete the shipment

FULFILLMENT STATUS TRACKING:
You can view and update fulfillment status at: https://app.idealomz.com/client/orders/${order.id}/virtual-items

Questions? Contact our support team at support@idealomz.com

Best regards,
IdealOMS Team
`
    };
  };

  /**
   * Email template: Daily pending items reminder
   */
  const getPendingItemsReminderTemplate = (clientName, pendingCount, ordersWithPending) => {
    const ordersList = ordersWithPending
      .map(o => `- Order ${o.orderId}: ${o.itemCount} virtual items pending`)
      .join('\n');

    return {
      subject: `Reminder: ${pendingCount} Virtual Items Pending Fulfillment`,
      body: `
Dear ${clientName},

You have ${pendingCount} virtual items awaiting fulfillment. Please complete these at your earliest convenience.

PENDING ITEMS BY ORDER:
${ordersList}

QUICK LINKS:
- View all pending items: https://app.idealomz.com/client/virtual-items/pending
- Dashboard: https://app.idealomz.com/client/dashboard

Timely fulfillment helps us ship orders faster. Thank you!

Best regards,
IdealOMS Team
`
    };
  };

  /**
   * Email template: Past-due items alert
   */
  const getPastDueItemsTemplate = (clientName, pastDueCount) => {
    return {
      subject: `URGENT: ${pastDueCount} Virtual Items Over 24 Hours Pending`,
      body: `
Dear ${clientName},

ALERT: You have ${pastDueCount} virtual items that have been pending for more than 24 hours.

These items need immediate attention to avoid order delays.

ACTION REQUIRED:
1. Visit: https://app.idealomz.com/client/virtual-items/pending
2. Update status to "in_progress" or "fulfilled"
3. Add notes if there are any issues with fulfillment

If you're experiencing any problems fulfilling these items, please contact us immediately at support@idealomz.com

Best regards,
IdealOMS Team
`
    };
  };

  /**
   * Send order approved notification to client
   */
  const notifyOrderApproved = (clientId, orderId, virtualItems, options = {}) => {
    if (!emailer) {
      console.warn(`[VirtualFulfillment] Email notification disabled - emailer not configured`);
      return {
        status: 'skipped',
        reason: 'emailer_not_configured'
      };
    }

    try {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!order) throw new Error('Order not found');

      const client = db.prepare('SELECT username FROM client_users WHERE id = ?').get(clientId);
      if (!client) throw new Error('Client not found');

      const template = getOrderApprovedTemplate(client.username || clientId, order, virtualItems);

      // Send email
      const result = emailer.send({
        to: options.email || `${clientId}@idealomz.com`,
        subject: template.subject,
        body: template.body,
        type: 'order_approved_virtual_items'
      });

      // Log notification
      db.prepare(`
        INSERT INTO virtual_fulfillment_notifications (
          client_id, order_id, notification_type, status, recipient_email, sent_at
        ) VALUES (?, ?, 'order_approved', 'sent', ?, datetime('now'))
      `).run(clientId, orderId, options.email || `${clientId}@idealomz.com`);

      return {
        status: 'sent',
        recipient: options.email || `${clientId}@idealomz.com`,
        orderId,
        itemsNotified: virtualItems.length
      };
    } catch (err) {
      console.error(`[VirtualFulfillment] Failed to send order approved notification:`, err.message);
      return {
        status: 'failed',
        error: err.message
      };
    }
  };

  /**
   * Send daily pending items reminder
   */
  const sendDailyPendingReminder = (clientId, options = {}) => {
    if (!emailer) {
      console.warn(`[VirtualFulfillment] Email notification disabled - emailer not configured`);
      return { status: 'skipped' };
    }

    try {
      const pending = db.prepare(`
        SELECT COUNT(*) as cnt FROM virtual_item_fulfillment
        WHERE client_id = ? AND status IN ('pending', 'in_progress')
      `).get(clientId).cnt;

      if (pending === 0) {
        return { status: 'skipped', reason: 'no_pending_items' };
      }

      const orders = db.prepare(`
        SELECT DISTINCT vf.order_id, COUNT(vf.id) as itemCount
        FROM virtual_item_fulfillment vf
        WHERE vf.client_id = ? AND vf.status IN ('pending', 'in_progress')
        GROUP BY vf.order_id
        ORDER BY vf.order_id DESC
      `).all(clientId);

      const client = db.prepare('SELECT username FROM client_users WHERE id = ?').get(clientId);
      const template = getPendingItemsReminderTemplate(client?.username || clientId, pending, orders);

      // Send email
      emailer.send({
        to: options.email || `${clientId}@idealomz.com`,
        subject: template.subject,
        body: template.body,
        type: 'pending_reminder'
      });

      // Log notification
      db.prepare(`
        INSERT INTO virtual_fulfillment_notifications (
          client_id, notification_type, status, recipient_email, sent_at
        ) VALUES (?, 'pending_reminder', 'sent', ?, datetime('now'))
      `).run(clientId, options.email || `${clientId}@idealomz.com`);

      return {
        status: 'sent',
        recipient: options.email || `${clientId}@idealomz.com`,
        pendingCount: pending,
        affectedOrders: orders.length
      };
    } catch (err) {
      console.error(`[VirtualFulfillment] Failed to send pending reminder:`, err.message);
      return { status: 'failed', error: err.message };
    }
  };

  /**
   * Send past-due items alert
   */
  const sendPastDueAlert = (clientId, options = {}) => {
    if (!emailer) {
      console.warn(`[VirtualFulfillment] Email notification disabled - emailer not configured`);
      return { status: 'skipped' };
    }

    try {
      const pastDue = db.prepare(`
        SELECT COUNT(*) as cnt FROM virtual_item_fulfillment vf
        JOIN orders o ON o.id = vf.order_id
        WHERE vf.client_id = ? AND vf.status IN ('pending', 'in_progress')
        AND datetime(o.created_at, '+24 hours') < datetime('now')
      `).get(clientId).cnt;

      if (pastDue === 0) {
        return { status: 'skipped', reason: 'no_past_due_items' };
      }

      const client = db.prepare('SELECT username FROM client_users WHERE id = ?').get(clientId);
      const template = getPastDueItemsTemplate(client?.username || clientId, pastDue);

      // Send email
      emailer.send({
        to: options.email || `${clientId}@idealomz.com`,
        subject: template.subject,
        body: template.body,
        type: 'past_due_alert'
      });

      // Log notification
      db.prepare(`
        INSERT INTO virtual_fulfillment_notifications (
          client_id, notification_type, status, recipient_email, sent_at
        ) VALUES (?, 'past_due_alert', 'sent', ?, datetime('now'))
      `).run(clientId, options.email || `${clientId}@idealomz.com`);

      return {
        status: 'sent',
        recipient: options.email || `${clientId}@idealomz.com`,
        pastDueCount: pastDue
      };
    } catch (err) {
      console.error(`[VirtualFulfillment] Failed to send past-due alert:`, err.message);
      return { status: 'failed', error: err.message };
    }
  };

  /**
   * Get notification history for a client
   */
  const getNotificationHistory = (clientId, options = {}) => {
    const { limit = 50, offset = 0 } = options;

    const sql = `
      SELECT id, order_id, notification_type, status, recipient_email, sent_at
      FROM virtual_fulfillment_notifications
      WHERE client_id = ?
      ORDER BY sent_at DESC
      LIMIT ? OFFSET ?
    `;

    return db.prepare(sql).all(clientId, limit, offset);
  };

  /**
   * Create notifications table if not exists
   */
  const ensureNotificationsTable = () => {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS virtual_fulfillment_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT NOT NULL,
          order_id TEXT,
          notification_type TEXT NOT NULL,
          status TEXT DEFAULT 'sent',
          recipient_email TEXT,
          sent_at TEXT NOT NULL,
          FOREIGN KEY (client_id) REFERENCES client_config(client_id),
          FOREIGN KEY (order_id) REFERENCES orders(id)
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_client ON virtual_fulfillment_notifications(client_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_sent_at ON virtual_fulfillment_notifications(sent_at);
      `);
    } catch (err) {
      // Table might already exist
    }
  };

  // Ensure table exists on module creation
  ensureNotificationsTable();

  return {
    notifyOrderApproved,
    sendDailyPendingReminder,
    sendPastDueAlert,
    getNotificationHistory
  };
};
