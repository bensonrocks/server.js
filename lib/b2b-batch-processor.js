'use strict';

/**
 * B2B Batch Processor
 * Converts approved POs into internal orders and picking waves
 * Handles multi-store consolidation and wave optimization
 */
module.exports = function createB2BBatchProcessor(db) {

  const processPODocument = (poId) => {
    const poManager = require('./po-manager')(db);
    const po = poManager.getPODocument(poId);

    if (!po) throw new Error('PO not found');
    if (po.validationErrors && po.validationErrors.length > 0) {
      throw new Error('Cannot process PO with validation errors');
    }

    // Group line items by destination store
    const storeGroups = {};
    po.lineItems.forEach(item => {
      const store = item.destination_store || 'default';
      if (!storeGroups[store]) storeGroups[store] = [];
      storeGroups[store].push(item);
    });

    // Create internal order per store
    const orders = [];
    Object.entries(storeGroups).forEach(([store, items]) => {
      const order = createInternalOrder(po, store, items);
      orders.push(order);
    });

    // Suggest wave mode for retail consolidation (same SKU across stores)
    const waveSuggestion = suggestRetailWave(orders, po);

    return {
      poId,
      po_number: po.poNumber,
      orders_created: orders.length,
      orders,
      wave_suggestion: waveSuggestion,
      status: 'processed',
    };
  };

  const createInternalOrder = (po, destinationStore, lineItems) => {
    const orderId = `${po.poNumber}-${destinationStore}`.replace(/\s+/g, '_');
    const now = new Date().toISOString();

    try {
      // Insert order
      db.prepare(`
        INSERT OR IGNORE INTO orders (
          id, client_id, client_name, channel, order_date, status, currency, notes,
          order_type, po_number, upload_source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId,
        po.clientId,
        po.clientName,
        'b2b',
        po.poDate,
        'pending',
        'SGD',
        `B2B Order - Store: ${destinationStore}`,
        'b2b',
        po.poNumber,
        'po_import',
        now,
        now
      );

      // Insert order lines
      lineItems.forEach((item, idx) => {
        const lineId = require('crypto').randomUUID();
        db.prepare(`
          INSERT INTO order_lines (
            id, order_id, sku_code, sku_name, ordered_qty, line_number,
            serial_number, batch_number, expiry_date, length_cm, width_cm, height_cm, weight_kg,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          lineId,
          orderId,
          item.sku_code,
          item.sku_name || '',
          item.qty,
          idx + 1,
          item.serial_number || '',
          item.batch_number || '',
          item.expiry_date || null,
          item.length_cm || null,
          item.width_cm || null,
          item.height_cm || null,
          item.weight_kg || null,
          new Date().toISOString()
        );
      });

      return {
        order_id: orderId,
        destination_store: destinationStore,
        line_count: lineItems.length,
        total_qty: lineItems.reduce((s, l) => s + (l.qty || 0), 0),
        created: true,
      };
    } catch (err) {
      return {
        order_id: orderId,
        destination_store: destinationStore,
        error: err.message,
        created: false,
      };
    }
  };

  const suggestRetailWave = (orders, po) => {
    if (orders.length < 2) {
      return {
        mode: 'single',
        reason: 'Only one destination store',
        saved_trips: 0,
      };
    }

    // Analyze SKU overlap across stores
    const skuMap = {};
    orders.forEach(order => {
      db.prepare(`
        SELECT sku_code, ordered_qty FROM order_lines WHERE order_id = ?
      `).all(order.order_id).forEach(line => {
        if (!skuMap[line.sku_code]) skuMap[line.sku_code] = [];
        skuMap[line.sku_code].push({
          store: order.destination_store,
          qty: line.ordered_qty,
        });
      });
    });

    // Count shared SKUs
    const sharedSkus = Object.entries(skuMap)
      .filter(([_, stores]) => stores.length > 1)
      .length;

    const totalSkus = Object.keys(skuMap).length;
    const overlapPct = totalSkus > 0 ? Math.round((sharedSkus / totalSkus) * 100) : 0;
    const savedTrips = sharedSkus; // Each shared SKU = 1 saved trip (consolidated pick)

    return {
      mode: sharedSkus > 0 ? 'batch' : 'single',
      shared_skus: sharedSkus,
      total_skus: totalSkus,
      overlap_pct: overlapPct,
      saved_trips: savedTrips,
      reason: sharedSkus > 0
        ? `Batch picking: ${sharedSkus} SKUs shared across stores (save ${savedTrips} trips)`
        : 'No shared SKUs - pick separately per store',
    };
  };

  const autoStageCarton = (cartonId, poId = null) => {
    const now = new Date().toISOString();

    try {
      db.prepare(`
        INSERT INTO staging_area (id, carton_id, po_id, status, received_at)
        VALUES (?, ?, ?, 'staged', ?)
      `).run(
        require('crypto').randomUUID(),
        cartonId,
        poId || null,
        now
      );

      return { cartonId, status: 'staged', staged_at: now };
    } catch (err) {
      throw new Error(`Failed to stage carton: ${err.message}`);
    }
  };

  const releaseStagedCartons = (poId) => {
    const now = new Date().toISOString();

    try {
      const result = db.prepare(`
        UPDATE staging_area
        SET status = 'released', released_at = ?
        WHERE po_id = ? AND status = 'staged'
      `).run(now, poId);

      return {
        po_id: poId,
        cartons_released: result.changes || 0,
        released_at: now,
      };
    } catch (err) {
      throw new Error(`Failed to release cartons: ${err.message}`);
    }
  };

  return {
    processPODocument,
    createInternalOrder,
    suggestRetailWave,
    autoStageCarton,
    releaseStagedCartons,
  };
};
