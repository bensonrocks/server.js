'use strict';

/**
 * Scan-Based Pick-and-Pack (PPP) Workflow
 * Operator scans THU/HU to open carton, scans items into it, scans HU to close
 * Generates per-box packing list and carton manifest
 */
module.exports = function createScanPack(db) {

  const openSession = (orderId, waveId = null) => {
    const sessionId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new Error('Order not found');

    // If waveId provided, verify wave exists
    if (waveId) {
      const wave = db.prepare('SELECT id, thu_code FROM picking_waves WHERE id = ?').get(waveId);
      if (!wave) throw new Error('Wave not found');
    }

    db.prepare(`
      INSERT INTO scan_sessions (id, wave_id, order_id, status, opened_at)
      VALUES (?, ?, ?, 'open', ?)
    `).run(sessionId, waveId, orderId, now);

    return {
      sessionId,
      orderId,
      waveId,
      status: 'open',
      clientName: order.client_name,
      openedAt: now,
    };
  };

  const openCarton = (sessionId, thuCode) => {
    const session = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.status !== 'open') throw new Error(`Session is ${session.status}, cannot open carton`);

    const cartonId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    // Get sequence number for this carton in the session
    const { seq } = db.prepare(
      'SELECT MAX(carton_seq) as seq FROM scan_cartons WHERE session_id = ?'
    ).get(sessionId) || { seq: 0 };

    db.prepare(`
      INSERT INTO scan_cartons (id, session_id, order_id, hu_code, carton_seq, status, opened_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(cartonId, sessionId, session.order_id, thuCode, seq + 1, now);

    return {
      cartonId,
      sessionId,
      huCode: thuCode,
      cartonSeq: seq + 1,
      status: 'open',
      openedAt: now,
    };
  };

  const addItemToCarton = (cartonId, skuCode, qty = 1, lotNumber = '', expiryDate = '') => {
    const carton = db.prepare('SELECT * FROM scan_cartons WHERE id = ?').get(cartonId);
    if (!carton) throw new Error('Carton not found');
    if (carton.status !== 'open') throw new Error(`Carton is ${carton.status}, cannot add items`);

    // Get SKU info
    const sku = db.prepare('SELECT * FROM skus WHERE code = ?').get(skuCode);
    if (!sku) throw new Error(`SKU ${skuCode} not found`);

    const itemId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO scan_carton_items (id, carton_id, session_id, order_id, sku, item_name, qty, lot_number, expiry_date, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, cartonId, carton.session_id, carton.order_id, skuCode, sku.name, qty, lotNumber, expiryDate, now);

    return {
      itemId,
      cartonId,
      sku: skuCode,
      itemName: sku.name,
      qty,
      scannedAt: now,
    };
  };

  const closeCarton = (cartonId, weight = null, length = null, width = null, height = null, autoQueueLabel = true) => {
    const carton = db.prepare('SELECT * FROM scan_cartons WHERE id = ?').get(cartonId);
    if (!carton) throw new Error('Carton not found');
    if (carton.status !== 'open') throw new Error(`Carton is already ${carton.status}`);

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE scan_cartons
      SET status = 'closed', weight_kg = ?, length_cm = ?, width_cm = ?, height_cm = ?, closed_at = ?
      WHERE id = ?
    `).run(weight, length, width, height, now, cartonId);

    // Auto-queue carton label for printing
    let printJobId = null;
    if (autoQueueLabel) {
      const printQueue = require('./print-queue')(db);
      const labelData = {
        type: 'carton',
        cartonId,
        orderId: carton.order_id,
        huCode: carton.hu_code,
        cartonSeq: carton.carton_seq,
        weight,
        dimensions: { length, width, height },
        generatedAt: now,
      };
      const printJob = printQueue.queuePrintJob(labelData, {
        printerType: 'thermal',
        priority: 'normal',
        notes: `Carton ${carton.carton_seq} for order ${carton.order_id}`,
      });
      printJobId = printJob.jobId;
    }

    return {
      cartonId,
      status: 'closed',
      closedAt: now,
      weight: weight || null,
      dimensions: { length, width, height },
      labelQueuedFor: printJobId || null,
    };
  };

  const closeSession = (sessionId, operatorId = '', autoQueueManifest = true) => {
    const session = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.status !== 'open') throw new Error(`Session is ${session.status}`);

    const now = new Date().toISOString();

    // All cartons must be closed before closing session
    const openCartons = db.prepare(
      "SELECT COUNT(*) as cnt FROM scan_cartons WHERE session_id = ? AND status = 'open'"
    ).get(sessionId).cnt;

    if (openCartons > 0) {
      throw new Error(`Cannot close session: ${openCartons} carton(s) still open`);
    }

    db.prepare(`
      UPDATE scan_sessions
      SET status = 'closed', operator_id = ?, closed_at = ?
      WHERE id = ?
    `).run(operatorId, now, sessionId);

    // Auto-queue packing manifest for printing
    let manifestJobId = null;
    if (autoQueueManifest) {
      const manifest = getPackingManifest(sessionId);
      if (manifest) {
        const printQueue = require('./print-queue')(db);
        const manifestData = {
          type: 'packing-manifest',
          orderId: manifest.orderId,
          clientName: manifest.clientName,
          totalCartons: manifest.totalCartons,
          cartons: manifest.cartons,
          generatedAt: now,
        };
        const printJob = printQueue.queuePrintJob(manifestData, {
          printerType: 'office',
          priority: 'normal',
          copies: 2,
          notes: `Packing manifest for ${manifest.clientName}`,
        });
        manifestJobId = printJob.jobId;
      }
    }

    return {
      sessionId,
      status: 'closed',
      closedAt: now,
      manifestQueuedFor: manifestJobId || null,
    };
  };

  const getSessionSummary = (sessionId) => {
    const session = db.prepare('SELECT * FROM scan_sessions WHERE id = ?').get(sessionId);
    if (!session) return null;

    const cartons = db.prepare(`
      SELECT c.*, COUNT(i.id) as item_count, SUM(i.qty) as total_qty
      FROM scan_cartons c
      LEFT JOIN scan_carton_items i ON c.id = i.carton_id
      WHERE c.session_id = ?
      GROUP BY c.id
      ORDER BY c.carton_seq
    `).all(sessionId);

    const cartonDetails = cartons.map(c => {
      const items = db.prepare(`
        SELECT * FROM scan_carton_items
        WHERE carton_id = ?
        ORDER BY scanned_at
      `).all(c.id);

      return {
        cartonId: c.id,
        huCode: c.hu_code,
        cartonSeq: c.carton_seq,
        status: c.status,
        itemCount: c.item_count || 0,
        totalQty: c.total_qty || 0,
        weight: c.weight_kg,
        dimensions: { length: c.length_cm, width: c.width_cm, height: c.height_cm },
        items,
      };
    });

    const totalCartons = cartons.length;
    const totalItems = cartons.reduce((s, c) => s + (c.item_count || 0), 0);
    const totalQty = cartons.reduce((s, c) => s + (c.total_qty || 0), 0);

    return {
      sessionId,
      orderId: session.order_id,
      status: session.status,
      cartons: cartonDetails,
      totalCartons,
      totalItems,
      totalQty,
      operatorId: session.operator_id,
      openedAt: session.opened_at,
      closedAt: session.closed_at,
    };
  };

  const getPackingManifest = (sessionId) => {
    const summary = getSessionSummary(sessionId);
    if (!summary) return null;

    // Group items by carton for packing list
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(summary.orderId);

    return {
      orderId: summary.orderId,
      clientName: order.client_name,
      totalCartons: summary.totalCartons,
      totalItems: summary.totalItems,
      cartons: summary.cartons.map((c, idx) => ({
        cartonNumber: idx + 1,
        huCode: c.huCode,
        status: c.status,
        itemList: c.items.map((item, itemIdx) => ({
          line: itemIdx + 1,
          sku: item.sku,
          name: item.item_name,
          qty: item.qty,
          lotNumber: item.lot_number,
          expiryDate: item.expiry_date,
        })),
        summary: `Carton ${idx + 1} of ${summary.totalCartons} — ${c.totalQty} items`,
      })),
    };
  };

  return {
    openSession,
    openCarton,
    addItemToCarton,
    closeCarton,
    closeSession,
    getSessionSummary,
    getPackingManifest,
  };
};
