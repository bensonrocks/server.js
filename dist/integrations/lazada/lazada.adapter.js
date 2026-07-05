"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.lazadaAdapter = exports.LazadaAdapter = exports.lazadaOAuthMeta = void 0;
exports.buildLazadaAuthUrl = buildLazadaAuthUrl;
exports.exchangeLazadaCode = exchangeLazadaCode;
const crypto_1 = __importDefault(require("crypto"));
// ─────────────────────────────────────────────────────────────────────────────
//  Lazada Adapter — Lazada Open Platform v2
//  Supported regions: MY, SG, TH, PH, ID, VN
//  Docs: https://open.lazada.com/apps/doc/api.htm
// ─────────────────────────────────────────────────────────────────────────────
const AUTH_BASE = 'https://auth.lazada.com';
const API_BASE = {
    MY: 'https://api.lazada.com.my',
    SG: 'https://api.lazada.sg',
    TH: 'https://api.lazada.co.th',
    PH: 'https://api.lazada.com.ph',
    ID: 'https://api.lazada.co.id',
    VN: 'https://api.lazada.vn',
};
const STATUS_MAP = {
    pending: 'pending',
    ready_to_ship: 'confirmed',
    shipped: 'shipped',
    delivered: 'delivered',
    canceled: 'cancelled',
    failed_delivery: 'cancelled',
    returned: 'cancelled',
};
function lazadaSign(appSecret, apiPath, params) {
    const sorted = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
    return crypto_1.default.createHmac('sha256', appSecret).update(`${apiPath}${sorted}`).digest('hex').toUpperCase();
}
exports.lazadaOAuthMeta = {
    id: 'lazada',
    name: 'Lazada',
    type: 'ecommerce',
    authType: 'oauth',
    requiredForOAuth: ['appKey'],
    regions: ['MY', 'SG', 'TH', 'PH', 'ID', 'VN'],
    defaultStoreName: 'Lazada Store',
};
function buildLazadaAuthUrl(appKey, callbackUrl) {
    const p = new URLSearchParams({
        response_type: 'code',
        force_auth: 'true',
        redirect_uri: callbackUrl,
        client_id: appKey,
    });
    return `${AUTH_BASE}/oauth/authorize?${p}`;
}
async function exchangeLazadaCode(creds, code) {
    const { appKey, appSecret } = creds;
    const ts = Date.now().toString();
    const params = { app_key: appKey, timestamp: ts, sign_method: 'sha256', code };
    params.sign = lazadaSign(appSecret, '/auth/token/create', params);
    const res = await fetch(`${AUTH_BASE}/rest/auth/token/create?${new URLSearchParams(params)}`, { method: 'POST' });
    const j = await res.json();
    if (!j.access_token)
        throw new Error(j.message ?? 'Lazada token exchange failed');
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in };
}
class LazadaAdapter {
    channel = 'lazada';
    async call(creds, apiPath, extraParams = {}) {
        const appKey = String(creds.appKey ?? '');
        const appSecret = String(creds.appSecret ?? '');
        const token = String(creds.accessToken ?? '');
        const region = String(creds.region ?? 'MY');
        const base = API_BASE[region] ?? API_BASE.MY;
        const ts = Date.now().toString();
        const params = {
            app_key: appKey,
            access_token: token,
            sign_method: 'sha256',
            timestamp: ts,
            ...extraParams,
        };
        params.sign = lazadaSign(appSecret, apiPath, params);
        const res = await fetch(`${base}/rest${apiPath}?${new URLSearchParams(params)}`);
        const json = await res.json();
        if (json.code && json.code !== '0')
            throw new Error(`Lazada error ${json.code}: ${json.message}`);
        return (json.data ?? {});
    }
    async fetchOrders(creds, opts = {}) {
        const since = opts.since
            ? new Date(opts.since).toISOString()
            : new Date(Date.now() - 7 * 86400000).toISOString();
        const data = await this.call(creds, '/orders/get', {
            created_after: since,
            limit: String(opts.pageSize ?? 50),
            offset: String(opts.offset ?? 0),
            sort_by: 'created_at',
            sort_direction: 'DESC',
        });
        const orders = (data.orders ?? []);
        const storeName = String(creds.storeName ?? 'Lazada Store');
        const clientId = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        return orders.map(o => {
            const addrB = (o.address_billing ?? {});
            const addrS = (o.address_shipping ?? addrB);
            const recipient = [addrS.first_name, addrS.last_name].filter(Boolean).join(' ') || addrS.name || '';
            const status = STATUS_MAP[String(o.statuses ?? o.status ?? '').toLowerCase()] ?? 'pending';
            return {
                id: `LZ-${o.order_id}`,
                clientId,
                clientName: storeName,
                channel: 'lazada',
                orderDate: String(o.created_at ?? new Date().toISOString()),
                status,
                currency: String(o.currency ?? 'MYR'),
                notes: String(o.remarks ?? ''),
                items: (o.items ?? []).map(i => ({
                    sku: String(i.sku ?? ''),
                    name: String(i.name ?? 'Item'),
                    qty: Number(i.item_count) || 1,
                    unitPrice: Number(i.item_price) || 0,
                })),
                shipping: {
                    recipient,
                    name: recipient,
                    addressLine1: addrS.address1 ?? addrS.address ?? '',
                    addressLine2: addrS.address2 ?? '',
                    city: addrS.city ?? '',
                    state: addrS.state ?? '',
                    zip: addrS.postcode ?? '',
                    country: addrS.country ?? '',
                    phone: addrS.phone ?? '',
                },
                subtotal: Number(o.price) || 0,
                shippingCost: Number(o.shipping_fee ?? 0),
                tax: 0,
                total: Number(o.price) || 0,
                source: {
                    type: 'lazada',
                    externalId: String(o.order_id),
                    orderName: String(o.order_number ?? o.order_id),
                    ingestedAt: new Date().toISOString(),
                },
            };
        });
    }
    async pushFulfillment(creds, fulfillment) {
        const params = {
            order_item_ids: JSON.stringify([fulfillment.externalOrderId]),
            shipment_provider: fulfillment.carrier ?? 'Other',
        };
        if (fulfillment.trackingNumber)
            params.tracking_number = fulfillment.trackingNumber;
        await this.call(creds, '/order/fulfillment/ship', params);
        return { ok: true };
    }
}
exports.LazadaAdapter = LazadaAdapter;
exports.lazadaAdapter = new LazadaAdapter();
//# sourceMappingURL=lazada.adapter.js.map