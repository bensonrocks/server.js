'use strict';

const crypto = require('crypto');

/**
 * Generic Order Sync Service
 * Syncs orders from any platform adapter into IDEALONE
 * Platform-agnostic: works with ZORT, Shopee, Lazada, TikTok, Shopify, or your own API
 */
module.exports = function createOrderSync(ideaOneDb) {
  /**
   * Sync orders from any source
   * @param {Object} params
   * @param {string} params.tenantId - Tenant ID in IDEALONE
   * @param {string} params.source - Source: zort, shopee, lazada, tiktok, shopify
   * @param {string} params.platform - Platform: same as source or specific marketplace
   * @param {Array} params.orders - Array of StandardOrder objects
   * @param {string} params.userId - User performing sync
   * @returns {Object} { created, updated, failed, errors }
   */
  const syncOrders = async (params) => {
    const { tenantId, source, platform, orders, userId } = params;

    if (!tenantId || !source || !orders || !Array.isArray(orders)) {
      throw new Error('tenantId, source, and orders[] are required');
    }

    const results = {
      created: 0,
      updated: 0,
      failed: 0,
      errors: [],
      orders: [],
    };

    for (const order of orders) {
      try {
        const result = await syncSingleOrder({
          tenantId,
          source,
          platform: platform || order.platform,
          order,
          userId,
        });
        if (result.created) results.created++;
        if (result.updated) results.updated++;
        results.orders.push(result);
      } catch (err) {
        results.failed++;
        results.errors.push({
          externalOrderId: order.externalOrderId,
          error: err.message,
        });
        console.error(`Order sync failed for ${order.externalOrderId}:`, err.message);
      }
    }

    return results;
  };

  /**
   * Sync a single order
   */
  const syncSingleOrder = async ({ tenantId, source, platform, order, userId }) => {
    // Check for duplicate (idempotency)
    const existing = ideaOneDb.prepare(`
      SELECT id, status FROM orders
      WHERE tenant_id = ? AND external_order_number = ? AND external_order_source = ?
      LIMIT 1
    `).get(tenantId, order.externalOrderId, source);

    if (existing) {
      // Order already imported — skip to avoid duplicates
      return {
        created: false,
        updated: false,
        orderId: existing.id,
        status: 'duplicate_skipped',
        externalOrderId: order.externalOrderId,
      };
    }

    // Map SKU codes to IDs in IDEALONE
    const skuCodeToId = {};
    for (const line of order.lines) {
      if (!skuCodeToId[line.sku]) {
        const sku = ideaOneDb.prepare(`
          SELECT id FROM skus
          WHERE tenant_id = ? AND code = ?
          LIMIT 1
        `).get(tenantId, line.sku);

        if (!sku) {
          throw new Error(`SKU not found: ${line.sku}`);
        }
        skuCodeToId[line.sku] = sku.id;
      }
    }

    // Determine client_id (customer)
    let clientId = order.clientId;
    if (!clientId) {
      // Try to find or create customer
      const customer = ideaOneDb.prepare(`
        SELECT id FROM clients
        WHERE tenant_id = ? AND email = ?
        LIMIT 1
      `).get(tenantId, order.customerEmail || order.customerName);

      if (customer) {
        clientId = customer.id;
      } else {
        // Create new customer if doesn't exist
        clientId = crypto.randomUUID();
        ideaOneDb.prepare(`
          INSERT INTO clients (id, tenant_id, name, email, phone)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          clientId,
          tenantId,
          order.customerName || 'Unknown Customer',
          order.customerEmail || null,
          order.customerPhone || null
        );
      }
    }

    // Create order in IDEALONE
    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();

    ideaOneDb.prepare(`
      INSERT INTO orders (
        id, tenant_id, client_id, order_number,
        external_order_id, external_order_number, external_order_source,
        status, order_type, fulfilment_profile,
        delivery_address, special_instructions,
        warehouse_id, ordered_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      orderId,
      tenantId,
      clientId,
      `ORD-${Date.now()}`,
      order.externalOrderId,
      order.externalOrderNumber || order.externalOrderId,
      source, // Store which source this came from
      order.status || 'pending',
      'B2C_STANDARD', // Default order type
      'B2C_STANDARD',
      JSON.stringify(order.shippingAddress || {}),
      order.notes || '',
      order.warehouseId || null,
      order.orderDate || now,
      now,
      now
    );

    // Create order lines
    let lineNum = 1;
    for (const line of order.lines) {
      const lineId = crypto.randomUUID();
      const skuId = skuCodeToId[line.sku];

      ideaOneDb.prepare(`
        INSERT INTO order_lines (
          id, tenant_id, order_id, line_number,
          sku_id, sku_code, sku_name,
          ordered_qty, unit_price,
          allocated_qty, picked_qty,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?,
          ?, ?
        )
      `).run(
        lineId,
        tenantId,
        orderId,
        lineNum,
        skuId,
        line.sku,
        line.sku, // Will be updated with proper name
        line.quantity,
        line.unitPrice,
        0, // allocated_qty starts at 0
        0, // picked_qty starts at 0
        now,
        now
      );

      lineNum++;
    }

    // Store order sync metadata for audit trail
    ideaOneDb.prepare(`
      INSERT INTO sync_log (
        id, tenant_id, order_id,
        source_platform, source_system,
        external_order_id, sync_status,
        sync_timestamp, sync_user_id,
        raw_data
      ) VALUES (
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?
      )
    `).run(
      crypto.randomUUID(),
      tenantId,
      orderId,
      platform,
      source,
      order.externalOrderId,
      'imported',
      now,
      userId || 'system',
      JSON.stringify(order.metadata || {})
    );

    return {
      created: true,
      updated: false,
      orderId,
      status: 'imported',
      externalOrderId: order.externalOrderId,
      skuCount: order.lines.length,
    };
  };

  /**
   * Auto-allocate orders (transition to ALLOCATED status)
   * Call this after syncing if you want auto-allocation
   */
  const autoAllocateNewOrders = async (tenantId, source) => {
    const newOrders = ideaOneDb.prepare(`
      SELECT id, warehouse_id FROM orders
      WHERE tenant_id = ? AND external_order_source = ? AND status = 'pending'
      LIMIT 100
    `).all(tenantId, source);

    let allocated = 0;
    for (const order of newOrders) {
      try {
        // Get order lines
        const lines = ideaOneDb.prepare(`
          SELECT id, sku_id, sku_code, ordered_qty
          FROM order_lines
          WHERE order_id = ?
        `).all(order.id);

        // Call IDEALONE API to allocate
        // This would be: PUT /orders/:id/transition with status=ALLOCATED
        // For now, just log
        console.log(`Auto-allocating order ${order.id} from ${source}`);
        allocated++;
      } catch (err) {
        console.error(`Auto-allocation failed for order ${order.id}:`, err.message);
      }
    }

    return { allocated };
  };

  return {
    syncOrders,
    syncSingleOrder,
    autoAllocateNewOrders,
  };
};
