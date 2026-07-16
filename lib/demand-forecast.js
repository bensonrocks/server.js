'use strict';

/**
 * Demand Forecasting Module
 * Predicts future demand using three algorithms:
 * 1. Moving Average (baseline)
 * 2. Exponential Smoothing (responsive to recent changes)
 * 3. Seasonal Decomposition (handles weekly/daily patterns)
 */
module.exports = function createDemandForecast(db) {

  /**
   * Moving Average Forecast
   * Baseline: average of last N days
   */
  const forecastMovingAverage = (skuId, days = 30, windowDays = 7) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const history = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as pick_count
      FROM inventory_movements
      WHERE sku_id = ? AND movement_type = 'picked'
      AND created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `).all(skuId, cutoffDate.toISOString());

    if (history.length === 0) {
      return { forecast: 0, confidence: 0, error: 'No historical data' };
    }

    // Average of last windowDays
    const recentWindow = history.slice(0, windowDays);
    const avgDemand = recentWindow.reduce((sum, h) => sum + h.pick_count, 0) / recentWindow.length;

    // Standard error for confidence
    const variance = recentWindow.reduce((sum, h) => sum + Math.pow(h.pick_count - avgDemand, 2), 0) / recentWindow.length;
    const stdDev = Math.sqrt(variance);
    const confidence = Math.max(0, 1 - (stdDev / (avgDemand + 1)));

    return {
      method: 'moving_average',
      skuId,
      historicalDays: history.length,
      averageDemand: Math.round(avgDemand * 100) / 100,
      forecast: Math.round(avgDemand),
      forecastWeekly: Math.round(avgDemand * 7),
      forecastMonthly: Math.round(avgDemand * 30),
      standardDeviation: Math.round(stdDev * 100) / 100,
      confidence: Math.round(confidence * 100),
      lowerBound: Math.max(0, Math.round((avgDemand - 2 * stdDev))),
      upperBound: Math.round(avgDemand + 2 * stdDev)
    };
  };

  /**
   * Exponential Smoothing Forecast
   * Recent data weighted more heavily
   * Responsive to trend changes
   */
  const forecastExponentialSmoothing = (skuId, days = 30, alpha = 0.3) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const history = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as pick_count
      FROM inventory_movements
      WHERE sku_id = ? AND movement_type = 'picked'
      AND created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).all(skuId, cutoffDate.toISOString());

    if (history.length === 0) {
      return { forecast: 0, confidence: 0, error: 'No historical data' };
    }

    // Initialize with first value
    let smoothed = history[0].pick_count;
    let errorSum = 0;

    // Apply exponential smoothing
    for (let i = 1; i < history.length; i++) {
      const actual = history[i].pick_count;
      const error = Math.abs(actual - smoothed);
      errorSum += error;

      smoothed = alpha * actual + (1 - alpha) * smoothed;
    }

    const mape = errorSum / history.length;  // Mean Absolute Percentage Error (simplified)
    const confidence = Math.max(0, 1 - (mape / (smoothed + 1)));

    return {
      method: 'exponential_smoothing',
      skuId,
      alpha,  // Smoothing factor
      historicalDays: history.length,
      forecast: Math.round(smoothed),
      forecastWeekly: Math.round(smoothed * 7),
      forecastMonthly: Math.round(smoothed * 30),
      meanAbsoluteError: Math.round(mape * 100) / 100,
      confidence: Math.round(confidence * 100),
      responsiveness: 'High (recent data emphasized)'
    };
  };

  /**
   * Seasonal Decomposition Forecast
   * Detects weekly/daily patterns
   */
  const forecastSeasonalDecomposition = (skuId, days = 60) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const history = db.prepare(`
      SELECT
        DATE(created_at) as date,
        CAST(strftime('%w', created_at) AS INTEGER) as day_of_week,
        COUNT(*) as pick_count
      FROM inventory_movements
      WHERE sku_id = ? AND movement_type = 'picked'
      AND created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).all(skuId, cutoffDate.toISOString());

    if (history.length < 14) {  // Need at least 2 weeks
      return { forecast: 0, confidence: 0, error: 'Insufficient data for seasonal analysis' };
    }

    // Group by day of week (0=Sunday, 6=Saturday)
    const dayOfWeekStats = {};
    for (let i = 0; i < 7; i++) dayOfWeekStats[i] = { values: [], sum: 0, count: 0 };

    history.forEach(h => {
      dayOfWeekStats[h.day_of_week].values.push(h.pick_count);
      dayOfWeekStats[h.day_of_week].sum += h.pick_count;
      dayOfWeekStats[h.day_of_week].count += 1;
    });

    // Calculate seasonal factors
    const overallAvg = history.reduce((sum, h) => sum + h.pick_count, 0) / history.length;
    const seasonalFactors = {};
    let confidence = 0;

    for (let i = 0; i < 7; i++) {
      if (dayOfWeekStats[i].count > 0) {
        const dayAvg = dayOfWeekStats[i].sum / dayOfWeekStats[i].count;
        seasonalFactors[i] = Math.round((dayAvg / overallAvg) * 100) / 100;
        confidence += dayOfWeekStats[i].count;
      }
    }

    confidence = Math.min(100, Math.round((confidence / history.length) * 100));

    // Forecast for each day of next week
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const forecast = {};
    for (let i = 0; i < 7; i++) {
      forecast[dayNames[i]] = Math.round(overallAvg * (seasonalFactors[i] || 1));
    }

    return {
      method: 'seasonal_decomposition',
      skuId,
      historicalDays: history.length,
      baselineDemand: Math.round(overallAvg),
      seasonalFactors,
      forecastByDay: forecast,
      forecastWeekly: Object.values(forecast).reduce((a, b) => a + b, 0),
      forecastMonthly: Object.values(forecast).reduce((a, b) => a + b, 0) * 4,
      confidence
    };
  };

  /**
   * Smart Forecast Selection
   * Chooses best method based on data quality
   */
  const forecastDemand = (skuId, days = 30, preferredMethod = 'auto') => {
    if (preferredMethod !== 'auto') {
      switch (preferredMethod) {
        case 'moving_average':
          return forecastMovingAverage(skuId, days);
        case 'exponential_smoothing':
          return forecastExponentialSmoothing(skuId, days);
        case 'seasonal':
          return forecastSeasonalDecomposition(skuId, days);
      }
    }

    // Auto-select based on data history
    const history = db.prepare(`
      SELECT COUNT(*) as count FROM inventory_movements
      WHERE sku_id = ? AND movement_type = 'picked'
    `).get(skuId);

    // Use seasonal decomposition if enough data (60+ days)
    if (history.count >= 60) {
      const seasonal = forecastSeasonalDecomposition(skuId, 60);
      if (seasonal.confidence >= 70) {
        return { ...seasonal, selectedReason: 'Seasonal patterns detected' };
      }
    }

    // Use exponential smoothing if moderate data (30+ days)
    if (history.count >= 30) {
      return {
        ...forecastExponentialSmoothing(skuId, days),
        selectedReason: 'Moderate history available'
      };
    }

    // Fall back to moving average
    return {
      ...forecastMovingAverage(skuId, days),
      selectedReason: 'Limited history, using baseline average'
    };
  };

  /**
   * Calculate reorder point and safety stock
   */
  const calculateReorderPoint = (skuId, leadTimeDays = 7, safetyStockDays = 7) => {
    const forecast = forecastDemand(skuId);

    if (forecast.error) {
      return { error: forecast.error, skuId };
    }

    const dailyDemand = forecast.forecast || 1;
    const reorderPoint = dailyDemand * leadTimeDays;
    const safetyStock = dailyDemand * safetyStockDays;
    const economicOrderQty = Math.ceil(Math.sqrt(2 * dailyDemand * 365 * 10 / 2));  // Simple EOQ

    // Get current inventory
    const current = db.prepare(`
      SELECT SUM(available_qty) as qty FROM inventory_batches
      WHERE sku_id = ?
    `).get(skuId);

    const currentQty = current.qty || 0;
    const needsReplenishment = currentQty < (reorderPoint + safetyStock);

    return {
      skuId,
      dailyDemand: Math.round(dailyDemand * 100) / 100,
      leadTimeDays,
      safetyStockDays,
      reorderPoint: Math.round(reorderPoint),
      safetyStock: Math.round(safetyStock),
      economicOrderQty: Math.round(economicOrderQty),
      currentStock: currentQty,
      needsReplenishment,
      daysOfStockRemaining: currentQty > 0 ? Math.round(currentQty / dailyDemand) : 0
    };
  };

  /**
   * Forecast inventory gap (items at risk of stockout)
   */
  const forecastInventoryGap = (warehouseId = 'wh-main', days = 30) => {
    const skus = db.prepare(`
      SELECT DISTINCT sku_id FROM inventory_batches WHERE warehouse_id = ?
    `).all(warehouseId);

    const gaps = [];

    skus.forEach(sku => {
      const reorder = calculateReorderPoint(sku.sku_id);

      if (reorder.needsReplenishment) {
        gaps.push({
          skuId: sku.sku_id,
          currentStock: reorder.currentStock,
          forecastedDemand: reorder.dailyDemand * days,
          projectedStock: reorder.currentStock - (reorder.dailyDemand * days),
          daysUntilStockout: reorder.daysOfStockRemaining,
          priority: reorder.daysOfStockRemaining <= 7 ? 'critical' : 'high'
        });
      }
    });

    return {
      warehouseId,
      skusAtRisk: gaps.length,
      items: gaps.sort((a, b) => a.daysUntilStockout - b.daysUntilStockout)
    };
  };

  return {
    forecastMovingAverage,
    forecastExponentialSmoothing,
    forecastSeasonalDecomposition,
    forecastDemand,
    calculateReorderPoint,
    forecastInventoryGap
  };
};
