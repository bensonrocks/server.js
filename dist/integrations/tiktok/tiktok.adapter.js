"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tiktokAdapter = exports.TiktokAdapter = exports.tiktokOAuthMeta = void 0;
exports.buildTiktokAuthUrl = buildTiktokAuthUrl;
exports.exchangeTiktokCode = exchangeTiktokCode;
const crypto_1 = __importDefault(require("crypto"));
// ─────────────────────────────────────────────────────────────────────────────
//  TikTok Shop Adapter — TikTok Shop Open Platform
//  Docs: https://partner.tiktokshop.com/docv2/page/650a14d4e4c1452e7b8a3e12
// ─────────────────────────────────────────────────────────────────────────────
const API_BASE = 'https://open-api.tiktokglobalshop.com';
const AUTH_URL = 'https://auth.tiktok-shops.com/oauth/authorize';
const API_VER = '202309';
const STATUS_MAP = {
    UNPAID: 'pending',
    ON_HOLD: 'pending',
    AWAITING_SHIPMENT: 'confirmed',
    PARTIALLY_SHIPPING: 'processing',
    AWAITING_COLLECTION: 'processing',
    IN_TRANSIT: 'shipped',
    DELIVERED: 'delivered',
    COMPLETED: 'delivered',
    CANCELLED: 'cancelled',
};
function tiktokSign(appSecret, params, body = '') {
    const exclude = new Set(['sign', 'access_token']);
    const str = Object.keys(params)
        .filter(k => !exclude.has(k))
        .sort()
        .map(k => `${k}${params[k]}`)
        .join('');
    return crypto_1.default.createHmac('sha256', appSecret).update(`${appSecret}${str}${body}${appSecret}`).digest('hex');
}
exports.tiktokOAuthMeta = {
    id: 'tiktok',
    name: 'TikTok Shop',
    type: 'ecommerce',
    authType: 'oauth',
    requiredForOAuth: ['appKey'],
    defaultStoreName: 'TikTok Shop',
};
function buildTiktokAuthUrl(appKey, callbackUrl) {
    const p = new URLSearchParams({ app_key: appKey, state: 'idealoms', redirect_uri: callbackUrl });
    return `${AUTH_URL}?${p}`;
}
async function exchangeTiktokCode(creds, code) {
    const appKey = String(creds.appKey ?? '');
    const appSecret = String(creds.appSecret ?? '');
    const ts = Math.floor(Date.now() / 1000);
    const params = { app_key: appKey, auth_code: code, grant_type: 'authorized_code', timestamp: String(ts) };
    params.sign = tiktokSign(appSecret, params);
    const res = await fetch(`${API_BASE}/api/v2/token/get?${new URLSearchParams(params)}`);
    const j = await res.json();
    if (j.code !== 0)
        throw new Error(j.message ?? 'TikTok token exchange failed');
    return {
        accessToken: j.data?.access_token,
        refreshToken: j.data?.refresh_token,
        expiresIn: j.data?.access_token_expire_in,
    };
}
class TiktokAdapter {
    channel = 'tiktok';
    async post(creds, endpoint, bodyObj) {
        const appKey = String(creds.appKey ?? '');
        const appSecret = String(creds.appSecret ?? '');
        const token = String(creds.accessToken ?? '');
        const shopId = String(creds.shopId ?? '');
        const ts = Math.floor(Date.now() / 1000);
        const params = {
            app_key: appKey,
            access_token: token,
            timestamp: String(ts),
            shop_id: shopId,
            version: API_VER,
        };
        const bodyStr = JSON.stringify(bodyObj);
        params.sign = tiktokSign(appSecret, params, bodyStr);
        const res = await fetch(`${API_BASE}${endpoint}?${new URLSearchParams(params)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr,
        });
        const json = await res.json();
        if (json.code !== 0)
            throw new Error(`TikTok error ${json.code}: ${json.message}`);
        return json.data;
    }
    async fetchOrders(creds, opts = {}) {
        const tsNow = Math.floor(Date.now() / 1000);
        const tsFrom = opts.since ? Math.floor(new Date(opts.since).getTime() / 1000) : tsNow - 7 * 86400;
        const data = await this.post(creds, '/api/orders/search', {
            create_time_ge: tsFrom,
            create_time_lt: tsNow,
            page_size: opts.pageSize ?? 50,
            status: opts.status ?? 'AWAITING_SHIPMENT',
        });
        const orders = data.order_list ?? [];
        const storeName = String(creds.storeName ?? 'TikTok Shop');
        const clientId = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        return orders.map(o => {
            const addr = (o.recipient_address ?? {});
            const items = (o.item_list ?? []).map(i => ({
                sku: String(i.seller_sku ?? ''),
                name: String(i.product_name ?? 'Item'),
                qty: Number(i.quantity) || 1,
                unitPrice: Number(i.sale_price) || 0,
            }));
            return {
                id: `TTK-${o.order_id}`,
                clientId,
                clientName: storeName,
                channel: 'tiktok',
                orderDate: new Date(Number(o.create_time) * 1000).toISOString(),
                status: STATUS_MAP[String(o.order_status ?? '')] ?? 'pending',
                currency: String(o.currency ?? 'MYR'),
                notes: String(o.buyer_message ?? ''),
                items,
                shipping: {
                    recipient: addr.name ?? '',
                    name: addr.name ?? '',
                    addressLine1: addr.full_address ?? '',
                    addressLine2: '',
                    city: addr.district_info ?? '',
                    state: addr.region ?? '',
                    zip: addr.zipcode ?? '',
                    country: addr.region_code ?? '',
                    phone: addr.phone_number ?? '',
                },
                subtotal: Number(o.payment?.sub_total ?? o.total_amount ?? 0),
                shippingCost: Number(o.payment?.shipping_fee ?? 0),
                tax: 0,
                total: Number(o.payment?.total_amount ?? o.total_amount ?? 0),
                source: {
                    type: 'tiktok',
                    externalId: String(o.order_id),
                    orderName: String(o.order_id),
                    ingestedAt: new Date().toISOString(),
                },
            };
        });
    }
    async pushFulfillment(creds, fulfillment) {
        await this.post(creds, '/api/fulfillment/ship_order', {
            order_id: fulfillment.externalOrderId,
            tracking_number: fulfillment.trackingNumber ?? '',
            shipping_provider_id: fulfillment.carrier ?? '',
        });
        return { ok: true };
    }
}
exports.TiktokAdapter = TiktokAdapter;
exports.tiktokAdapter = new TiktokAdapter();
//# sourceMappingURL=tiktok.adapter.js.map