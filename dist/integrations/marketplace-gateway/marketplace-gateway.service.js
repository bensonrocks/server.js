"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gatewayService = exports.MarketplaceGatewayService = void 0;
// ─────────────────────────────────────────────────────────────────────────────
//  MarketplaceGatewayService
//
//  Central registry that routes all marketplace operations to the right adapter.
//  - Free adapters (Shopify direct, Lazada, Shopee, TikTok) are auto-registered.
//  - Paid adapters (API2Cart, Zetpy, ChannelEngine) require a licenseKey credential.
// ─────────────────────────────────────────────────────────────────────────────
class MarketplaceGatewayService {
    adapters = new Map();
    oauthMeta = new Map();
    register(adapter, meta) {
        this.adapters.set(adapter.channel, adapter);
        if (meta)
            this.oauthMeta.set(adapter.channel, meta);
        return this;
    }
    has(channel) {
        return this.adapters.has(channel);
    }
    get(channel) {
        const a = this.adapters.get(channel);
        if (!a)
            throw Object.assign(new Error(`No adapter registered for channel: ${channel}`), { status: 400 });
        return a;
    }
    getMeta(channel) {
        return this.oauthMeta.get(channel);
    }
    channels() {
        return [...this.adapters.keys()];
    }
    allMeta() {
        return this.channels().map(ch => {
            const meta = this.oauthMeta.get(ch);
            const adapter = this.adapters.get(ch);
            return {
                channel: ch,
                requiresLicense: adapter.requiresLicense,
                id: meta?.id ?? ch,
                name: meta?.name ?? ch,
                type: meta?.type ?? 'ecommerce',
                authType: meta?.authType ?? 'token',
                requiredForOAuth: meta?.requiredForOAuth,
                regions: meta?.regions,
                defaultStoreName: meta?.defaultStoreName,
            };
        });
    }
    // ── Business operations ──────────────────────────────────────────────────
    async fetchOrders(channel, creds, opts) {
        return this.get(channel).fetchOrders(creds, opts);
    }
    async pushFulfillment(channel, creds, fulfillment) {
        const a = this.get(channel);
        if (!a.pushFulfillment) {
            return { ok: false, skipped: true, reason: `${channel} does not support fulfillment push` };
        }
        return a.pushFulfillment(creds, fulfillment);
    }
    async fetchWaybill(channel, creds, externalId) {
        const a = this.get(channel);
        if (!a.fetchWaybill) {
            throw Object.assign(new Error(`${channel} does not support waybill fetch`), { status: 400 });
        }
        return a.fetchWaybill(creds, externalId);
    }
    async syncInventoryToMarketplace(channel, creds, items) {
        const a = this.get(channel);
        if (!a.syncInventoryToMarketplace) {
            return { pushed: 0, errors: [`${channel} does not support inventory push`] };
        }
        return a.syncInventoryToMarketplace(creds, items);
    }
    async syncInventoryFromMarketplace(channel, creds) {
        const a = this.get(channel);
        if (!a.syncInventoryFromMarketplace)
            return [];
        return a.syncInventoryFromMarketplace(creds);
    }
}
exports.MarketplaceGatewayService = MarketplaceGatewayService;
exports.gatewayService = new MarketplaceGatewayService();
//# sourceMappingURL=marketplace-gateway.service.js.map