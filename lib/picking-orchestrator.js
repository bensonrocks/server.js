'use strict';

/**
 * Picking Orchestrator
 * Orchestrates the complete picking workflow from order selection through manifest printing
 * Ties together: wave suggestion → wave creation → session initiation → label/manifest queueing
 */
module.exports = function createPickingOrchestrator(db) {

  const startBatchPicking = (orderIds, options = {}) => {
    const {
      warehouseId = null,
      operatorId = '',
      priority = 'normal',
      maxOrders = 50,
    } = options;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      throw new Error('orderIds array required');
    }

    // Step 1: Suggest wave mode (batch vs single)
    const pickingWave = require('./picking-wave')(db);
    const waveModeSuggestion = pickingWave.suggestWaveMode(orderIds);

    // Step 2: Create wave with THU code
    const wave = pickingWave.createWave({
      name: waveModeSuggestion.suggestion === 'batch'
        ? `Batch-${Date.now()}`
        : `Single-${orderIds[0]}`,
      warehouseId,
      priority,
      maxOrders,
      orderIds,
    });

    // Step 3: Add orders to wave
    const addResult = pickingWave.addOrdersToWave(wave.id, orderIds);

    // Step 4: Open picking session(s)
    const scanPack = require('./scan-pack')(db);
    const sessions = [];

    for (const orderId of addResult.orders) {
      try {
        const session = scanPack.openSession(orderId, wave.id);
        sessions.push(session);
      } catch (err) {
        console.warn(`Could not open session for ${orderId}: ${err.message}`);
      }
    }

    // Step 5: Return orchestrated workflow state
    return {
      waveSuggestion: {
        mode: waveModeSuggestion.suggestion,
        orderCount: waveModeSuggestion.orderCount,
        totalLines: waveModeSuggestion.totalLines,
        uniqueSkus: waveModeSuggestion.uniqueSkus,
        sharedSkus: waveModeSuggestion.sharedSkus,
        savedTrips: waveModeSuggestion.savedTrips,
        overlapPct: waveModeSuggestion.overlapPct,
        guidance: waveModeSuggestion.reason,
      },
      wave: {
        id: wave.id,
        name: wave.name,
        thuCode: wave.thuCode,
        status: 'created',
        ordersInWave: addResult.added,
      },
      pickingSessions: sessions.map(s => ({
        sessionId: s.sessionId,
        orderId: s.orderId,
        clientName: s.clientName,
        ready: true,
        status: 'open',
      })),
      workflow: {
        phase: 'ready-to-pick',
        nextSteps: [
          '1. Operator scans THU to open first carton',
          '2. Scan SKUs into carton',
          '3. Scan same THU to close carton',
          '4. Labels auto-queued to thermal printer',
          '5. Repeat for all cartons',
          '6. Close session → manifest auto-queued to office printer',
        ],
        estimatedTime: `${Math.ceil(waveModeSuggestion.totalLines / 10)} minutes`,
      },
      operatorGuidance: waveModeSuggestion.suggestion === 'batch'
        ? `Batch picking: ${waveModeSuggestion.savedTrips} trips saved by picking shared SKUs together`
        : `Single order: Pick directly to carton, no consolidation needed`,
    };
  };

  const getPickingStatus = (waveId) => {
    const wave = db.prepare('SELECT * FROM picking_waves WHERE id = ?').get(waveId);
    if (!wave) return null;

    const sessions = db.prepare(`
      SELECT id, order_id, status FROM scan_sessions WHERE wave_id = ?
    `).all(waveId);

    const cartons = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed
      FROM scan_cartons
      WHERE session_id IN (SELECT id FROM scan_sessions WHERE wave_id = ?)
    `).get(waveId);

    const printJobs = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN status = 'printed' THEN 1 ELSE 0 END) as printed
      FROM print_jobs
      WHERE id IN (
        SELECT labelQueuedFor FROM (
          SELECT sc.id as cartonId FROM scan_cartons sc
          WHERE sc.session_id IN (SELECT id FROM scan_sessions WHERE wave_id = ?)
        )
      )
    `).get(waveId);

    return {
      waveId,
      thuCode: wave.thu_code,
      status: wave.status,
      sessionsActive: sessions.filter(s => s.status === 'open').length,
      sessionsCompleted: sessions.filter(s => s.status === 'closed').length,
      cartonsClosed: (cartons.closed || 0),
      cartonsTotal: (cartons.total || 0),
      labelsPrinted: (printJobs.printed || 0),
      labelsTotal: (printJobs.total || 0),
      phase: wave.status === 'completed' ? 'ready-to-ship' : 'picking-in-progress',
    };
  };

  return {
    startBatchPicking,
    getPickingStatus,
  };
};
