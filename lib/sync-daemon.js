'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

module.exports = function createSyncDaemon(tenantDb, options = {}) {
  const {
    sourceDb,           // IdealScan database
    pollingInterval = 30000,  // 30 seconds
    batchSize = 50,
    retryAttempts = 3,
    retryDelay = 5000,
    port = 3000,
    apiKey = 'migration-key'
  } = options;

  if (!sourceDb) {
    console.warn('⚠️  Sync daemon: sourceDb not provided, sync disabled');
    return {
      start: () => {},
      stop: () => {},
      getStatus: () => ({ enabled: false, reason: 'sourceDb missing' })
    };
  }

  let isRunning = false;
  let pollTimer = null;
  let lastSyncTime = getLastSyncCheckpoint();
  let syncStats = {
    totalRuns: 0,
    lastRun: null,
    lastSuccess: null,
    recordsSynced: 0,
    errors: [],
    ordersChanged: 0,
    wavesChanged: 0,
    picksChanged: 0,
    cartonsChanged: 0
  };

  // ─ Sync checkpoints ─────────────────────────────────────────────────────
  function getSyncCheckpointPath() {
    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    return path.join(dataDir, 'sync-checkpoint.json');
  }

  function getLastSyncCheckpoint() {
    try {
      const checkpointFile = getSyncCheckpointPath();
      if (fs.existsSync(checkpointFile)) {
        const data = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
        return new Date(data.lastSyncTime);
      }
    } catch (e) {
      console.error('Error reading sync checkpoint:', e.message);
    }
    // First sync: 24 hours ago
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return d;
  }

  function updateSyncCheckpoint(timestamp) {
    try {
      const checkpointFile = getSyncCheckpointPath();
      fs.writeFileSync(checkpointFile, JSON.stringify({ lastSyncTime: timestamp.toISOString() }, null, 2));
    } catch (e) {
      console.error('Error writing sync checkpoint:', e.message);
    }
  }

  // ─ Change detection ─────────────────────────────────────────────────────
  function detectChanges(tableName, since) {
    try {
      const rows = sourceDb.prepare(`
        SELECT * FROM ${tableName}
        WHERE updated_at > datetime(?)
        ORDER BY updated_at DESC
        LIMIT ${batchSize}
      `).all(since.toISOString());

      return rows || [];
    } catch (e) {
      if (e.message.includes('no such table')) {
        return []; // Table doesn't exist in source
      }
      throw e;
    }
  }

  // ─ Schema mapping ───────────────────────────────────────────────────────
  function transformOrder(row) {
    return {
      id: row.id,
      clientId: row.client_id,
      clientName: row.client_name,
      channel: row.channel,
      orderDate: row.order_date,
      status: row.status,
      currency: row.currency || 'SGD',
      items: typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []),
      shipping: typeof row.shipping === 'string' ? JSON.parse(row.shipping) : (row.shipping || {}),
      subtotal: parseFloat(row.subtotal || 0),
      shippingCost: parseFloat(row.shipping_cost || 0),
      tax: parseFloat(row.tax || 0),
      total: parseFloat(row.total || 0),
      notes: row.notes || '',
      source: {
        type: 'sync-idealscan',
        syncedAt: new Date().toISOString(),
        originalId: row.id
      }
    };
  }

  function transformPickingWave(row) {
    return {
      id: row.id,
      warehouseId: row.warehouse_id || 'wh-main',
      status: row.status || 'created',
      mode: row.mode || 'batch',
      createdAt: row.created_at,
      completedAt: row.completed_at,
      ordersCount: row.orders_count || 0
    };
  }

  function transformPickItem(row) {
    return {
      waveId: row.wave_id,
      orderId: row.order_id,
      lineId: row.line_id,
      skuId: row.sku_id,
      qtyRequired: row.qty_required,
      qtyPicked: row.qty_picked || 0,
      pickedAt: row.picked_at,
      status: (row.qty_picked || 0) >= row.qty_required ? 'completed' : 'pending'
    };
  }

  function transformCarton(row) {
    return {
      id: row.id,
      waveId: row.wave_id,
      orderId: row.order_id,
      thuCode: row.thu_code,
      weight: parseFloat(row.weight || 0),
      status: row.status || 'open',
      packedAt: row.packed_at,
      labelPrintedAt: row.label_printed_at
    };
  }

  // ─ API requests to IdealOMS ─────────────────────────────────────────────
  function makeRequest(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'default',
          'X-API-Key': apiKey
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve({ status: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, data: { error: 'Parse error', raw: data } });
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ─ Sync operations ──────────────────────────────────────────────────────
  async function syncOrders() {
    const changes = detectChanges('orders', lastSyncTime);
    let synced = 0;

    for (const order of changes) {
      try {
        const transformed = transformOrder(order);

        // Check if order already exists in IdealOMS
        const checkRes = await makeRequest('GET', `/api/orders/${order.id}`);

        if (checkRes.status === 200) {
          // Update existing
          await makeRequest('PUT', `/api/orders/${order.id}`, { status: order.status });
        } else {
          // Create new
          await makeRequest('POST', '/api/ingest/orders', transformed);
        }
        synced++;
      } catch (e) {
        logError('syncOrders', order.id, e);
      }
    }

    return synced;
  }

  async function syncPickingWaves() {
    const changes = detectChanges('picking_waves', lastSyncTime);
    let synced = 0;

    for (const wave of changes) {
      try {
        const transformed = transformPickingWave(wave);

        // Check if wave exists
        const checkRes = await makeRequest('GET', `/api/picking/waves/${wave.id}`);

        if (checkRes.status === 200) {
          // Update status
          await makeRequest('PUT', `/api/picking/waves/${wave.id}`, { status: wave.status });
        } else {
          // Create new (if in valid state)
          if (wave.status === 'created') {
            await makeRequest('POST', '/api/picking/waves', transformed);
          }
        }
        synced++;
      } catch (e) {
        logError('syncPickingWaves', wave.id, e);
      }
    }

    return synced;
  }

  async function syncPickItems() {
    const changes = detectChanges('pick_items', lastSyncTime);
    let synced = 0;

    for (const item of changes) {
      try {
        // Only sync if qty_picked changed (actual picking action)
        if (item.qty_picked > 0) {
          const transformed = transformPickItem(item);
          await makeRequest('POST', `/api/picking/waves/${item.wave_id}/confirm-pick`, {
            lineId: item.line_id,
            qtyPicked: item.qty_picked,
            pickedAt: item.picked_at
          });
          synced++;
        }
      } catch (e) {
        logError('syncPickItems', item.id, e);
      }
    }

    return synced;
  }

  async function syncCartons() {
    const changes = detectChanges('cartons', lastSyncTime);
    let synced = 0;

    for (const carton of changes) {
      try {
        const transformed = transformCarton(carton);

        // Create or update carton
        const checkRes = await makeRequest('GET', `/api/cartons/${carton.id}`);

        if (checkRes.status === 200) {
          // Update
          await makeRequest('PUT', `/api/cartons/${carton.id}`, { status: carton.status });
        } else {
          // Create
          await makeRequest('POST', '/api/cartons', transformed);
        }
        synced++;
      } catch (e) {
        logError('syncCartons', carton.id, e);
      }
    }

    return synced;
  }

  // ─ Error handling ───────────────────────────────────────────────────────
  function logError(operation, recordId, error) {
    const errorEntry = {
      timestamp: new Date().toISOString(),
      operation,
      recordId,
      message: error.message,
      attempts: 1
    };

    // Check if we've already logged this error
    const existing = syncStats.errors.find(e => e.operation === operation && e.recordId === recordId);
    if (existing) {
      existing.attempts++;
      existing.lastAttempt = new Date().toISOString();
    } else {
      syncStats.errors.push(errorEntry);
    }

    // Keep only last 100 errors
    if (syncStats.errors.length > 100) {
      syncStats.errors = syncStats.errors.slice(-100);
    }
  }

  // ─ Main sync loop ───────────────────────────────────────────────────────
  async function runSync() {
    syncStats.totalRuns++;
    syncStats.lastRun = new Date().toISOString();

    try {
      const before = new Date();

      const ordersCount = await syncOrders();
      const wavesCount = await syncPickingWaves();
      const picksCount = await syncPickItems();
      const cartonsCount = await syncCartons();

      const totalSynced = ordersCount + wavesCount + picksCount + cartonsCount;

      syncStats.recordsSynced += totalSynced;
      syncStats.ordersChanged += ordersCount;
      syncStats.wavesChanged += wavesCount;
      syncStats.picksChanged += picksCount;
      syncStats.cartonsChanged += cartonsCount;
      syncStats.lastSuccess = new Date().toISOString();

      // Update checkpoint
      lastSyncTime = new Date();
      updateSyncCheckpoint(lastSyncTime);

      const duration = Date.now() - before.getTime();
      console.log(`✅ Sync completed: ${totalSynced} records in ${duration}ms`);

      return { success: true, synced: totalSynced, duration };
    } catch (e) {
      console.error('❌ Sync error:', e.message);
      logError('runSync', 'general', e);
      return { success: false, error: e.message };
    }
  }

  // ─ Public API ───────────────────────────────────────────────────────────
  return {
    start() {
      if (isRunning) return;
      isRunning = true;

      console.log(`🔄 Starting sync daemon (interval: ${pollingInterval}ms)`);

      // Run immediately, then on interval
      runSync();
      pollTimer = setInterval(runSync, pollingInterval);
    },

    stop() {
      if (!isRunning) return;
      isRunning = false;

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      console.log('⏹️  Sync daemon stopped');
    },

    async syncNow() {
      return runSync();
    },

    getStatus() {
      return {
        enabled: isRunning,
        lastSyncTime: lastSyncTime.toISOString(),
        stats: {
          ...syncStats,
          activeErrorCount: syncStats.errors.filter(e => e.attempts >= retryAttempts).length
        },
        config: {
          pollingInterval,
          batchSize,
          retryAttempts,
          sourceDb: sourceDb ? 'connected' : 'missing'
        }
      };
    },

    getErrors() {
      return syncStats.errors;
    },

    clearErrors() {
      syncStats.errors = [];
    },

    isRunning() {
      return isRunning;
    }
  };
};
