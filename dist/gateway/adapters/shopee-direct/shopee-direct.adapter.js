"use strict";
// TODO: implement when Shopee Open Platform partner account is approved.
// Apply at: https://open.shopee.com
// Auth: HMAC-SHA256 (partnerId + path + timestamp + accessToken + shopId)
Object.defineProperty(exports, "__esModule", { value: true });
exports.shopeeDirectAdapter = exports.ShopeeDirectAdapter = void 0;
class ShopeeDirectAdapter {
    channel = 'shopee_direct';
    async fetchOrders(_creds, _opts) {
        throw new Error('ShopeeDirectAdapter: pending Shopee Open Platform approval');
    }
    async pushShipment(_creds, _shipment) {
        throw new Error('ShopeeDirectAdapter: pending Shopee Open Platform approval');
    }
    async fetchInventory(_creds) {
        throw new Error('ShopeeDirectAdapter: pending Shopee Open Platform approval');
    }
}
exports.ShopeeDirectAdapter = ShopeeDirectAdapter;
exports.shopeeDirectAdapter = new ShopeeDirectAdapter();
//# sourceMappingURL=shopee-direct.adapter.js.map