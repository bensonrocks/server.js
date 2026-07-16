'use strict';

/**
 * Analytics Engine
 * Generates insights and metrics for order processing, fulfillment, and platform performance
 */
module.exports = function createAnalytics(db) {

  const getDashboardMetrics = (params = {}) => {
    const { startDate, endDate, platform = null } = params;

    const dateFilter = buildDateFilter(startDate, endDate);

    // Orders metrics
    const orders = getOrderMetrics(dateFilter, platform);

    // Fulfillment metrics
    const fulfillment = getFulfillmentMetrics(dateFilter, platform);

    // Platform metrics
    const platforms = getPlatformMetrics(dateFilter);

    // Inventory metrics
    const inventory = getInventoryMetrics();

    // Returns metrics
    const returns = getReturnsMetrics(dateFilter);

    return {
      period: { startDate, endDate },
      orders,
      fulfillment,
      platforms,
      inventory,
      returns,
      generated: new Date().toISOString(),
    };
  };

  const getOrderMetrics = (dateFilter, platform) => {
    let sql = `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'packed' THEN 1 ELSE 0 END) as packed,
        SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) as shipped,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        0 as avg_processing_time_days
      FROM orders
      WHERE 1=1
    `;
    const params = [];

    if (dateFilter) {
      sql += dateFilter.sql;
      params.push(...dateFilter.params);
    }

    if (platform) {
      sql += ' AND external_order_source = ?';
      params.push(platform);
    }

    const metrics = db.prepare(sql).get(...params);

    return {
      total: metrics.total || 0,
      byStatus: {
        pending: metrics.pending || 0,
        confirmed: metrics.confirmed || 0,
        processing: metrics.processing || 0,
        packed: metrics.packed || 0,
        shipped: metrics.shipped || 0,
        delivered: metrics.delivered || 0,
        cancelled: metrics.cancelled || 0,
      },
      avgProcessingTime: metrics.avg_processing_time_days || 0,
      fulfillmentRate: metrics.total ? Math.round((metrics.shipped / metrics.total) * 100) : 0,
    };
  };

  const getFulfillmentMetrics = (dateFilter) => {
    let sql = `
      SELECT
        COUNT(DISTINCT o.id) as orders_processed,
        COUNT(DISTINCT CASE WHEN o.status = 'shipped' THEN o.id END) as orders_shipped,
        SUM(ol.ordered_qty) as items_ordered,
        SUM(ol.picked_qty) as items_picked,
        SUM(ol.picked_qty) / SUM(ol.ordered_qty) as pick_accuracy,
        0 as avg_fulfillment_time_days
      FROM orders o
      LEFT JOIN order_lines ol ON o.id = ol.order_id
      WHERE o.status IN ('packed', 'shipped', 'delivered')
    `;
    const params = [];

    if (dateFilter) {
      sql += dateFilter.sql;
      params.push(...dateFilter.params);
    }

    const metrics = db.prepare(sql).get(...params);

    return {
      ordersProcessed: metrics.orders_processed || 0,
      ordersShipped: metrics.orders_shipped || 0,
      itemsOrdered: metrics.items_ordered || 0,
      itemsPicked: metrics.items_picked || 0,
      pickAccuracy: metrics.pick_accuracy ? Math.round(metrics.pick_accuracy * 10000) / 100 : 100,
      avgFulfillmentTime: metrics.avg_fulfillment_time_days || 0,
    };
  };

  const getPlatformMetrics = (dateFilter) => {
    let sql = `
      SELECT
        external_order_source as platform,
        COUNT(*) as order_count,
        SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) as shipped,
        0 as avg_time_days
      FROM orders
      WHERE external_order_source IS NOT NULL
    `;
    const params = [];

    if (dateFilter) {
      sql += dateFilter.sql;
      params.push(...dateFilter.params);
    }

    sql += ' GROUP BY external_order_source ORDER BY order_count DESC';

    const platforms = db.prepare(sql).all(...params);

    return platforms.map(p => ({
      platform: p.platform || 'direct',
      orders: p.order_count || 0,
      shipped: p.shipped || 0,
      fulfillmentRate: p.order_count ? Math.round((p.shipped / p.order_count) * 100) : 0,
      avgFulfillmentTime: p.avg_time_days || 0,
    }));
  };

  const getInventoryMetrics = () => {
    const total = db.prepare(`
      SELECT SUM(total_qty) as qty FROM inventory_balance
    `).get();

    const available = db.prepare(`
      SELECT SUM(available_qty) as qty FROM inventory_balance
    `).get();

    const lowStock = db.prepare(`
      SELECT COUNT(*) as count FROM inventory_balance
      WHERE available_qty <= 10
    `).get();

    const outOfStock = db.prepare(`
      SELECT COUNT(*) as count FROM inventory_balance
      WHERE available_qty = 0
    `).get();

    return {
      totalUnits: total?.qty || 0,
      availableUnits: available?.qty || 0,
      allocatedUnits: (total?.qty || 0) - (available?.qty || 0),
      skusLowStock: lowStock?.count || 0,
      skusOutOfStock: outOfStock?.count || 0,
    };
  };

  const getReturnsMetrics = (dateFilter) => {
    let sql = `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) as received,
        SUM(CASE WHEN status = 'inspected' THEN 1 ELSE 0 END) as inspected,
        SUM(CASE WHEN status LIKE 'approved%' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'restocked' THEN 1 ELSE 0 END) as restocked,
        SUM(CASE WHEN status = 'disposed' THEN 1 ELSE 0 END) as disposed
      FROM returns
      WHERE 1=1
    `;
    const params = [];

    if (dateFilter) {
      sql += dateFilter.sql;
      params.push(...dateFilter.params);
    }

    const metrics = db.prepare(sql).get(...params);

    return {
      total: metrics.total || 0,
      byStatus: {
        received: metrics.received || 0,
        inspected: metrics.inspected || 0,
        approved: metrics.approved || 0,
        restocked: metrics.restocked || 0,
        disposed: metrics.disposed || 0,
      },
      restockRate: metrics.total ? Math.round(((metrics.restocked || 0) / metrics.total) * 100) : 0,
    };
  };

  const getSalesbyPlatform = (params = {}) => {
    const { startDate, endDate } = params;
    const dateFilter = buildDateFilter(startDate, endDate);

    let sql = `
      SELECT
        o.external_order_source as platform,
        COUNT(o.id) as orders,
        ROUND(SUM(COALESCE((SELECT SUM(ordered_qty * unit_price) FROM order_lines WHERE order_id = o.id), 0)), 2) as revenue
      FROM orders o
      WHERE 1=1
    `;
    const params_arr = [];

    if (dateFilter) {
      sql += dateFilter.sql;
      params_arr.push(...dateFilter.params);
    }

    sql += ' GROUP BY o.external_order_source ORDER BY revenue DESC';

    return db.prepare(sql).all(...params_arr);
  };

  const getTrendData = (params = {}) => {
    const { days = 30, metric = 'orders' } = params;

    let sql = `
      SELECT
        DATE(created_at) as date,
        COUNT(*) as count
      FROM orders
      WHERE created_at >= datetime('now', ? || ' days')
    `;

    if (metric === 'revenue') {
      sql = `
        SELECT
          DATE(o.created_at) as date,
          ROUND(SUM(COALESCE((SELECT SUM(ordered_qty * unit_price) FROM order_lines WHERE order_id = o.id), 0)), 2) as count
        FROM orders o
        WHERE o.created_at >= datetime('now', ? || ' days')
        GROUP BY DATE(o.created_at)
      `;
    }

    sql += ' GROUP BY DATE(created_at) ORDER BY date ASC';

    return db.prepare(sql).all(-days);
  };

  const getWarehouseMetrics = () => {
    const warehouses = db.prepare(`
      SELECT id, name FROM warehouses WHERE is_active = 1
    `).all();

    const metrics = [];

    for (const wh of warehouses) {
      const stats = db.prepare(`
        SELECT
          COUNT(DISTINCT id) as orders_processed,
          SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) as orders_shipped,
          0 as avg_time
        FROM orders
        WHERE warehouse_id = ? AND status IN ('packed', 'shipped', 'delivered')
      `).get(wh.id);

      const inventory = db.prepare(`
        SELECT SUM(total_qty) as total, SUM(available_qty) as available
        FROM inventory_balance
        WHERE warehouse_id = ?
      `).get(wh.id);

      metrics.push({
        warehouse: wh.name,
        ordersProcessed: stats?.orders_processed || 0,
        ordersShipped: stats?.orders_shipped || 0,
        inventory: {
          total: inventory?.total || 0,
          available: inventory?.available || 0,
        },
        avgFulfillmentTime: stats?.avg_time || 0,
      });
    }

    return metrics;
  };

  const buildDateFilter = (startDate, endDate) => {
    if (!startDate && !endDate) return null;

    let sql = '';
    let params = [];

    if (startDate) {
      sql += ' AND created_at >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND created_at <= ?';
      params.push(endDate);
    }

    return { sql, params };
  };

  return {
    getDashboardMetrics,
    getOrderMetrics,
    getFulfillmentMetrics,
    getPlatformMetrics,
    getInventoryMetrics,
    getReturnsMetrics,
    getSalesbyPlatform,
    getTrendData,
    getWarehouseMetrics,
  };
};
