'use strict';

/**
 * Inventory Forecasting
 * Predicts stock needs based on order patterns and platform trends
 */
module.exports = function createInventoryForecast(db) {

  const forecastDemand = (params) => {
    const { skuId, days = 30, method = 'moving_average' } = params;

    const sku = db.prepare('SELECT * FROM skus WHERE id = ?').get(skuId);
    if (!sku) throw new Error('SKU not found');

    // Get historical orders
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90); // Look back 90 days

    const history = db.prepare(`
      SELECT DATE(ol.created_at) as order_date, SUM(ol.ordered_qty) as qty
      FROM order_lines ol
      WHERE ol.sku_id = ? AND ol.created_at >= ?
      GROUP BY DATE(ol.created_at)
      ORDER BY order_date ASC
    `).all(skuId, cutoffDate.toISOString());

    if (history.length === 0) {
      return {
        sku: sku.code,
        forecast: 'insufficient_data',
        message: 'Not enough historical data for forecast',
      };
    }

    let forecast = [];

    if (method === 'moving_average') {
      forecast = forecastMovingAverage(history, days);
    } else if (method === 'exponential_smoothing') {
      forecast = forecastExponentialSmoothing(history, days);
    } else if (method === 'seasonal') {
      forecast = forecastSeasonal(history, days);
    }

    // Get current stock
    const stock = db.prepare(`
      SELECT SUM(available_qty) as available, SUM(total_qty) as total
      FROM inventory_balance
      WHERE sku_id = ?
    `).get(skuId);

    // Calculate safety stock and reorder point
    const avgDaily = forecast.reduce((a, b) => a + b.qty, 0) / forecast.length;
    const safetyStock = Math.ceil(avgDaily * 7); // 7 days buffer
    const reorderPoint = Math.ceil(avgDaily * 14); // Reorder when 14 days supply left

    const currentStock = stock?.available || 0;
    const recommendedOrder = Math.max(0, reorderPoint - currentStock + avgDaily * 30);

    return {
      sku: sku.code,
      method,
      historicalDays: history.length,
      avgDaily: Math.round(avgDaily * 100) / 100,
      forecast: forecast.slice(0, days),
      metrics: {
        currentStock,
        safetyStock,
        reorderPoint,
        recommendedOrderQty: Math.ceil(recommendedOrder),
        status: currentStock < safetyStock ? 'low_stock' : 'ok',
      },
    };
  };

  const forecastByPlatform = (params) => {
    const { platform, days = 30 } = params;

    const orders = db.prepare(`
      SELECT o.external_order_source as source, DATE(o.created_at) as order_date, COUNT(*) as order_count, SUM(oi.total) as revenue
      FROM orders o
      JOIN (SELECT order_id, SUM(ordered_qty * unit_price) as total FROM order_lines) oi ON o.id = oi.order_id
      WHERE (? IS NULL OR o.external_order_source = ?)
      AND o.created_at >= datetime('now', '-90 days')
      GROUP BY DATE(o.created_at), o.external_order_source
      ORDER BY order_date ASC
    `).all(platform || null, platform);

    const platformStats = {};
    for (const order of orders) {
      if (!platformStats[order.source]) {
        platformStats[order.source] = {
          platform: order.source,
          dates: [],
          counts: [],
          revenue: [],
        };
      }
      platformStats[order.source].dates.push(order.order_date);
      platformStats[order.source].counts.push(order.order_count);
      platformStats[order.source].revenue.push(order.revenue);
    }

    const forecasts = {};
    for (const [src, data] of Object.entries(platformStats)) {
      const avgOrders = data.counts.reduce((a, b) => a + b, 0) / data.counts.length;
      const avgRevenue = data.revenue.reduce((a, b) => a + (b || 0), 0) / data.revenue.length;
      const trend = calculateTrend(data.counts);

      forecasts[src] = {
        platform: src,
        avgOrdersPerDay: Math.round(avgOrders * 100) / 100,
        avgRevenuePerDay: Math.round(avgRevenue * 100) / 100,
        trend: trend > 0 ? 'increasing' : trend < 0 ? 'decreasing' : 'stable',
        projectedOrders30d: Math.ceil(avgOrders * days * (1 + trend / 100)),
        projectedRevenue30d: Math.ceil(avgRevenue * days * (1 + trend / 100)),
      };
    }

    return {
      period: days,
      platforms: forecasts,
    };
  };

  const forecastInventoryGap = () => {
    // Find SKUs that might run out based on current velocity
    const skus = db.prepare(`
      SELECT s.id, s.code, s.name,
             SUM(ib.available_qty) as current_stock,
             SUM(ib.total_qty) as total_stock
      FROM skus s
      LEFT JOIN inventory_balance ib ON s.id = ib.sku_id
      GROUP BY s.id
    `).all();

    const gaps = [];

    for (const sku of skus) {
      // Get average daily demand
      const demand = db.prepare(`
        SELECT AVG(daily_qty) as avg_daily
        FROM (
          SELECT DATE(ol.created_at) as order_date, SUM(ol.ordered_qty) as daily_qty
          FROM order_lines ol
          WHERE ol.sku_id = ? AND ol.created_at >= datetime('now', '-30 days')
          GROUP BY DATE(ol.created_at)
        )
      `).get(sku.id);

      const avgDaily = demand?.avg_daily || 0;
      const currentStock = sku.current_stock || 0;

      if (avgDaily > 0) {
        const daysLeft = Math.floor(currentStock / avgDaily);
        const status = daysLeft < 7 ? 'critical' : daysLeft < 14 ? 'warning' : 'ok';

        if (status !== 'ok') {
          gaps.push({
            sku: sku.code,
            name: sku.name,
            currentStock,
            avgDailyDemand: Math.round(avgDaily * 100) / 100,
            daysLeft,
            status,
            recommendedQty: Math.ceil(avgDaily * 30),
          });
        }
      }
    }

    return gaps.sort((a, b) => a.daysLeft - b.daysLeft);
  };

  const forecastMovingAverage = (history, days) => {
    const window = Math.ceil(history.length / 3);
    const forecast = [];

    for (let i = 0; i < days; i++) {
      const startIdx = Math.max(0, history.length - window - days + i);
      const endIdx = history.length - days + i;
      const slice = history.slice(startIdx, Math.max(startIdx + 1, endIdx));

      const avg = slice.reduce((a, b) => a + b.qty, 0) / slice.length;
      const forecastDate = new Date();
      forecastDate.setDate(forecastDate.getDate() + i + 1);

      forecast.push({
        date: forecastDate.toISOString().split('T')[0],
        qty: Math.round(avg),
      });
    }

    return forecast;
  };

  const forecastExponentialSmoothing = (history, days) => {
    const alpha = 0.3; // Smoothing factor
    const forecast = [];

    let level = history[0]?.qty || 0;

    for (let i = 0; i < days; i++) {
      forecast.push({
        date: new Date(new Date().getTime() + i * 86400000).toISOString().split('T')[0],
        qty: Math.round(level),
      });

      // Update level with next historical data if available
      if (i < history.length - 1) {
        level = alpha * history[i].qty + (1 - alpha) * level;
      }
    }

    return forecast;
  };

  const forecastSeasonal = (history, days) => {
    // Group by day of week to detect weekly patterns
    const byDayOfWeek = [0, 0, 0, 0, 0, 0, 0];
    const dayCount = [0, 0, 0, 0, 0, 0, 0];

    for (const h of history) {
      const date = new Date(h.order_date);
      const dow = date.getDay();
      byDayOfWeek[dow] += h.qty;
      dayCount[dow]++;
    }

    const avgByDow = byDayOfWeek.map((qty, idx) => dayCount[idx] > 0 ? qty / dayCount[idx] : 0);

    const forecast = [];
    const startDate = new Date();

    for (let i = 0; i < days; i++) {
      const forecastDate = new Date(startDate.getTime() + i * 86400000);
      const dow = forecastDate.getDay();
      const qty = Math.round(avgByDow[dow]);

      forecast.push({
        date: forecastDate.toISOString().split('T')[0],
        qty,
      });
    }

    return forecast;
  };

  const calculateTrend = (values) => {
    if (values.length < 2) return 0;

    const n = values.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const xMean = x.reduce((a, b) => a + b) / n;
    const yMean = values.reduce((a, b) => a + b) / n;

    const numerator = x.reduce((sum, xi, i) => sum + (xi - xMean) * (values[i] - yMean), 0);
    const denominator = x.reduce((sum, xi) => sum + (xi - xMean) ** 2, 0);

    return denominator === 0 ? 0 : (numerator / denominator) * 100;
  };

  return {
    forecastDemand,
    forecastByPlatform,
    forecastInventoryGap,
  };
};
