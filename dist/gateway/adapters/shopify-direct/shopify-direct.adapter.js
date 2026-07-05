"use strict";
// TODO: implement using existing lib/shopify-app/ infrastructure.
// Shopify public app flow is already built — wire it to this adapter.
// Apply at: https://partners.shopify.com → Create App (Public)
Object.defineProperty(exports, "__esModule", { value: true });
exports.shopifyDirectAdapter = exports.ShopifyDirectAdapter = void 0;
class ShopifyDirectAdapter {
    channel = 'shopify_direct';
    async fetchOrders(_creds, _opts) {
        throw new Error('ShopifyDirectAdapter: pending wiring to lib/shopify-app');
    }
    async pushShipment(_creds, _shipment) {
        throw new Error('ShopifyDirectAdapter: pending wiring to lib/shopify-app');
    }
    async fetchInventory(_creds) {
        throw new Error('ShopifyDirectAdapter: pending wiring to lib/shopify-app');
    }
}
exports.ShopifyDirectAdapter = ShopifyDirectAdapter;
exports.shopifyDirectAdapter = new ShopifyDirectAdapter();
//# sourceMappingURL=shopify-direct.adapter.js.map