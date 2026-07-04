'use strict';

const store     = require('./store');
const creds     = require('./credentials');
const inventory = require('./inventory');
const lazada  = require('./marketplace/lazada');
const shopee  = require('./marketplace/shopee');
const tiktok  = require('./marketplace/tiktok');
const shopify = require('./marketplace/shopify');

// confirmed→processing = picking, processing→packed = packing done, packed→shipped = dispatched
const NEXT_STATUS = {
  pending:    'confirmed',
  confirmed:  'processing',
  processing: 'packed',
  packed:     'shipped',
};

// Statuses that trigger a ready-to-ship push to the platform
const PUSH_ON_STATUS = new Set(['packed', 'shipped']);

const PLATFORM_CLIENTS = { lazada, shopee, tiktok, shopify };

async function fulfill(orderId, options = {}) {
  const {
    trackingNo   = null,
    courier      = null,
    autoAdvance  = true,
    pushPlatform = true,
    targetStatus = null,
  } = options;

  const order = store.getOrder(orderId);
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

  const previousStatus = order.status;
  const newStatus = targetStatus || (autoAdvance ? NEXT_STATUS[previousStatus] : previousStatus);
  if (!newStatus) throw new Error(`Cannot advance from status: ${previousStatus}`);

  const sourceFragment = { lastFulfilledAt: new Date().toISOString() };
  if (trackingNo) sourceFragment.trackingNo = trackingNo;
  if (courier)    sourceFragment.courier    = courier;

  store.updateStatusAndSource(orderId, newStatus, sourceFragment);

  let platformPush = null;
  const src        = order.source || {};
  const platform   = src.type;
  const externalId = src.externalId;

  if (pushPlatform && platform && externalId && PLATFORM_CLIENTS[platform] && PUSH_ON_STATUS.has(newStatus)) {
    const c = creds.get(platform);
    if (c?.accessToken) {
      try {
        const result = await PLATFORM_CLIENTS[platform].pushStatus(c, externalId, newStatus, trackingNo);
        store.updateSource(orderId, {
          platformPushStatus: result.skipped ? 'skipped' : 'ok',
          platformPushedAt:   new Date().toISOString(),
        });
        platformPush = { ok: true, platform, skipped: !!result.skipped };
      } catch (e) {
        store.updateSource(orderId, { platformPushStatus: 'error', platformPushError: e.message });
        platformPush = { ok: false, platform, error: e.message };
      }
    }
  }

  // When order becomes packed: deduct inventory and flag waybill ready
  let inventoryDeductions = null;
  if (newStatus === 'packed') {
    try { inventoryDeductions = inventory.deductOrder(store.getOrder(orderId)); } catch {}
  }

  const waybillReady = newStatus === 'packed';
  return { order: store.getOrder(orderId), previousStatus, newStatus, platformPush, waybillReady, inventoryDeductions };
}

async function scanFulfill(code, options = {}) {
  const order = store.lookupByCode(code);
  if (!order) return null;

  const isOrderId = order.id.toLowerCase() === code.toLowerCase()
    || order.id.toLowerCase().includes(code.toLowerCase());
  const trackingNo = !isOrderId ? code : (options.trackingNo || null);

  const result = await fulfill(order.id, { ...options, trackingNo });
  return { ...result, trackingAttached: !!trackingNo };
}

// Fetch waybill document from source platform
async function getWaybill(orderId) {
  const order = store.getOrder(orderId);
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

  const src        = order.source || {};
  const platform   = src.type;
  const externalId = src.externalId;

  if (!platform || !externalId) throw new Error('Order has no platform source — cannot fetch waybill');
  if (!PLATFORM_CLIENTS[platform]) throw new Error(`Platform "${platform}" does not support waybill fetch`);

  const c = creds.get(platform);
  if (!c?.accessToken) throw new Error(`${platform} not connected — save credentials first`);

  // Platform-specific waybill fetch
  let waybill;
  if (platform === 'lazada') {
    const itemIds = src.orderItemIds || [externalId];
    waybill = await lazada.getWaybill(c, externalId, itemIds);
  } else if (platform === 'shopee') {
    waybill = await shopee.getWaybill(c, externalId);
  } else if (platform === 'tiktok') {
    const packageId = src.packageId || externalId;
    waybill = await tiktok.getWaybill(c, packageId);
  } else if (platform === 'shopify') {
    waybill = await shopify.getWaybill(c, externalId);
  }

  return { platform, externalId, ...waybill };
}

module.exports = { fulfill, scanFulfill, getWaybill, NEXT_STATUS };
