'use strict';
// ── Marketplace Gateway Bridge ────────────────────────────────────────────────
// Routes channel calls to the correct TypeScript gateway.
//   src/gateway/   — new adapter-pattern gateway (ZORT + direct stubs)
//   src/integrations/ — legacy adapters (Shopee, Lazada, TikTok, Shopify, API2Cart, Zetpy)
// Exposes a unified backward-compatible registry for server.js:
//   registry[platform] = { meta, fetchOrders, mapOrder, pushStatus, fetchWaybill, buildAuthUrl, exchangeCode }
// ─────────────────────────────────────────────────────────────────────────────

const { gateway }        = require('../dist/gateway');
const { gatewayService } = require('../dist/integrations');

const { buildShopifyAuthUrl, exchangeShopifyCode, normaliseShopDomain } =
  require('../dist/integrations/shopify/shopify.oauth');
const { buildLazadaAuthUrl, exchangeLazadaCode } =
  require('../dist/integrations/lazada/lazada.adapter');
const { buildShopeeAuthUrl, exchangeShopeeCode } =
  require('../dist/integrations/shopee/shopee.adapter');
const { buildTiktokAuthUrl, exchangeTiktokCode } =
  require('../dist/integrations/tiktok/tiktok.adapter');

// ── OAuth helper wrappers per channel ─────────────────────────────────────────

const oauthHelpers = {
  shopify: {
    buildAuthUrl: (creds, callbackUrl) => {
      const state = require('crypto').randomBytes(16).toString('hex');
      return buildShopifyAuthUrl(creds.shopDomain || creds.shop || '', creds.apiKey || '', callbackUrl, state);
    },
    exchangeCode: (creds, query) => {
      const shop = normaliseShopDomain(query.shop || creds.shopDomain || '');
      return exchangeShopifyCode(shop, query.code, creds.apiKey || '', creds.apiSecret || '');
    },
  },
  lazada: {
    buildAuthUrl: (creds, callbackUrl) => buildLazadaAuthUrl(creds.appKey || '', callbackUrl),
    exchangeCode: (creds, query)       => exchangeLazadaCode(creds, query.code || ''),
  },
  shopee: {
    buildAuthUrl: (creds, callbackUrl) => buildShopeeAuthUrl(creds.partnerId || '', creds.partnerKey || '', callbackUrl),
    exchangeCode: (creds, query)       => exchangeShopeeCode(creds, query.code || '', query.shop_id || ''),
  },
  tiktok: {
    buildAuthUrl: (creds, callbackUrl) => buildTiktokAuthUrl(creds.appKey || '', callbackUrl),
    exchangeCode: (creds, query)       => exchangeTiktokCode(creds, query.code || ''),
  },
  api2cart: {
    buildAuthUrl: null,
    exchangeCode: null,
  },
  zort: {
    buildAuthUrl: null,
    exchangeCode: null,
  },
};

// ── Build the backward-compatible registry — legacy channels ─────────────────

const registry = {};

for (const metaEntry of gatewayService.allMeta()) {
  const channel = metaEntry.channel;
  const adapter = gatewayService.get(channel);
  const oauth   = oauthHelpers[channel] || {};

  registry[channel] = {
    meta: {
      id:               metaEntry.id,
      name:             metaEntry.name,
      type:             metaEntry.type,
      authType:         metaEntry.authType,
      requiredForOAuth: metaEntry.requiredForOAuth || [],
      regions:          metaEntry.regions          || [],
      defaultStoreName: metaEntry.defaultStoreName || metaEntry.name,
      requiresLicense:  !!metaEntry.requiresLicense,
    },

    // fetchOrders returns already-mapped OmsOrder[]; mapOrder is identity
    fetchOrders: (creds, opts) => adapter.fetchOrders(creds, opts),
    mapOrder:    (order)       => order,

    // pushStatus bridges to pushFulfillment
    pushStatus: (creds, externalId, status, trackingNo) => {
      if (!adapter.pushFulfillment) return Promise.resolve({ skipped: true, reason: 'not supported' });
      return adapter.pushFulfillment(creds, {
        orderId:         '',
        externalOrderId: String(externalId),
        shopDomain:      creds.shopDomain,
        trackingNumber:  trackingNo || null,
        notifyCustomer:  true,
      });
    },

    // fetchWaybill (null when adapter does not implement it)
    fetchWaybill: adapter.fetchWaybill
      ? (creds, externalId) => adapter.fetchWaybill(creds, externalId)
      : null,

    // OAuth
    buildAuthUrl: oauth.buildAuthUrl || null,
    exchangeCode: oauth.exchangeCode || null,
  };
}

// ── New gateway channels (adapter-pattern, Standard Models) ──────────────────

registry['zort'] = {
  meta: {
    id:               'zort',
    name:             'ZORT',
    type:             'ecommerce',
    authType:         'apikey',
    requiredForOAuth: [],
    regions:          ['TH', 'MY', 'SG', 'ID', 'PH', 'VN'],
    defaultStoreName: 'ZORT Store',
    requiresLicense:  true,
  },
  fetchOrders: (creds, opts) => gateway.fetchOrders('zort', creds, opts),
  mapOrder: (order) => {
    if (!order) return order;
    const src = order.source || {};
    return {
      ...order,
      orderDate: order.orderDate || order.orderedAt,
      source: {
        ...src,
        type:       src.type       || src.connector,
        externalId: src.externalId || src.rawId || order.externalId,
        orderName:  src.orderName  || order.externalRef,
        ingestedAt: src.ingestedAt || src.fetchedAt,
      },
    };
  },
  pushStatus:  (creds, externalId, _status, trackingNo) =>
    gateway.pushShipment('zort', creds, {
      externalOrderId: String(externalId),
      trackingNumber:  trackingNo || '',
      notifyCustomer:  true,
    }),
  fetchWaybill:  null,
  buildAuthUrl:  null,
  exchangeCode:  null,
};

module.exports = registry;
