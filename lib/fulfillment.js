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

    let platformPush = null;
    const src        = order.source || {};
    const platform   = src.type;
    const externalId = src.externalId;

    if (pushPlatform && platform && externalId && registry[platform] && PUSH_ON_STATUS.has(newStatus)) {
      const c = creds.get(platform);
      if (c?.accessToken && registry[platform].pushStatus) {
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

    let inventoryDeductions = null;
    if (newStatus === 'packed' && inventory) {
      try { inventoryDeductions = inventory.deductOrder(store.getOrder(orderId)); } catch {}
    }

    return { order: store.getOrder(orderId), previousStatus, newStatus, platformPush, waybillReady: newStatus === 'packed', inventoryDeductions };
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
    const platform = src.type;
    const extId    = src.externalId;
    if (!platform || !extId) throw new Error('Order has no platform source — cannot fetch waybill');
    const connector = registry[platform];
    if (!connector || !connector.fetchWaybill) throw new Error('Platform "' + platform + '" does not support waybill fetch');
    const c = creds.get(platform);
    if (!c?.accessToken) throw new Error(platform + ' not connected — save credentials first');
    return { platform, externalId: extId, ...(await connector.fetchWaybill(c, extId)) };
  }

  return { fulfill, scanFulfill, getWaybill, NEXT_STATUS };
};
