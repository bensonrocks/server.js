"use strict";
// ─────────────────────────────────────────────────────────────────────────────
//  IdealOne OMS — Marketplace Gateway
//  Registers all adapters into the central gateway service.
// ─────────────────────────────────────────────────────────────────────────────
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.gatewayService = void 0;
__exportStar(require("./marketplace-gateway/marketplace.types"), exports);
__exportStar(require("./marketplace-gateway/marketplace-gateway.service"), exports);
__exportStar(require("./shopify/shopify.adapter"), exports);
__exportStar(require("./shopify/shopify.mapper"), exports);
__exportStar(require("./shopify/shopify.oauth"), exports);
__exportStar(require("./shopify/shopify.webhooks"), exports);
__exportStar(require("./api2cart/api2cart.adapter"), exports);
__exportStar(require("./api2cart/api2cart.mapper"), exports);
__exportStar(require("./lazada/lazada.adapter"), exports);
__exportStar(require("./shopee/shopee.adapter"), exports);
__exportStar(require("./tiktok/tiktok.adapter"), exports);
// ── Wire up the singleton gateway ────────────────────────────────────────────
const marketplace_gateway_service_1 = require("./marketplace-gateway/marketplace-gateway.service");
Object.defineProperty(exports, "gatewayService", { enumerable: true, get: function () { return marketplace_gateway_service_1.gatewayService; } });
const shopify_adapter_1 = require("./shopify/shopify.adapter");
const shopify_oauth_1 = require("./shopify/shopify.oauth");
const api2cart_adapter_1 = require("./api2cart/api2cart.adapter");
const lazada_adapter_1 = require("./lazada/lazada.adapter");
const shopee_adapter_1 = require("./shopee/shopee.adapter");
const tiktok_adapter_1 = require("./tiktok/tiktok.adapter");
marketplace_gateway_service_1.gatewayService
    .register(shopify_adapter_1.shopifyAdapter, shopify_oauth_1.shopifyOAuthMeta)
    .register(lazada_adapter_1.lazadaAdapter, lazada_adapter_1.lazadaOAuthMeta)
    .register(shopee_adapter_1.shopeeAdapter, shopee_adapter_1.shopeeOAuthMeta)
    .register(tiktok_adapter_1.tiktokAdapter, tiktok_adapter_1.tiktokOAuthMeta)
    .register(api2cart_adapter_1.api2CartAdapter, api2cart_adapter_1.api2CartOAuthMeta);
//# sourceMappingURL=index.js.map