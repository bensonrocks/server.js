'use strict';

const registry = require('./connector-registry');

const NEXT_STATUS = {
  pending:    'confirmed',
  confirmed:  'processing',
  processing: 'packed',
  packed:     'shipped',
};

const PUSH_ON_STATUS = new Set(['packed', 'shipped']);

module.exports = function createFulfillment({ store, creds, inventory }) {

  async function fulfill(orderId, options = {}) {
    const { trackingNo=null, courier=null, autoAdvance=true, pushPlatform=true, targetStatus=null } = options;
    const order = store.getOrder(orderId);
    if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

    const previousStatus = order.status;
    const newStatus = targetStatus || (autoAdvance ? NEXT_STATUS[previousStatus] : previousStatus);
    if (!newStatus) throw new Error('Cannot advance from status: ' + previousStatus);

    const sourceFragment = { lastFulfilledAt: new Date().toISOString() };
    if (trackingNo) sourceFragment.trackingNo = trackingNo;
    if (courier)    sourceFragment.courier    = courier;

    store.updateStatusAndSource(orderId, newStatus, sourceFragment);

    // ── Inventory lifecycle ───────────────────────────────────────────────────
    let inventoryResult = null;
    if (inventory) {
      const refreshed = store.getOrder(orderId);
      // → processing: reserve items (marks them unavailable for other orders)
      if (newStatus === 'processing') {
        try { inventoryResult = inventory.reserveOrder(refreshed); } catch (e) {
          store.updateSource(orderId, { inventoryError: e.message });
        }
      }
      // → shipped: deduct stock + clear reservation (items physically left warehouse)
      if (newStatus === 'shipped') {
        try { inventoryResult = inventory.deductOrder(refreshed); } catch (e) {
          store.updateSource(orderId, { inventoryError: e.message });
        }
      }
    }

    // ── Platform push ─────────────────────────────────────────────────────────
    let platformPush = null;
    const src        = order.source || {};
    const platform   = src.type || src.connector;
    const externalId = src.externalId || src.rawId;

    if (pushPlatform && platform && externalId && registry[platform] && PUSH_ON_STATUS.has(newStatus)) {
      const c = creds.get(platform);
      if ((c?.accessToken || c?.email || c?.apikey) && registry[platform].pushStatus) {
        try {
          const result = await registry[platform].pushStatus(c, externalId, newStatus, trackingNo);
          store.updateSource(orderId, { platformPushStatus: result.skipped ? 'skipped' : 'ok', platformPushedAt: new Date().toISOString() });
          platformPush = { ok: true, platform, skipped: !!result.skipped };
        } catch (e) {
          store.updateSource(orderId, { platformPushStatus: 'error', platformPushError: e.message });
          platformPush = { ok: false, platform, error: e.message };
        }
      }
    }

    return {
      order: store.getOrder(orderId),
      previousStatus,
      newStatus,
      platformPush,
      waybillReady: newStatus === 'packed',
      inventoryResult,
    };
  }

  async function scanFulfill(code, options = {}) {
    const order = store.lookupByCode(code);
    if (!order) return null;
    const isOrderId = order.id.toLowerCase() === code.toLowerCase() || order.id.toLowerCase().includes(code.toLowerCase());
    const trackingNo = !isOrderId ? code : (options.trackingNo || null);
    const result = await fulfill(order.id, { ...options, trackingNo });
    return { ...result, trackingAttached: !!trackingNo };
  }

  async function getWaybill(orderId) {
    const order = store.getOrder(orderId);
    if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }
    const src      = order.source || {};
    const platform = src.type || src.connector;
    const extId    = src.externalId || src.rawId;
    if (!platform || !extId) throw new Error('Order has no platform source — cannot fetch waybill');
    const connector = registry[platform];
    if (!connector || !connector.fetchWaybill) throw new Error('Platform "' + platform + '" does not support waybill fetch');
    const c = creds.get(platform);
    if (!c?.accessToken && !c?.email && !c?.apikey) throw new Error(platform + ' not connected — save credentials first');
    return { platform, externalId: extId, ...(await connector.fetchWaybill(c, extId)) };
  }

  // Cancel an order — releases inventory reservation or triggers inbound return
  // depending on how far along the order was in the pipeline.
  async function cancelOrder(orderId) {
    const order = store.getOrder(orderId);
    if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }
    if (order.status === 'cancelled') throw Object.assign(new Error('Order is already cancelled'), { status: 400 });

    const previousStatus = order.status;
    store.updateStatusAndSource(orderId, 'cancelled', { cancelledAt: new Date().toISOString() });

    let inventoryResult = null;
    if (inventory) {
      try { inventoryResult = inventory.releaseOrder(order, previousStatus); } catch (e) {
        store.updateSource(orderId, { inventoryError: e.message });
      }
    }

    return { order: store.getOrder(orderId), previousStatus, newStatus: 'cancelled', inventoryResult };
  }

  // Return an order — always triggers inbound stock regardless of previous status
  // (for flexibility; typically called from shipped/delivered state).
  async function returnOrder(orderId) {
    const order = store.getOrder(orderId);
    if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }
    if (order.status === 'returned') throw Object.assign(new Error('Order is already returned'), { status: 400 });

    const previousStatus = order.status;
    store.updateStatusAndSource(orderId, 'returned', { returnedAt: new Date().toISOString() });

    let inventoryResult = null;
    if (inventory) {
      // For returns, treat as if it was shipped even if status was just processing —
      // the customer is physically sending product back, so we always inbound it.
      const effectiveStatus = inventory.DEDUCTED_STATUSES.has(previousStatus)
        ? previousStatus
        : (inventory.RESERVED_STATUSES.has(previousStatus) ? previousStatus : 'shipped');
      try { inventoryResult = inventory.releaseOrder(order, effectiveStatus); } catch (e) {
        store.updateSource(orderId, { inventoryError: e.message });
      }
    }

    return { order: store.getOrder(orderId), previousStatus, newStatus: 'returned', inventoryResult };
  }

  return { fulfill, scanFulfill, getWaybill, cancelOrder, returnOrder, NEXT_STATUS };
};
