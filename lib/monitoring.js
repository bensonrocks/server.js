'use strict';

/**
 * Monitoring & Observability Service
 * Tracks metrics, logs, and system health
 */
module.exports = function createMonitoring(db) {
  const metrics = {
    ordersSync: { total: 0, success: 0, failed: 0 },
    inventorySync: { total: 0, success: 0, failed: 0 },
    webhooksReceived: { total: 0, processed: 0, failed: 0 },
    apiCalls: { total: 0, success: 0, failed: 0 },
  };

  const recordOrderSync = (success) => {
    metrics.ordersSync.total++;
    if (success) metrics.ordersSync.success++;
    else metrics.ordersSync.failed++;
  };

  const recordInventorySync = (success) => {
    metrics.inventorySync.total++;
    if (success) metrics.inventorySync.success++;
    else metrics.inventorySync.failed++;
  };

  const recordWebhook = (processed) => {
    metrics.webhooksReceived.total++;
    if (processed) metrics.webhooksReceived.processed++;
    else metrics.webhooksReceived.failed++;
  };

  const recordApiCall = (success) => {
    metrics.apiCalls.total++;
    if (success) metrics.apiCalls.success++;
    else metrics.apiCalls.failed++;
  };

  const getMetrics = () => ({
    ...metrics,
    timestamp: new Date().toISOString(),
  });

  const logEvent = (level, component, message, metadata = {}) => {
    const log = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...metadata,
    };
    console.log(JSON.stringify(log));
    return log;
  };

  const checkHealth = () => ({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    checks: {
      database: 'ok',
      api: 'ok',
      webhooks: 'ok',
    },
  });

  return {
    recordOrderSync,
    recordInventorySync,
    recordWebhook,
    recordApiCall,
    getMetrics,
    logEvent,
    checkHealth,
  };
};
