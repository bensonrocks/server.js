"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketplaceGatewayService = void 0;
class MarketplaceGatewayService {
    adapters = new Map();
    register(adapter) {
        this.adapters.set(adapter.channel, adapter);
        return this;
    }
    get(channel) {
        const a = this.adapters.get(channel);
        if (!a)
            throw new Error(`No adapter registered for channel: "${channel}"`);
        return a;
    }
    has(channel) {
        return this.adapters.has(channel);
    }
    channels() {
        return [...this.adapters.keys()];
    }
    adaptersWithLicense() {
        return [...this.adapters.values()]
            .filter(a => a.requiresLicense)
            .map(a => a.channel);
    }
    // ── OMS-facing methods — accept/return Standard Models only ─────────────────
    fetchOrders(channel, creds, opts) {
        return this.get(channel).fetchOrders(creds, opts);
    }
    pushShipment(channel, creds, shipment) {
        return this.get(channel).pushShipment(creds, shipment);
    }
    fetchInventory(channel, creds) {
        const a = this.get(channel);
        if (!a.fetchInventory)
            return Promise.resolve([]);
        return a.fetchInventory(creds);
    }
    syncInventory(channel, creds, items) {
        const a = this.get(channel);
        if (!a.syncInventory)
            return Promise.resolve();
        return a.syncInventory(creds, items);
    }
}
exports.MarketplaceGatewayService = MarketplaceGatewayService;
//# sourceMappingURL=gateway.service.js.map