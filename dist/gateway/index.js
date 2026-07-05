"use strict";
// ─────────────────────────────────────────────────────────────────────────────
//  IDEALone Marketplace Gateway — public surface
//
//  OMS modules MUST only import from this barrel.
//  Adapter-internal types (ZortOrder, ZortCredentials, etc.) are deliberately
//  NOT exported here — they must never appear in OMS business logic.
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.gateway = exports.auditLogService = exports.MarketplaceGatewayService = void 0;
// ── Gateway service ───────────────────────────────────────────────────────────
var gateway_service_1 = require("./gateway.service");
Object.defineProperty(exports, "MarketplaceGatewayService", { enumerable: true, get: function () { return gateway_service_1.MarketplaceGatewayService; } });
// ── Audit log (admin / diagnostic use — not for OMS business logic) ──────────
var audit_log_service_1 = require("./audit/audit-log.service");
Object.defineProperty(exports, "auditLogService", { enumerable: true, get: function () { return audit_log_service_1.auditLogService; } });
// ── Pre-wired singleton ────────────────────────────────────────────────────────
const gateway_service_2 = require("./gateway.service");
const zort_adapter_1 = require("./adapters/zort/zort.adapter");
const shopee_direct_adapter_1 = require("./adapters/shopee-direct/shopee-direct.adapter");
const lazada_direct_adapter_1 = require("./adapters/lazada-direct/lazada-direct.adapter");
const tiktok_direct_adapter_1 = require("./adapters/tiktok-direct/tiktok-direct.adapter");
const shopify_direct_adapter_1 = require("./adapters/shopify-direct/shopify-direct.adapter");
exports.gateway = new gateway_service_2.MarketplaceGatewayService()
    .register(zort_adapter_1.zortAdapter)
    .register(shopee_direct_adapter_1.shopeeDirectAdapter)
    .register(lazada_direct_adapter_1.lazadaDirectAdapter)
    .register(tiktok_direct_adapter_1.tiktokDirectAdapter)
    .register(shopify_direct_adapter_1.shopifyDirectAdapter);
//# sourceMappingURL=index.js.map