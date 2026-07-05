"use strict";
// TODO: implement when Lazada Open Platform developer account is approved.
// Apply at: https://open.lazada.com
// Auth: HMAC-SHA256 signed params (appKey + sorted params concatenated + apiPath)
Object.defineProperty(exports, "__esModule", { value: true });
exports.lazadaDirectAdapter = exports.LazadaDirectAdapter = void 0;
class LazadaDirectAdapter {
    channel = 'lazada_direct';
    async fetchOrders(_creds, _opts) {
        throw new Error('LazadaDirectAdapter: pending Lazada Open Platform approval');
    }
    async pushShipment(_creds, _shipment) {
        throw new Error('LazadaDirectAdapter: pending Lazada Open Platform approval');
    }
    async fetchInventory(_creds) {
        throw new Error('LazadaDirectAdapter: pending Lazada Open Platform approval');
    }
}
exports.LazadaDirectAdapter = LazadaDirectAdapter;
exports.lazadaDirectAdapter = new LazadaDirectAdapter();
//# sourceMappingURL=lazada-direct.adapter.js.map