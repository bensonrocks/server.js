'use strict';

/**
 * Zone-Based Cycle Counting Module
 * Extends cycle count module with rotating zones
 * Divides warehouse into zones (A, B, C, D) and rotates counts across zones
 * Provides continuous auditing without full warehouse shutdowns
 */
module.exports = function createZoneCycleCount(db, cycleCountModule) {

  /**
   * Define warehouse zones
   * Each zone covers specific location bins
   * Example: Zone A = A1-01 to A1-50, Zone B = B1-01 to B1-50, etc.
   */
  const defineZones = (warehouseId, options = {}) => {
    const {
      zoneLayout = {
        'A': { rackPrefix: 'A1-', description: 'Pick face / high-velocity' },
        'B': { rackPrefix: 'B', description: 'Mid-tier storage' },
        'C': { rackPrefix: 'C', description: 'Upper-tier storage' },
        'D': { rackPrefix: 'D', description: 'Bulk/floor storage' }
      }
    } = options;

    return {
      warehouseId,
      zones: Object.entries(zoneLayout).map(([name, config]) => ({
        name,
        rackPrefix: config.rackPrefix,
        description: config.description,
        abbrev: name
      })),
      totalZones: Object.keys(zoneLayout).length
    };
  };

  /**
   * Get batches in a specific zone
   */
  const getBatchesInZone = (warehouseId, zoneName) => {
    const zoneMap = {
      'A': 'A1-%',
      'B': 'B%',
      'C': 'C%',
      'D': 'D%'
    };

    const pattern = zoneMap[zoneName];
    if (!pattern) throw new Error(`Unknown zone: ${zoneName}`);

    return db.prepare(`
      SELECT * FROM inventory_batches
      WHERE warehouse_id = ? AND location_bin LIKE ?
      ORDER BY location_bin, received_at
    `).all(warehouseId, pattern);
  };

  /**
   * Get zone-specific statistics
   */
  const getZoneStatistics = (warehouseId, zoneName) => {
    const batches = getBatchesInZone(warehouseId, zoneName);

    const stats = {
      zone: zoneName,
      warehouseId,
      batchCount: batches.length,
      totalQty: batches.reduce((sum, b) => sum + b.available_qty, 0),
      skuCount: new Set(batches.map(b => b.sku_id)).size,
      locations: new Set(batches.map(b => b.location_bin)).size,
      avgQtyPerBatch: batches.length > 0 ? Math.round(batches.reduce((sum, b) => sum + b.available_qty, 0) / batches.length) : 0
    };

    return stats;
  };

  /**
   * Create zone-based count batch
   * Counts only batches in the specified zone
   */
  const createZoneCountBatch = (warehouseId, zoneName, options = {}) => {
    const {
      countedBy = 'staff',
      notes = ''
    } = options;

    const batches = getBatchesInZone(warehouseId, zoneName);
    if (batches.length === 0) {
      throw new Error(`No inventory found in zone ${zoneName}`);
    }

    // Create batch using existing cycle count module
    const batch = cycleCountModule.createCycleCountBatch({
      warehouseId,
      countType: 'location_based',
      locations: batches.map(b => b.location_bin),
      countedBy,
      notes: `Zone ${zoneName} count: ${notes || 'Rotating zone cycle count'}`
    });

    // Enhance batch with zone information
    return {
      ...batch,
      zone: zoneName,
      batchesInZone: batches.length,
      skusInZone: new Set(batches.map(b => b.sku_id)).size
    };
  };

  /**
   * Get zone rotation schedule
   * Suggests which zone to count next based on last count date
   */
  const getZoneRotationSchedule = (warehouseId, daysPerZone = 7) => {
    const zones = ['A', 'B', 'C', 'D'];
    const now = new Date();

    const schedule = zones.map(zone => {
      // Get last count date for zone
      const lastCount = db.prepare(`
        SELECT MAX(created_at) as last_count
        FROM cycle_count_batches
        WHERE warehouse_id = ? AND notes LIKE ?
      `).get(warehouseId, `%Zone ${zone}%`);

      const lastCountDate = lastCount.last_count ? new Date(lastCount.last_count) : null;
      const daysSinceCount = lastCountDate ? Math.floor((now - lastCountDate) / (1000 * 60 * 60 * 24)) : 999;
      const dueDate = lastCountDate ? new Date(lastCountDate.getTime() + daysPerZone * 24 * 60 * 60 * 1000) : now;
      const isOverdue = dueDate < now;

      return {
        zone,
        lastCountDate,
        daysSinceCount,
        dueDate,
        isOverdue,
        priority: isOverdue ? 'urgent' : daysSinceCount > daysPerZone * 0.8 ? 'high' : 'normal'
      };
    });

    return {
      warehouseId,
      schedule: schedule.sort((a, b) => {
        // Sort by priority, then by days since count
        const priorityOrder = { urgent: 0, high: 1, normal: 2 };
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return b.daysSinceCount - a.daysSinceCount;
      }),
      nextRecommendedZone: schedule.sort((a, b) => {
        const priorityOrder = { urgent: 0, high: 1, normal: 2 };
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        return priorityDiff !== 0 ? priorityDiff : b.daysSinceCount - a.daysSinceCount;
      })[0].zone
    };
  };

  /**
   * Get zone drift/variance trends
   * Shows which zones tend to have discrepancies
   */
  const getZoneDriftReport = (warehouseId, days = 90) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    // Find all zone counts
    const zoneCounts = db.prepare(`
      SELECT
        COUNT(*) as variance_count,
        AVG(ABS(variance_qty)) as avg_variance_qty,
        AVG(ABS(variance_pct)) as avg_variance_pct,
        CASE
          WHEN location_bin LIKE 'A1-%' THEN 'A'
          WHEN location_bin LIKE 'B%' THEN 'B'
          WHEN location_bin LIKE 'C%' THEN 'C'
          WHEN location_bin LIKE 'D%' THEN 'D'
          ELSE 'Unknown'
        END as zone
      FROM cycle_count_variances
      WHERE created_at >= ? AND warehouse_id = ?
      GROUP BY zone
      ORDER BY avg_variance_pct DESC
    `).all(cutoffDate.toISOString(), warehouseId);

    return {
      warehouseId,
      period: { from: cutoffDate, to: new Date() },
      zoneDrift: zoneCounts.map(row => ({
        zone: row.zone,
        varianceCount: row.variance_count,
        avgVarianceQty: Math.round(row.avg_variance_qty * 100) / 100,
        avgVariancePct: Math.round(row.avg_variance_pct * 100) / 100,
        reliability: row.avg_variance_pct < 2 ? 'excellent' : row.avg_variance_pct < 5 ? 'good' : 'needs_attention'
      }))
    };
  };

  /**
   * Schedule automated zone counts
   * Returns maintenance plan for next N weeks
   */
  const generateZoneCountPlan = (warehouseId, weeksAhead = 4, daysPerZone = 7) => {
    const zones = ['A', 'B', 'C', 'D'];
    const now = new Date();
    const plan = [];

    for (let week = 0; week < weeksAhead; week++) {
      for (let day = 0; day < 7; day++) {
        const scheduleDate = new Date(now);
        scheduleDate.setDate(scheduleDate.getDate() + week * 7 + day);

        // Rotate zones: every daysPerZone days, move to next zone
        const zoneCycleDay = Math.floor((now.getTime() - new Date(2026, 0, 1).getTime()) / (1000 * 60 * 60 * 24) + day);
        const zoneIndex = Math.floor(zoneCycleDay / daysPerZone) % zones.length;
        const zone = zones[zoneIndex];

        if (day % daysPerZone === 0) {  // Count days
          plan.push({
            date: scheduleDate.toISOString().split('T')[0],
            zone,
            week,
            dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][scheduleDate.getDay()]
          });
        }
      }
    }

    return {
      warehouseId,
      plan: plan.slice(0, weeksAhead),
      rotationDays: daysPerZone,
      totalZones: zones.length
    };
  };

  /**
   * Compare zone drift to detect systemic issues
   */
  const analyzeZonePerformance = (warehouseId, days = 90) => {
    const driftReport = getZoneDriftReport(warehouseId, days);

    if (driftReport.zoneDrift.length === 0) {
      return {
        status: 'insufficient_data',
        message: 'No variances recorded in period'
      };
    }

    const avgVariancePct = driftReport.zoneDrift.reduce((sum, z) => sum + z.avgVariancePct, 0) / driftReport.zoneDrift.length;
    const worstZone = driftReport.zoneDrift[0];
    const bestZone = driftReport.zoneDrift[driftReport.zoneDrift.length - 1];

    return {
      warehouseId,
      period: days,
      analysis: {
        overallAccuracy: Math.round((100 - avgVariancePct) * 100) / 100,
        bestZone: {
          name: bestZone.zone,
          accuracy: Math.round((100 - bestZone.avgVariancePct) * 100) / 100
        },
        worstZone: {
          name: worstZone.zone,
          accuracy: Math.round((100 - worstZone.avgVariancePct) * 100) / 100,
          recommendation: worstZone.avgVariancePct > 5 ? 'Increase count frequency or audit receiving process' : 'Continue current schedule'
        },
        insights: [
          worstZone.avgVariancePct > 10 ? `⚠️ Zone ${worstZone.zone} has high variance (${worstZone.avgVariancePct.toFixed(1)}%) - possible receiving or handling issues` : null,
          bestZone.zone === 'A' ? `✅ Pick face (Zone A) is well-maintained - high picking accuracy` : null
        ].filter(Boolean)
      }
    };
  };

  return {
    defineZones,
    getBatchesInZone,
    getZoneStatistics,
    createZoneCountBatch,
    getZoneRotationSchedule,
    getZoneDriftReport,
    generateZoneCountPlan,
    analyzeZonePerformance
  };
};
