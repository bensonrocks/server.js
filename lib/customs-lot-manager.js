'use strict';

/**
 * Singapore Customs Lot Manager
 * Manages immutable customs lot numbers for export tracking
 * Once assigned, a customs lot number CANNOT be reused or reassigned
 */
module.exports = function createCustomsLotManager(db) {

  // Initialize or reset the customs lot sequence
  const initializeSequence = (options = {}) => {
    const {
      prefix = 'SG-CUST',
      year = new Date().getFullYear(),
      startingNumber = 1
    } = options;

    try {
      // Delete existing sequence (fresh start)
      db.prepare('DELETE FROM customs_lot_sequences').run();

      // Create new sequence
      db.prepare(`
        INSERT INTO customs_lot_sequences (
          id, prefix, year, current_number, last_assigned_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        1,
        prefix,
        year,
        startingNumber - 1,  // Will be incremented on first use
        null,
        new Date().toISOString(),
        new Date().toISOString()
      );

      return {
        prefix,
        year,
        nextNumber: startingNumber,
        initialized: true,
      };
    } catch (err) {
      throw new Error(`Failed to initialize sequence: ${err.message}`);
    }
  };

  // Get next customs lot number (and increment counter)
  const getNextCustomsLotNumber = () => {
    try {
      const seq = db.prepare('SELECT * FROM customs_lot_sequences WHERE id = 1').get();

      if (!seq) {
        throw new Error('Customs lot sequence not initialized. Call initializeSequence first.');
      }

      const newNumber = seq.current_number + 1;
      const customsLotNumber = `${seq.prefix}-${seq.year}-${String(newNumber).padStart(6, '0')}`;

      // Update sequence
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE customs_lot_sequences
        SET current_number = ?, last_assigned_at = ?, updated_at = ?
        WHERE id = 1
      `).run(newNumber, now, now);

      return {
        customsLotNumber,
        sequence: newNumber,
        year: seq.year,
      };
    } catch (err) {
      throw new Error(`Failed to get next lot number: ${err.message}`);
    }
  };

  // Assign customs lot to carton (IMMUTABLE - cannot be changed)
  const assignCustomsLot = (data) => {
    const {
      cartonId,
      poId = null,
      orderId = null,
      hsCode = null,
      description = '',
      totalPieces = null,
      grossWeightKg = null,
    } = data;

    if (!cartonId) {
      throw new Error('cartonId is required');
    }

    try {
      // Check if carton already has a customs lot
      const existing = db.prepare(
        'SELECT * FROM customs_lots WHERE carton_id = ?'
      ).get(cartonId);

      if (existing) {
        throw new Error(`Carton ${cartonId} already has customs lot: ${existing.customs_lot_number}`);
      }

      // Get next lot number
      const lotInfo = getNextCustomsLotNumber();
      const now = new Date().toISOString();

      // Create customs lot record
      const customsLotId = require('crypto').randomUUID();

      db.prepare(`
        INSERT INTO customs_lots (
          id, customs_lot_number, carton_id, po_id, order_id,
          hs_code, description, total_pieces, gross_weight_kg,
          assigned_at, locked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customsLotId,
        lotInfo.customsLotNumber,
        cartonId,
        poId,
        orderId,
        hsCode,
        description,
        totalPieces,
        grossWeightKg,
        now,
        now,  // Immediately locked (immutable)
        now
      );

      return {
        customsLotId,
        customsLotNumber: lotInfo.customsLotNumber,
        cartonId,
        status: 'locked',
        assignedAt: now,
      };
    } catch (err) {
      throw new Error(`Failed to assign customs lot: ${err.message}`);
    }
  };

  // Get customs lot for a carton
  const getCustomsLot = (cartonId) => {
    const lot = db.prepare(
      'SELECT * FROM customs_lots WHERE carton_id = ?'
    ).get(cartonId);

    if (!lot) {
      return null;
    }

    return {
      id: lot.id,
      customsLotNumber: lot.customs_lot_number,
      cartonId: lot.carton_id,
      poId: lot.po_id,
      orderId: lot.order_id,
      hsCode: lot.hs_code,
      description: lot.description,
      totalPieces: lot.total_pieces,
      grossWeightKg: lot.gross_weight_kg,
      assignedAt: lot.assigned_at,
      locked: lot.locked_at !== null,
      exported: lot.exported_at !== null,
      exportedAt: lot.exported_at,
    };
  };

  // Validate customs lot is locked (before export)
  const validateCustomsLot = (customsLotId) => {
    const lot = db.prepare(
      'SELECT * FROM customs_lots WHERE id = ?'
    ).get(customsLotId);

    if (!lot) {
      throw new Error('Customs lot not found');
    }

    if (!lot.locked_at) {
      throw new Error('Customs lot is not locked');
    }

    if (lot.exported_at) {
      throw new Error('Customs lot already exported');
    }

    return {
      customsLotNumber: lot.customs_lot_number,
      locked: true,
      canExport: true,
    };
  };

  // Mark customs lot as exported
  const markAsExported = (customsLotId, shippingRefNo = null) => {
    try {
      // Validate before export
      validateCustomsLot(customsLotId);

      const now = new Date().toISOString();

      db.prepare(`
        UPDATE customs_lots
        SET exported_at = ?, notes = ?
        WHERE id = ?
      `).run(
        now,
        shippingRefNo ? `Shipping Reference: ${shippingRefNo}` : null,
        customsLotId
      );

      const lot = db.prepare('SELECT * FROM customs_lots WHERE id = ?').get(customsLotId);

      return {
        customsLotNumber: lot.customs_lot_number,
        cartonId: lot.carton_id,
        exportedAt: now,
        status: 'exported',
      };
    } catch (err) {
      throw new Error(`Failed to mark as exported: ${err.message}`);
    }
  };

  // List all pending customs lots (not exported)
  const listPendingCustomsLots = (warehouseId = null) => {
    let sql = `
      SELECT cl.*, c.order_id, o.warehouse_id
      FROM customs_lots cl
      JOIN cartons c ON cl.carton_id = c.id
      LEFT JOIN orders o ON c.order_id = o.id
      WHERE cl.exported_at IS NULL
      ORDER BY cl.assigned_at DESC
    `;

    if (warehouseId) {
      sql = sql.replace('WHERE', `WHERE o.warehouse_id = '${warehouseId}' AND`);
    }

    const lots = db.prepare(sql).all();

    return lots.map(lot => ({
      customsLotId: lot.id,
      customsLotNumber: lot.customs_lot_number,
      cartonId: lot.carton_id,
      orderId: lot.order_id,
      poId: lot.po_id,
      hsCode: lot.hs_code,
      description: lot.description,
      assignedAt: lot.assigned_at,
      locked: lot.locked_at !== null,
      warehouse: lot.warehouse_id,
    }));
  };

  // Get complete audit trail for a customs lot
  const getCustomsLotAudit = (customsLotId) => {
    const lot = db.prepare(
      'SELECT * FROM customs_lots WHERE id = ?'
    ).get(customsLotId);

    if (!lot) {
      throw new Error('Customs lot not found');
    }

    // Get related inventory movements
    const movements = db.prepare(`
      SELECT * FROM inventory_movements
      WHERE customs_lot_id = ?
      ORDER BY created_at DESC
    `).all(customsLotId);

    return {
      customsLot: {
        id: lot.id,
        customsLotNumber: lot.customs_lot_number,
        cartonId: lot.carton_id,
        poId: lot.po_id,
        orderId: lot.order_id,
        hsCode: lot.hs_code,
        description: lot.description,
        totalPieces: lot.total_pieces,
        grossWeightKg: lot.gross_weight_kg,
      },
      timeline: {
        assignedAt: lot.assigned_at,
        lockedAt: lot.locked_at,
        exportedAt: lot.exported_at,
        status: lot.exported_at ? 'exported' : (lot.locked_at ? 'locked' : 'pending'),
      },
      movements: movements.map(m => ({
        type: m.movement_type,
        quantity: m.quantity,
        timestamp: m.created_at,
        reason: m.reason,
      })),
    };
  };

  // Get sequence info
  const getSequenceInfo = () => {
    const seq = db.prepare('SELECT * FROM customs_lot_sequences WHERE id = 1').get();

    if (!seq) {
      return {
        initialized: false,
        message: 'Sequence not initialized',
      };
    }

    return {
      initialized: true,
      prefix: seq.prefix,
      year: seq.year,
      currentNumber: seq.current_number,
      nextNumber: seq.current_number + 1,
      lastAssignedAt: seq.last_assigned_at,
    };
  };

  return {
    initializeSequence,
    getNextCustomsLotNumber,
    assignCustomsLot,
    getCustomsLot,
    validateCustomsLot,
    markAsExported,
    listPendingCustomsLots,
    getCustomsLotAudit,
    getSequenceInfo,
  };
};
