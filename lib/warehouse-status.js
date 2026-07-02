'use strict';

// Read-only fulfillment status, combining pick/pack/ship data into a simple
// per-order summary. Used by the client portal (their own orders only) and
// the staff support overview (aggregate counts, cross-tenant).

module.exports = function createFulfillmentStatus(db) {
  function getForOrder(orderId) {
    const tasks = db.prepare(`
      SELECT t.*, w.wave_number, w.status AS wave_status
      FROM pick_tasks t JOIN pick_waves w ON w.id = t.wave_id
      WHERE t.order_id = ? ORDER BY t.created_at DESC
    `).all(orderId);

    const packOrder = db.prepare(`SELECT * FROM pack_orders WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`).get(orderId);
    const shipment  = packOrder ? db.prepare(`SELECT * FROM shipments WHERE pack_order_id = ?`).get(packOrder.id) : null;

    let pick = { stage: 'not_started' };
    if (tasks.length) {
      const anyPicked = tasks.some(t => t.status === 'picked' || t.status === 'short');
      const stage = tasks[0].wave_status === 'completed' ? 'picked'
        : tasks[0].wave_status === 'cancelled' ? 'cancelled'
        : anyPicked ? 'in_progress' : 'pending';
      pick = { stage, waveNumber: tasks[0].wave_number, waveStatus: tasks[0].wave_status, taskCount: tasks.length };
    }

    const pack = packOrder
      ? { stage: packOrder.status, packNumber: packOrder.pack_number, boxCount: packOrder.box_count }
      : { stage: 'not_started' };

    const ship = shipment
      ? {
          shipmentNumber: shipment.shipment_number, carrier: shipment.carrier, service: shipment.service,
          trackingNo: shipment.tracking_no, status: shipment.status, shippedAt: shipment.shipped_at,
          estDelivery: shipment.est_delivery,
        }
      : null;

    return { orderId, pick, pack, shipment: ship };
  }

  function getForOrders(orderIds) {
    return orderIds.map(getForOrder);
  }

  // Aggregate counts for a support/health view — no order-level detail.
  function getOverview() {
    const openWaves    = db.prepare(`SELECT COUNT(*) AS n FROM pick_waves WHERE status IN ('open','in_progress')`).get().n;
    const pendingPrint = db.prepare(`SELECT COUNT(*) AS n FROM print_queue WHERE status = 'pending'`).get().n;
    const totalItems   = db.prepare(`SELECT COUNT(*) AS n FROM inventory_items`).get().n;
    const lastMove     = db.prepare(`SELECT MAX(created_at) AS t FROM inventory_moves`).get().t;
    return { openWaves, pendingPrint, totalItems, lastActivityAt: lastMove };
  }

  return { getForOrder, getForOrders, getOverview };
};
