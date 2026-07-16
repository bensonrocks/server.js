'use strict';

/**
 * WMS Routes - Register all WMS endpoints (auto-allocation, picking waves, returns, analytics, etc.)
 */
module.exports = function registerWMSRoutes(app, { withTenant, withClientAuth }) {
  return (req, res, next) => {
    // Routes will be registered by the main server.js file
    // This is just a placeholder for route organization
    next();
  };
};

/**
 * Factory function to create all WMS route handlers
 */
function createWMSHandlers(db, getTenantContext) {
  const autoAllocator = require('./auto-allocator');
  const pickingWave = require('./picking-wave');
  const labelPrinter = require('./label-printer');
  const returnsManager = require('./returns-manager');
  const inventoryForecast = require('./inventory-forecast');
  const analytics = require('./analytics');

  return {
    // Auto-Allocation handlers
    allocateOrder: (req, res) => {
      try {
        const { orderId } = req.params;
        const { strategy = 'nearest', force = false } = req.body;
        const ctx = getTenantContext(req.tenantId);
        const allocator = autoAllocator(ctx.db, ctx.inventory, ctx.store);
        const result = allocator.allocateOrder(orderId, { strategy, force });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    allocateBatch: (req, res) => {
      try {
        const { orderIds, strategy = 'nearest' } = req.body;
        const ctx = getTenantContext(req.tenantId);
        const allocator = autoAllocator(ctx.db, ctx.inventory, ctx.store);
        const result = allocator.allocateBatch(orderIds, { strategy });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    // Picking Wave handlers
    createWave: (req, res) => {
      try {
        const ctx = getTenantContext(req.tenantId);
        const wave = pickingWave(ctx.db);
        const result = wave.createWave(req.body);
        res.status(201).json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    addOrdersToWave: (req, res) => {
      try {
        const { waveId } = req.params;
        const { orderIds } = req.body;
        const ctx = getTenantContext(req.tenantId);
        const wave = pickingWave(ctx.db);
        const result = wave.addOrdersToWave(waveId, orderIds);
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    getWaveDetails: (req, res) => {
      try {
        const { waveId } = req.params;
        const ctx = getTenantContext(req.tenantId);
        const wave = pickingWave(ctx.db);
        const result = wave.getWaveDetails(waveId);
        if (!result) return res.status(404).json({ error: 'Wave not found' });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    startWave: (req, res) => {
      try {
        const { waveId } = req.params;
        const ctx = getTenantContext(req.tenantId);
        const wave = pickingWave(ctx.db);
        const result = wave.startWave(waveId);
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    listWaves: (req, res) => {
      try {
        const { status, limit = 50 } = req.query;
        const ctx = getTenantContext(req.tenantId);
        const wave = pickingWave(ctx.db);
        const result = wave.listWaves({ status, limit: parseInt(limit) });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    // Label Printer handlers
    generateShippingLabel: async (req, res) => {
      try {
        const { orderId } = req.params;
        const { copies = 1 } = req.body;
        const ctx = getTenantContext(req.tenantId);
        const printer = labelPrinter(ctx.db);
        const result = await printer.generateShippingLabel(orderId, { copies });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    // Returns handlers
    createReturn: (req, res) => {
      try {
        const ctx = getTenantContext(req.tenantId);
        const returns = returnsManager(ctx.db);
        const result = returns.createReturn(req.body);
        res.status(201).json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    inspectReturn: (req, res) => {
      try {
        const { returnId } = req.params;
        const ctx = getTenantContext(req.tenantId);
        const returns = returnsManager(ctx.db);
        const result = returns.inspectReturn(returnId, req.body);
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    approveRestock: (req, res) => {
      try {
        const { returnId } = req.params;
        const ctx = getTenantContext(req.tenantId);
        const returns = returnsManager(ctx.db);
        const result = returns.approveRestock(returnId);
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    // Forecasting handlers
    forecastDemand: (req, res) => {
      try {
        const { skuId } = req.params;
        const { days = 30, method = 'moving_average' } = req.query;
        const ctx = getTenantContext(req.tenantId);
        const forecast = inventoryForecast(ctx.db);
        const result = forecast.forecastDemand({ skuId, days: parseInt(days), method });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    forecastGap: (req, res) => {
      try {
        const ctx = getTenantContext(req.tenantId);
        const forecast = inventoryForecast(ctx.db);
        const result = forecast.forecastInventoryGap();
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    forecastByPlatform: (req, res) => {
      try {
        const { platform, days = 30 } = req.query;
        const ctx = getTenantContext(req.tenantId);
        const forecast = inventoryForecast(ctx.db);
        const result = forecast.forecastByPlatform({ platform, days: parseInt(days) });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    // Analytics handlers
    getDashboard: (req, res) => {
      try {
        const { startDate, endDate, platform } = req.query;
        const ctx = getTenantContext(req.tenantId);
        const analy = analytics(ctx.db);
        const result = analy.getDashboardMetrics({ startDate, endDate, platform });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    getAnalyticsTrends: (req, res) => {
      try {
        const { days = 30, metric = 'orders' } = req.query;
        const ctx = getTenantContext(req.tenantId);
        const analy = analytics(ctx.db);
        const result = analy.getTrendData({ days: parseInt(days), metric });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },

    getWarehouseMetrics: (req, res) => {
      try {
        const ctx = getTenantContext(req.tenantId);
        const analy = analytics(ctx.db);
        const result = analy.getWarehouseMetrics();
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },
  };
}

module.exports.createWMSHandlers = createWMSHandlers;
