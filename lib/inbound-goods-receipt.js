'use strict';

/**
 * Inbound Goods Receipt Module
 * Comprehensive goods receiving with SKU code reference mapping, QC inspection,
 * quarantine management, and putaway integration with WMS inventory system
 *
 * Combines best practices from both branches:
 * - Code reference mapping (client barcode → internal SKU)
 * - PO matching and validation
 * - Carton management during receipt
 * - Quality control inspection workflow
 * - Quarantine/hold functionality
 * - Putaway with location assignment
 */

module.exports = function createInboundGoodsReceipt(db, inventoryWarehouse) {

  /**
   * Create inbound goods receipt record
   * Type: 'po' (purchase order) or 'return' (from customer/vendor)
   */
  const createInbound = (options = {}) => {
    const {
      type = 'po',  // 'po' or 'return'
      poId = null,
      vendorName = '',
      lines = [],  // Array of {sku, description, orderedQty}
      notes = '',
      receivedBy = 'staff'
    } = options;

    if (!type || !['po', 'return'].includes(type)) {
      throw new Error('Type must be "po" or "return"');
    }

    const inboundId = require('crypto').randomUUID();
    const now = new Date().toISOString();
    const today = now.split('T')[0];

    // Generate inbound reference number: IB-YYYYMMDD-NNN
    const seq = generateInboundSequence(db, today);
    const inboundRef = `IB-${today.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;

    try {
      db.prepare(`
        INSERT INTO inbound_receipts (
          id, inbound_ref, type, po_id, vendor_name, status,
          received_by, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        inboundId,
        inboundRef,
        type,
        poId,
        vendorName,
        'pending',  // pending → receiving → qc_pending → putaway → completed
        receivedBy,
        notes,
        now,
        now
      );

      // Add inbound lines
      for (const line of lines) {
        const lineId = require('crypto').randomUUID();
        db.prepare(`
          INSERT INTO inbound_lines (
            id, inbound_id, sku, description, ordered_qty, received_qty,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          lineId,
          inboundId,
          line.sku,
          line.description || '',
          line.orderedQty || 0,
          0,  // Will update as items are scanned
          now
        );
      }

      return {
        inboundId,
        inboundRef,
        type,
        status: 'pending',
        lineCount: lines.length,
        createdAt: now
      };
    } catch (err) {
      throw new Error(`Failed to create inbound: ${err.message}`);
    }
  };

  /**
   * Scan item during goods receipt
   * Handles code reference mapping: physical barcode → internal SKU
   */
  const scanInboundItem = (inboundId, scannedCode, quantity = 1, options = {}) => {
    const {
      warehouseId = 'wh-main',
      batchNumber = null,
      serialNumber = null,
      expiryDate = null,
      condition = 'good'  // good, damaged, defective, expired
    } = options;

    const inbound = db.prepare(`
      SELECT * FROM inbound_receipts WHERE id = ?
    `).get(inboundId);

    if (!inbound) throw new Error('Inbound receipt not found');
    if (inbound.status === 'completed') throw new Error('Receipt already completed');

    const code = String(scannedCode).trim().toUpperCase();
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    let sku = code;
    let description = '';
    let orderedQty = 0;
    let isListed = false;

    // Try to match scanned code to a line item SKU
    const line = db.prepare(`
      SELECT * FROM inbound_lines WHERE inbound_id = ? AND UPPER(sku) = ?
    `).get(inboundId, code);

    if (line) {
      sku = line.sku;
      description = line.description;
      orderedQty = line.ordered_qty;
      isListed = true;
    } else {
      // Check if code is in SKU reference mapping (client barcode → SKU)
      const skuRef = db.prepare(`
        SELECT sku FROM sku_code_references WHERE code = ? AND is_active = 1
      `).get(code);

      if (skuRef) {
        sku = skuRef.sku;
        isListed = false;  // Unlisted but mapped
      }
    }

    // Update inbound line received qty
    if (line) {
      db.prepare(`
        UPDATE inbound_lines SET received_qty = received_qty + ? WHERE id = ?
      `).run(qty, line.id);
    }

    // Create scan record for audit trail
    const scanId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO inbound_scans (
        id, inbound_id, scanned_code, sku, qty, batch_number, serial_number,
        expiry_date, condition, is_listed, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scanId,
      inboundId,
      code,
      sku,
      qty,
      batchNumber,
      serialNumber,
      expiryDate,
      condition,
      isListed ? 1 : 0,
      now
    );

    return {
      scanId,
      code,
      sku,
      description,
      quantity: qty,
      orderedQty,
      isListed,
      condition,
      batchNumber,
      serialNumber,
      expiryDate
    };
  };

  /**
   * Quality Control (QC) Inspection
   */
  const createQCInspection = (inboundId, options = {}) => {
    const {
      inspectorName = 'QC Staff',
      notes = ''
    } = options;

    const inbound = db.prepare(`
      SELECT * FROM inbound_receipts WHERE id = ?
    `).get(inboundId);

    if (!inbound) throw new Error('Inbound not found');

    const qcId = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO inbound_qc_inspections (
        id, inbound_id, inspector_name, status, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      qcId,
      inboundId,
      inspectorName,
      'in_progress',
      notes,
      now
    );

    // Update inbound status
    db.prepare(`
      UPDATE inbound_receipts SET status = 'qc_pending' WHERE id = ?
    `).run(inboundId);

    return { qcId, inboundId, status: 'in_progress' };
  };

  /**
   * Record QC inspection result for a scan
   */
  const recordQCResult = (qcId, scanId, result, notes = '') => {
    const {
      decision = 'accept',  // accept, reject, quarantine
      damageType = null
    } = result;

    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO inbound_qc_results (
        id, qc_inspection_id, scan_id, decision, damage_type, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      require('crypto').randomUUID(),
      qcId,
      scanId,
      decision,
      damageType,
      notes,
      now
    );

    return { decision, damageType, notes };
  };

  /**
   * Quarantine items pending QC/manager review
   */
  const quarantineItems = (inboundId, scanIds, reason = '', approvalRequired = true) => {
    const now = new Date().toISOString();

    for (const scanId of scanIds) {
      db.prepare(`
        UPDATE inbound_scans
        SET status = 'quarantined', quarantine_reason = ?, quarantine_date = ?
        WHERE id = ?
      `).run(reason, now, scanId);
    }

    return {
      quarantineId: require('crypto').randomUUID(),
      inboundId,
      itemCount: scanIds.length,
      reason,
      approvalRequired,
      createdAt: now
    };
  };

  /**
   * Release quarantined items (manager approval)
   */
  const releaseQuarantine = (inboundId, scanIds, approverName = '', decision = 'accept') => {
    const now = new Date().toISOString();

    for (const scanId of scanIds) {
      db.prepare(`
        UPDATE inbound_scans
        SET status = ?, quarantine_released_at = ?, released_by = ?
        WHERE id = ?
      `).run(decision === 'accept' ? 'ready_putaway' : 'rejected', now, approverName, scanId);
    }

    return {
      releasedCount: scanIds.length,
      decision,
      approver: approverName,
      releasedAt: now
    };
  };

  /**
   * Putaway: Assign location and create inventory batches
   */
  const putawayItems = (inboundId, assignments = []) => {
    const now = new Date().toISOString();
    const movements = [];

    for (const assignment of assignments) {
      const {
        scanId,
        warehouseId = 'wh-main',
        locationBin,
        quantity
      } = assignment;

      const scan = db.prepare(`
        SELECT * FROM inbound_scans WHERE id = ?
      `).get(scanId);

      if (!scan) continue;

      // Create inventory batch record
      const batchId = require('crypto').randomUUID();

      db.prepare(`
        INSERT INTO inventory_batches (
          id, warehouse_id, sku_id, batch_number, serial_number,
          expiry_date, received_qty, available_qty, allocated_qty,
          picked_qty, damaged_qty, scrap_qty, received_at, location_bin
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        warehouseId,
        scan.sku,
        scan.batch_number || null,
        scan.serial_number || null,
        scan.expiry_date || null,
        quantity,
        quantity,
        0, 0, 0, 0,
        now,
        locationBin
      );

      // Log inventory movement
      db.prepare(`
        INSERT INTO inventory_movements (
          sku_id, warehouse_id, movement_type, quantity, batch_id,
          inbound_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        scan.sku,
        warehouseId,
        'received',
        quantity,
        batchId,
        inboundId,
        now
      );

      // Mark scan as putaway complete
      db.prepare(`
        UPDATE inbound_scans SET status = 'putaway_complete', putaway_date = ? WHERE id = ?
      `).run(now, scanId);

      movements.push({
        scanId,
        batchId,
        sku: scan.sku,
        quantity,
        location: locationBin,
        movement: 'received'
      });
    }

    return {
      inboundId,
      putawayCount: movements.length,
      movements,
      completedAt: now
    };
  };

  /**
   * Complete goods receipt
   */
  const completeReceipt = (inboundId, receivedBy = '') => {
    const inbound = db.prepare(`
      SELECT * FROM inbound_receipts WHERE id = ?
    `).get(inboundId);

    if (!inbound) throw new Error('Inbound not found');

    // Verify all items are either accepted or rejected (none pending)
    const pending = db.prepare(`
      SELECT COUNT(*) as count FROM inbound_scans
      WHERE inbound_id = ? AND status IN ('pending', 'quarantined')
    `).get(inboundId);

    if (pending.count > 0) {
      throw new Error(`Cannot complete: ${pending.count} items still pending QC or quarantine`);
    }

    const now = new Date().toISOString();

    db.prepare(`
      UPDATE inbound_receipts
      SET status = 'completed', completed_at = ?, received_by = ?
      WHERE id = ?
    `).run(now, receivedBy, inboundId);

    // Get summary
    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_items,
        SUM(CASE WHEN status = 'putaway_complete' THEN qty ELSE 0 END) as accepted_qty,
        SUM(CASE WHEN status = 'rejected' THEN qty ELSE 0 END) as rejected_qty,
        COUNT(DISTINCT sku) as unique_skus
      FROM inbound_scans WHERE inbound_id = ?
    `).get(inboundId);

    return {
      inboundId,
      status: 'completed',
      summary,
      completedAt: now
    };
  };

  /**
   * Get inbound summary with variances
   */
  const getInboundSummary = (inboundId) => {
    const inbound = db.prepare(`
      SELECT * FROM inbound_receipts WHERE id = ?
    `).get(inboundId);

    if (!inbound) return null;

    const lines = db.prepare(`
      SELECT * FROM inbound_lines WHERE inbound_id = ? ORDER BY sku
    `).all(inboundId);

    const scans = db.prepare(`
      SELECT * FROM inbound_scans WHERE inbound_id = ? ORDER BY created_at
    `).all(inboundId);

    // Calculate variances
    const variances = lines.map(line => {
      const received = scans
        .filter(s => s.sku === line.sku && s.status !== 'rejected')
        .reduce((sum, s) => sum + s.qty, 0);

      return {
        sku: line.sku,
        description: line.description,
        ordered: line.ordered_qty,
        received,
        variance: received - line.ordered_qty,
        variancePct: line.ordered_qty > 0 ? Math.round((received - line.ordered_qty) / line.ordered_qty * 100) : 0
      };
    });

    return {
      inboundId,
      inboundRef: inbound.inbound_ref,
      type: inbound.type,
      status: inbound.status,
      vendor: inbound.vendor_name,
      scanCount: scans.length,
      lineCount: lines.length,
      variances
    };
  };

  /**
   * Create SKU code reference (for code → SKU mapping)
   */
  const createSKUCodeReference = (code, skuId, description = '', clientName = '') => {
    const refId = require('crypto').randomUUID();

    db.prepare(`
      INSERT INTO sku_code_references (
        id, code, sku, description, client_name, is_active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      refId,
      code.toUpperCase(),
      skuId,
      description,
      clientName,
      1,
      new Date().toISOString()
    );

    return { refId, code: code.toUpperCase(), sku: skuId };
  };

  /**
   * Get inbound receiving status (real-time dashboard)
   */
  const getReceivingStatus = (warehouseId = 'wh-main') => {
    const active = db.prepare(`
      SELECT COUNT(*) as count FROM inbound_receipts
      WHERE status IN ('pending', 'receiving', 'qc_pending')
    `).get();

    const scans = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'putaway_complete' THEN qty ELSE 0 END) as accepted,
        SUM(CASE WHEN status = 'rejected' THEN qty ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'quarantined' THEN qty ELSE 0 END) as quarantined
      FROM inbound_scans
      JOIN inbound_receipts ON inbound_scans.inbound_id = inbound_receipts.id
      WHERE inbound_receipts.status IN ('pending', 'receiving', 'qc_pending')
    `).get();

    return {
      warehouseId,
      activeReceipts: active.count || 0,
      scannedItems: {
        total: scans.total || 0,
        accepted: scans.accepted || 0,
        rejected: scans.rejected || 0,
        quarantined: scans.quarantined || 0
      }
    };
  };

  // Helper: Generate inbound sequence number
  function generateInboundSequence(db, date) {
    const key = `inbound_seq_${date}`;
    db.inboundSeq = db.inboundSeq || {};
    db.inboundSeq[key] = (db.inboundSeq[key] || 0) + 1;
    return db.inboundSeq[key];
  }

  return {
    createInbound,
    scanInboundItem,
    createQCInspection,
    recordQCResult,
    quarantineItems,
    releaseQuarantine,
    putawayItems,
    completeReceipt,
    getInboundSummary,
    createSKUCodeReference,
    getReceivingStatus
  };
};
