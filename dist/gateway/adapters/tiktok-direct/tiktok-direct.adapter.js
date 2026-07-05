"use strict";
// TODO: implement when TikTok Shop Partner account is approved.
// Apply at: https://partner.tiktokshop.com
// Auth: HMAC-SHA256 (appSecret + sorted_params + body + appSecret)
Object.defineProperty(exports, "__esModule", { value: true });
exports.tiktokDirectAdapter = exports.TiktokDirectAdapter = void 0;
class TiktokDirectAdapter {
    channel = 'tiktok_direct';
    async fetchOrders(_creds, _opts) {
        throw new Error('TiktokDirectAdapter: pending TikTok Shop Partner approval');
    }
    async pushShipment(_creds, _shipment) {
        throw new Error('TiktokDirectAdapter: pending TikTok Shop Partner approval');
    }
    async fetchInventory(_creds) {
        throw new Error('TiktokDirectAdapter: pending TikTok Shop Partner approval');
    }
}
exports.TiktokDirectAdapter = TiktokDirectAdapter;
exports.tiktokDirectAdapter = new TiktokDirectAdapter();
//# sourceMappingURL=tiktok-direct.adapter.js.map