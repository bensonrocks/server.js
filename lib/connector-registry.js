'use strict';
// ── Marketplace Gateway Bridge ────────────────────────────────────────────────
// Delegates all connector work to the compiled TypeScript gateway in dist/.
// Maintains backward-compatible interface:
//   registry[platform] = { meta, fetchOrders, mapOrder, pushStatus, fetchWaybill, buildAuthUrl, exchangeCode }
// ─────────────────────────────────────────────────────────────────────────────

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
};

// ── Build the backward-compatible registry ────────────────────────────────────

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

module.exports = registry;
