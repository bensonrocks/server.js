"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.api2CartAdapter = exports.Api2CartAdapter = exports.api2CartOAuthMeta = void 0;
const api2cart_mapper_1 = require("./api2cart.mapper");
// ─────────────────────────────────────────────────────────────────────────────
//  API2Cart Adapter — paid multi-cart connector (40+ shopping carts via one API)
//  License required. Contact your IdealOne representative to activate.
//  Docs: https://api2cart.com/docs/
// ─────────────────────────────────────────────────────────────────────────────
const API2CART_BASE = 'https://api.api2cart.com/v1.1';
exports.api2CartOAuthMeta = {
    id: 'api2cart',
    name: 'API2Cart (Multi-Cart)',
    type: 'ecommerce',
    authType: 'apikey',
    requiredForOAuth: ['licenseKey', 'storeKey'],
    defaultStoreName: 'API2Cart Store',
};
class Api2CartAdapter {
    channel = 'api2cart';
    requiresLicense = true;
    assertLicense(creds) {
        if (!creds.licenseKey) {
            throw Object.assign(new Error('API2Cart requires a paid licence key. Contact your IdealOne representative.'), { status: 402 });
        }
        return { apiKey: String(creds.licenseKey), storeKey: String(creds.storeKey ?? '') };
    }
    async request(apiKey, storeKey, endpoint, params = {}) {
        const url = new URL(`${API2CART_BASE}${endpoint}.json`);
        url.searchParams.set('api_key', apiKey);
        if (storeKey)
            url.searchParams.set('store_key', storeKey);
        for (const [k, v] of Object.entries(params))
            url.searchParams.set(k, v);
        const res = await fetch(url.toString());
        const json = await res.json();
        if (json.status === 'error')
            throw new Error(json.message ?? 'API2Cart error');
        return (json.return ?? {});
    }
    async fetchOrders(creds, opts = {}) {
        const { apiKey, storeKey } = this.assertLicense(creds);
        const since = opts.since
            ? new Date(opts.since).toISOString()
            : new Date(Date.now() - 7 * 86400000).toISOString();
        const data = await this.request(apiKey, storeKey, '/order.list', {
            created_from: since,
            count: String(opts.pageSize ?? 50),
            start: String(opts.offset ?? 0),
        });
        const orders = data.orders ?? [];
        const store = String(creds.storeName ?? creds.storeUrl ?? 'API2Cart Store');
        return orders.map(o => (0, api2cart_mapper_1.mapApi2CartOrder)(o, store));
    }
    async pushFulfillment(creds, fulfillment) {
        const { apiKey, storeKey } = this.assertLicense(creds);
        const params = { order_id: fulfillment.externalOrderId };
        if (fulfillment.trackingNumber)
            params.tracking_number = fulfillment.trackingNumber;
        if (fulfillment.carrier)
            params.shipping_provider = fulfillment.carrier;
        await this.request(apiKey, storeKey, '/order.shipment.add', params);
        return { ok: true };
    }
}
exports.Api2CartAdapter = Api2CartAdapter;
exports.api2CartAdapter = new Api2CartAdapter();
//# sourceMappingURL=api2cart.adapter.js.map