'use strict';

const store   = require('./store');
const creds   = require('./credentials');
const lazada  = require('./marketplace/lazada');
const shopee  = require('./marketplace/shopee');
const tiktok  = require('./marketplace/tiktok');
const shopify = require('./marketplace/shopify');

const NEXT_STATUS = {
  pending:    'confirmed',
  confirmed:  'processing',
  processing: 'shipped',
};

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

  if (pushPlatform && platform && externalId && PLATFORM_CLIENTS[platform]) {
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

  return { order: store.getOrder(orderId), previousStatus, newStatus, platformPush };
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

module.exports = { fulfill, scanFulfill, NEXT_STATUS };
