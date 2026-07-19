'use strict';

/**
 * Client Analytics Engine
 * Provides top sellers, least movement, inventory health, and fulfillment metrics
 */
module.exports = function createClientAnalytics(db) {
  /**
   * Get top sellers by SKU (revenue or quantity)
   */
  const getTopSellers = (clientId, options = {}) => {
    const { sortBy = 'revenue', limit = 10, days = 30 } = options;
    const dateThreshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let sql = `
      SELECT
        ol.sku_code as sku,
        ol.sku_name as name,
        COUNT(DISTINCT ol.order_id) as orders_count,
        SUM(ol.ordered_qty) as total_qty,
        ROUND(SUM(ol.ordered_qty * ol.unit_price), 2) as total_revenue,
        ROUND(AVG(ol.unit_price), 2) as avg_price
      FROM order_lines ol
      JOIN orders o ON ol.order_id = o.id
      WHERE o.client_id = ?
        AND o.status IN ('shipped', 'delivered', 'processing', 'packed')
        AND o.created_at >= ?
      GROUP BY ol.sku_code, ol.sku_name
    `;

    if (sortBy === 'revenue') {
      sql += ` ORDER BY total_revenue DESC`;
    } else if (sortBy === 'quantity') {
      sql += ` ORDER BY total_qty DESC`;
    } else {
      sql += ` ORDER BY orders_count DESC`;
    }

    sql += ` LIMIT ?`;

    const results = db.prepare(sql).all(clientId, dateThreshold, limit);

    return results.map(row => ({
      sku: row.sku,
      name: row.name,
      ordersCount: row.orders_count,
      totalQty: row.total_qty,
      totalRevenue: row.total_revenue,
      avgPrice: row.avg_price
    }));
  };

  /**
   * Get least movement (slow-moving inventory)
   */
  const getLeastMovement = (clientId, options = {}) => {
    const { minDays = 30, limit = 10 } = options;
    const dateThreshold = new Date(Date.now() - minDays * 24 * 60 * 60 * 1000).toISOString();

    const sql = `
      SELECT
        ol.sku_code as sku,
        ol.sku_name as name,
        COUNT(DISTINCT ol.order_id) as orders_count,
        SUM(ol.ordered_qty) as total_qty,
        ROUND(AVG(ol.unit_price), 2) as avg_price,
        MAX(o.created_at) as last_order_date
      FROM order_lines ol
      JOIN orders o ON ol.order_id = o.id
      WHERE o.client_id = ?
      GROUP BY ol.sku_code, ol.sku_name
      HAVING COUNT(DISTINCT ol.order_id) = 0
          OR MAX(o.created_at) < ?
      ORDER BY total_qty ASC, orders_count ASC
      LIMIT ?
    `;

    const results = db.prepare(sql).all(clientId, dateThreshold, limit);

    return results.map(row => ({
      sku: row.sku,
      name: row.name,
      ordersCount: row.orders_count || 0,
      totalQty: row.total_qty || 0,
      avgPrice: row.avg_price || 0,
      lastOrderDate: row.last_order_date || null,
      daysSinceLast: row.last_order_date
        ? Math.floor((Date.now() - new Date(row.last_order_date).getTime()) / (24 * 60 * 60 * 1000))
        : null
    }));
  };

  /**
   * Get inventory health metrics
   */
  const getInventoryMetrics = (clientId, options = {}) => {
    const { days = 30 } = options;
    const dateThreshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Calculate turnover: units sold / avg inventory value
    const turnoverSql = `
      SELECT
        COUNT(DISTINCT ol.sku_code) as sku_count,
        SUM(ol.ordered_qty) as total_units_sold,
        ROUND(AVG(ol.unit_price), 2) as avg_price,
        ROUND(SUM(ol.ordered_qty * ol.unit_price), 2) as total_revenue
      FROM order_lines ol
      JOIN orders o ON ol.order_id = o.id
      WHERE o.client_id = ?
        AND o.status IN ('shipped', 'delivered', 'processing', 'packed')
        AND o.created_at >= ?
    `;

    const turnoverData = db.prepare(turnoverSql).get(clientId, dateThreshold);

    // Count low-stock and out-of-stock items
    const lowStockSql = `
      SELECT
        COUNT(CASE WHEN (stock_qty - reserved_qty) <= reorder_point THEN 1 END) as low_stock_count,
        COUNT(CASE WHEN (stock_qty - reserved_qty) <= 0 THEN 1 END) as out_of_stock_count,
        COUNT(*) as total_skus
      FROM inventory
      WHERE client_id = ?
    `;

    const stockData = db.prepare(lowStockSql).get(clientId);

    return {
      summary: {
        skuCount: turnoverData.sku_count || 0,
        totalUnitsSold: turnoverData.total_units_sold || 0,
        totalRevenue: turnoverData.total_revenue || 0
      },
      stock: {
        lowStockCount: stockData.low_stock_count || 0,
        outOfStockCount: stockData.out_of_stock_count || 0,
        totalSkus: stockData.total_skus || 0
      },
      health: {
        healthScore: calculateHealthScore(stockData),
        alerts: generateInventoryAlerts(stockData)
      },
      period: { days, dateThreshold }
    };
  };

  /**
   * Get fulfillment performance metrics
   */
  const getFulfillmentMetrics = (clientId, options = {}) => {
    const { days = 30 } = options;
    const dateThreshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const sql = `
      SELECT
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'shipped' OR status = 'delivered' THEN 1 END) as shipped_orders,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
        COUNT(CASE WHEN status = 'processing' OR status = 'packed' THEN 1 END) as in_fulfillment,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_orders,
        ROUND(AVG(CAST((julianday(shipped_at) - julianday(created_at)) AS INTEGER)), 1) as avg_processing_days
      FROM orders
      WHERE client_id = ? AND created_at >= ?
    `;

    const data = db.prepare(sql).get(clientId, dateThreshold);

    const totalOrders = data.total_orders || 0;
    const shippedOrders = data.shipped_orders || 0;
    const onTimeRate = totalOrders > 0 ? Math.round((shippedOrders / totalOrders) * 100) : 0;
    const cancellationRate = totalOrders > 0 ? Math.round((data.cancelled_orders / totalOrders) * 100) : 0;

    return {
      summary: {
        totalOrders,
        shippedOrders,
        pendingOrders: data.pending_orders || 0,
        inFulfillment: data.in_fulfillment || 0,
        cancelledOrders: data.cancelled_orders || 0
      },
      rates: {
        onTimeRate: `${onTimeRate}%`,
        fulfillmentRate: `${Math.round(((shippedOrders + data.in_fulfillment) / totalOrders) * 100)}%`,
        cancellationRate: `${cancellationRate}%`
      },
      performance: {
        avgProcessingDays: data.avg_processing_days || 0,
        avgOrderValue: calculateAvgOrderValue(clientId, dateThreshold)
      },
      period: { days, dateThreshold }
    };
  };

  /**
   * Get channel performance comparison
   */
  const getChannelPerformance = (clientId, options = {}) => {
    const { days = 30 } = options;
    const dateThreshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const sql = `
      SELECT
        channel,
        COUNT(*) as order_count,
        ROUND(SUM(total), 2) as total_revenue,
        ROUND(AVG(total), 2) as avg_order_value,
        COUNT(CASE WHEN status = 'shipped' OR status = 'delivered' THEN 1 END) as fulfilled_count
      FROM orders
      WHERE client_id = ? AND created_at >= ?
      GROUP BY channel
      ORDER BY total_revenue DESC
    `;

    const results = db.prepare(sql).all(clientId, dateThreshold);

    return results.map(row => ({
      channel: row.channel,
      orderCount: row.order_count,
      totalRevenue: row.total_revenue,
      avgOrderValue: row.avg_order_value,
      fulfilledCount: row.fulfilled_count,
      fulfillmentRate: row.order_count > 0 ? `${Math.round((row.fulfilled_count / row.order_count) * 100)}%` : '0%'
    }));
  };

  // ── Helper Functions ──────────────────────────────────────────────────────

  function calculateHealthScore(stockData) {
    const totalSkus = stockData.total_skus || 1;
    const outOfStock = stockData.out_of_stock_count || 0;
    const lowStock = stockData.low_stock_count || 0;

    const oosRatio = outOfStock / totalSkus;
    const lowRatio = lowStock / totalSkus;

    if (oosRatio > 0.1) return 'Critical';
    if (oosRatio > 0.05 || lowRatio > 0.2) return 'Warning';
    if (lowRatio > 0.1) return 'Caution';
    return 'Healthy';
  }

  function generateInventoryAlerts(stockData) {
    const alerts = [];

    if (stockData.out_of_stock_count > 0) {
      alerts.push({
        level: 'critical',
        message: `${stockData.out_of_stock_count} items out of stock`
      });
    }

    if (stockData.low_stock_count > 0) {
      alerts.push({
        level: 'warning',
        message: `${stockData.low_stock_count} items below reorder point`
      });
    }

    if (alerts.length === 0) {
      alerts.push({
        level: 'info',
        message: 'Inventory levels healthy'
      });
    }

    return alerts;
  }

  function calculateAvgOrderValue(clientId, dateThreshold) {
    const result = db.prepare(`
      SELECT ROUND(AVG(total), 2) as avg_value
      FROM orders
      WHERE client_id = ? AND created_at >= ?
    `).get(clientId, dateThreshold);

    return result.avg_value || 0;
  }

  return {
    getTopSellers,
    getLeastMovement,
    getInventoryMetrics,
    getFulfillmentMetrics,
    getChannelPerformance
  };
};
