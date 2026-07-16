'use strict';

/**
 * Auto-Trigger Scheduler
 * Periodically monitors pick face levels and automatically creates replenishment waves
 * Runs on configurable intervals (default: every 4 hours)
 */
module.exports = function createAutoTriggerScheduler(db, replenishmentModule) {

  let schedulerRunning = false;
  let schedulerInterval = null;

  // Main auto-trigger logic
  const autoTriggerReplenishment = (warehouseId = 'wh-main', options = {}) => {
    const {
      minVelocity = 0.5,
      maxPickFaceQty = 50,
      thresholdPct = 50,
      autoCreateWave = true,
      supervisor = 'AutoTrigger'
    } = options;

    try {
      // Get suggestions
      const suggestions = replenishmentModule.suggestReplenishmentTasks({
        warehouseId,
        minVelocity,
        maxPickFaceQty,
        thresholdPct,
        limitTasks: 50
      });

      if (suggestions.suggestedTasks.length === 0) {
        return {
          triggered: false,
          reason: 'No low-stock items detected',
          warehouseId,
          timestamp: new Date().toISOString()
        };
      }

      // Only create waves for high-priority items (>3 picks/day)
      const highPriorityTasks = suggestions.suggestedTasks
        .filter(t => t.priority >= 3)
        .slice(0, 30);  // Cap at 30 tasks per auto wave

      if (highPriorityTasks.length === 0) {
        return {
          triggered: false,
          reason: 'No high-priority items (velocity <3/day)',
          warehouseId,
          timestamp: new Date().toISOString()
        };
      }

      if (!autoCreateWave) {
        return {
          triggered: false,
          reason: 'Auto-create disabled',
          suggestedTasks: highPriorityTasks.length,
          warehouseId,
          timestamp: new Date().toISOString()
        };
      }

      // Create replenishment wave
      const taskSpecs = highPriorityTasks.map(t => ({
        skuId: t.skuId,
        sourceBatchId: t.sourceBatchId,
        targetQty: t.replenishQty,
        priority: t.priority
      }));

      const wave = replenishmentModule.createReplenishmentWave(taskSpecs, {
        warehouseId,
        supervisor,
        notes: `Auto-triggered: ${highPriorityTasks.length} high-priority items at ${new Date().toISOString()}`
      });

      return {
        triggered: true,
        waveId: wave.waveId,
        taskCount: wave.taskCount,
        totalQtyToMove: wave.totalQtyToMove,
        warehouseId,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return {
        triggered: false,
        error: err.message,
        warehouseId,
        timestamp: new Date().toISOString()
      };
    }
  };

  // Start scheduler
  const startScheduler = (intervalMinutes = 240) => {  // Default 4 hours
    if (schedulerRunning) {
      return { status: 'already_running', intervalMinutes };
    }

    schedulerRunning = true;
    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`[AUTO-TRIGGER] Scheduler started. Running every ${intervalMinutes} minutes.`);

    // Run immediately on start
    const result = autoTriggerReplenishment('wh-main', { autoCreateWave: true });
    console.log(`[AUTO-TRIGGER] Initial run:`, result);

    // Schedule recurring runs
    schedulerInterval = setInterval(() => {
      try {
        const warehouses = db.prepare(`
          SELECT DISTINCT id FROM warehouses WHERE is_active = 1
        `).all();

        warehouses.forEach(wh => {
          const result = autoTriggerReplenishment(wh.id, { autoCreateWave: true });
          if (result.triggered) {
            console.log(`[AUTO-TRIGGER] Wave created for ${wh.id}:`, result.waveId);
          }
        });
      } catch (err) {
        console.error(`[AUTO-TRIGGER] Scheduler error:`, err.message);
      }
    }, intervalMs);

    return {
      status: 'started',
      intervalMinutes,
      nextRun: new Date(Date.now() + intervalMs).toISOString()
    };
  };

  // Stop scheduler
  const stopScheduler = () => {
    if (!schedulerRunning) {
      return { status: 'not_running' };
    }

    clearInterval(schedulerInterval);
    schedulerRunning = false;
    console.log('[AUTO-TRIGGER] Scheduler stopped.');

    return { status: 'stopped' };
  };

  // Get scheduler status
  const getSchedulerStatus = () => {
    return {
      running: schedulerRunning,
      intervalMs: schedulerInterval ? 'active' : 'inactive'
    };
  };

  return {
    autoTriggerReplenishment,
    startScheduler,
    stopScheduler,
    getSchedulerStatus
  };
};
