'use strict';

const crypto = require('crypto');

/**
 * Webhook Handler Service
 * Receives and processes webhook events from external platforms
 * Verifies signatures and handles order status updates
 */
module.exports = function createWebhookHandler(ideaOneDb) {
  /**
   * Verify webhook signature
   * Each platform has different signature verification logic
   */
  const verifySignature = (platform, payload, signature, secret) => {
    if (!signature || !secret) {
      console.warn(`[Webhook] No signature/secret provided for ${platform}`);
      return false;
    }

    try {
      let expectedSignature;

      switch (platform) {
        case 'shopee':
          // Shopee: HMAC-SHA256
          expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex');
          break;

        case 'lazada':
          // Lazada: SHA256 of payload
          expectedSignature = crypto
            .createHash('sha256')
            .update(payload + secret)
            .digest('hex');
          break;

        case 'tiktok':
          // TikTok: HMAC-SHA256
          expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex');
          break;

        case 'shopify':
          // Shopify: HMAC-SHA256
          expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('base64');
          break;

        default:
          return false;
      }

      // Pad signatures to same length before comparison
      const sigBuf = Buffer.from(signature, 'hex');
      const expBuf = Buffer.from(expectedSignature, 'hex');

      // If lengths differ, they're not equal
      if (sigBuf.length !== expBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(sigBuf, expBuf);
    } catch (err) {
      console.warn(`[Webhook] Signature verification error: ${err.message}`);
      return false;
    }
  };

  /**
   * Handle incoming webhook
   */
  const handleWebhook = async (platform, payload, signature, secret) => {
    try {
      // Verify signature
      if (!verifySignature(platform, JSON.stringify(payload), signature, secret)) {
        throw new Error('Signature verification failed');
      }

      // Parse webhook based on platform
      let event;
      switch (platform) {
        case 'shopee':
          event = parseShopeeWebhook(payload);
          break;
        case 'lazada':
          event = parseLazadaWebhook(payload);
          break;
        case 'tiktok':
          event = parseTikTokWebhook(payload);
          break;
        case 'shopify':
          event = parseShopifyWebhook(payload);
          break;
        default:
          throw new Error(`Unknown platform: ${platform}`);
      }

      if (!event) {
        return { processed: false, reason: 'Event type not tracked' };
      }

      // Process event
      const result = await processEvent(platform, event);

      // Log webhook
      logWebhook(platform, event.orderId, event.type, 'processed', result);

      return {
        processed: true,
        eventType: event.type,
        orderId: event.orderId,
        result,
      };
    } catch (err) {
      console.error(`[Webhook] Error processing ${platform} webhook:`, err.message);
      logWebhook(platform, payload.order_id || payload.orderId, 'error', 'failed', err.message);

      return {
        processed: false,
        error: err.message,
      };
    }
  };

  /**
   * Process webhook event
   */
  const processEvent = async (platform, event) => {
    const { orderId, type, status, trackingNumber } = event;

    // Find order by external_order_id
    const order = ideaOneDb.prepare(`
      SELECT id, external_order_id, status FROM orders
      WHERE external_order_id = ? AND external_order_source = ?
      LIMIT 1
    `).get(orderId, platform);

    if (!order) {
      throw new Error(`Order not found: ${orderId} from ${platform}`);
    }

    // Update order status
    if (type === 'status_change') {
      const now = new Date().toISOString();
      ideaOneDb.prepare(`
        UPDATE orders SET status = ?, updated_at = ?
        WHERE id = ?
      `).run(status, now, order.id);

      // Log status change
      ideaOneDb.prepare(`
        INSERT INTO order_status_log (
          id, tenant_id, order_id, from_status, to_status,
          source_platform, log_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        'tenant-1', // Would be extracted from order lookup
        order.id,
        order.status,
        status,
        platform,
        now
      );
    }

    // Update tracking information
    if (trackingNumber) {
      const now = new Date().toISOString();
      ideaOneDb.prepare(`
        UPDATE orders SET tracking_number = ?, updated_at = ?
        WHERE id = ?
      `).run(trackingNumber, now, order.id);
    }

    return { orderId, newStatus: status };
  };

  /**
   * Platform-specific webhook parsers
   */
  const parseShopeeWebhook = (payload) => {
    const { event } = payload;

    if (event === 'order_status_updated') {
      return {
        orderId: payload.data.order_sn,
        type: 'status_change',
        status: mapShopeeStatus(payload.data.order_status),
        trackingNumber: payload.data.tracking_number,
      };
    }

    return null;
  };

  const parseLazadaWebhook = (payload) => {
    const { event } = payload;

    if (event === 'OrderStatusUpdate') {
      return {
        orderId: payload.data.order_id,
        type: 'status_change',
        status: mapLazadaStatus(payload.data.order_status),
        trackingNumber: payload.data.tracking_number,
      };
    }

    return null;
  };

  const parseTikTokWebhook = (payload) => {
    const { event } = payload;

    if (event === 'ORDER_STATUS_CHANGE') {
      return {
        orderId: payload.data.order_id,
        type: 'status_change',
        status: mapTikTokStatus(payload.data.order_status),
        trackingNumber: payload.data.tracking_number,
      };
    }

    return null;
  };

  const parseShopifyWebhook = (payload) => {
    // Shopify uses topic header to identify event type
    const topic = payload.topic || 'order/updated';

    if (topic === 'orders/updated' || topic === 'order/updated') {
      return {
        orderId: String(payload.id),
        type: 'status_change',
        status: mapShopifyStatus(payload.fulfillment_status, payload.financial_status),
        trackingNumber: payload.fulfillments?.[0]?.tracking_info?.number,
      };
    }

    return null;
  };

  /**
   * Status mappers
   */
  const mapShopeeStatus = (status) => {
    const map = {
      'READY_TO_SHIP': 'confirmed',
      'SHIPPED': 'shipped',
      'DELIVERED': 'delivered',
      'CANCELLED': 'cancelled',
      'RETURNED': 'returned',
    };
    return map[status] || 'pending';
  };

  const mapLazadaStatus = (status) => {
    const map = {
      'ready_to_ship': 'confirmed',
      'shipped': 'shipped',
      'delivered': 'delivered',
      'cancelled': 'cancelled',
      'returned': 'returned',
    };
    return map[status] || 'pending';
  };

  const mapTikTokStatus = (status) => {
    const map = {
      'ORDER_PROCESSING': 'confirmed',
      'ORDER_PARTIALLY_SHIPPING': 'shipping',
      'ORDER_SHIPPED': 'shipped',
      'ORDER_DELIVERED': 'delivered',
      'ORDER_CANCELLED': 'cancelled',
      'ORDER_RETURNED': 'returned',
    };
    return map[status] || 'pending';
  };

  const mapShopifyStatus = (fulfillment, financial) => {
    const fulfillmentMap = {
      'fulfilled': 'shipped',
      'partial': 'shipping',
      'unshipped': 'confirmed',
      'cancelled': 'cancelled',
    };
    return fulfillmentMap[fulfillment] || 'pending';
  };

  /**
   * Log webhook for audit trail
   */
  const logWebhook = (platform, orderId, eventType, status, details) => {
    try {
      const logId = crypto.randomUUID();
      const now = new Date().toISOString();

      ideaOneDb.prepare(`
        INSERT INTO webhook_log (
          id, platform, external_order_id, event_type,
          process_status, details, logged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        logId,
        platform,
        orderId,
        eventType,
        status,
        typeof details === 'string' ? details : JSON.stringify(details),
        now
      );
    } catch (err) {
      console.error('[Webhook] Failed to log webhook:', err.message);
    }
  };

  /**
   * Fetch webhook log for debugging
   */
  const getWebhookLog = (platform, orderId, limit = 10) => {
    return ideaOneDb.prepare(`
      SELECT * FROM webhook_log
      WHERE platform = ? AND external_order_id = ?
      ORDER BY logged_at DESC
      LIMIT ?
    `).all(platform, orderId, limit);
  };

  return {
    handleWebhook,
    verifySignature,
    getWebhookLog,
  };
};
