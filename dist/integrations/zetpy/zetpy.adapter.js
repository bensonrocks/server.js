"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zetpyAdapter = exports.ZetpyAdapter = exports.zetpyOAuthMeta = void 0;
// ─────────────────────────────────────────────────────────────────────────────
//  Zetpy Adapter — Multi-channel aggregator (SEA: Shopee, Lazada, TikTok, etc.)
//  Docs:  https://developers.zetpy.com  (login required)
//
//  ⚠️  SKELETON — field names and paths below are best-guess from common REST
//  conventions.  Verify every TODO against the real Zetpy API docs / Postman
//  collection before going live.
// ─────────────────────────────────────────────────────────────────────────────
// TODO: confirm exact base URL (may be https://app.zetpy.com/api or https://api.zetpy.com/v1)
const API_BASE = 'https://api.zetpy.com/v1';
// TODO: confirm auth header name & format (Bearer token, X-API-Key, etc.)
function authHeaders(apiKey) {
    return {
        'Authorization': `Bearer ${apiKey}`, // TODO: confirm header
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}
// TODO: map real Zetpy order statuses to OMS statuses
// Common Zetpy status strings (guessed — verify against actual API response)
const STATUS_MAP = {
    pending: 'pending', // TODO: verify actual status strings
    confirmed: 'confirmed',
    processing: 'processing',
    ready_to_ship: 'processing',
    shipped: 'shipped',
    in_transit: 'shipped',
    delivered: 'delivered',
    completed: 'delivered',
    cancelled: 'cancelled',
    canceled: 'cancelled',
};
exports.zetpyOAuthMeta = {
    id: 'zetpy',
    name: 'Zetpy',
    type: 'ecommerce',
    authType: 'apikey',
    requiredForOAuth: [],
    defaultStoreName: 'Zetpy Store',
};
// ── Adapter ───────────────────────────────────────────────────────────────────
class ZetpyAdapter {
    channel = 'zetpy';
    requiresLicense = true;
    assertKey(creds) {
        const key = String(creds.licenseKey ?? creds.apiKey ?? '');
        if (!key) {
            throw Object.assign(new Error('Zetpy requires an API key — obtain one from your Zetpy account settings.'), { status: 402 });
        }
        return key;
    }
    // ── Internal request helper ───────────────────────────────────────────────
    async request(apiKey, method, path, body, params) {
        let url = `${API_BASE}${path}`;
        if (params && Object.keys(params).length) {
            url += `?${new URLSearchParams(params)}`;
        }
        const res = await fetch(url, {
            method,
            headers: authHeaders(apiKey),
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => res.statusText);
            throw new Error(`Zetpy ${method} ${path} → HTTP ${res.status}: ${text}`);
        }
        return res.json();
    }
    // ── fetchOrders ───────────────────────────────────────────────────────────
    async fetchOrders(creds, opts = {}) {
        const apiKey = this.assertKey(creds);
        const storeName = String(creds.storeName ?? 'Zetpy Store');
        const clientId = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        // TODO: confirm endpoint path (may be /orders or /api/orders)
        // TODO: confirm query param names for date range and pagination
        const params = {
            per_page: String(opts.pageSize ?? 50), // TODO: confirm param name
            page: '1', // TODO: confirm param name
        };
        if (opts.since) {
            params['created_from'] = new Date(opts.since).toISOString(); // TODO: confirm
        }
        if (opts.status) {
            params['status'] = opts.status; // TODO: confirm filter param
        }
        const resp = await this.request(apiKey, 'GET', '/orders', // TODO: confirm endpoint path
        undefined, params);
        const orders = resp.data ?? []; // TODO: confirm response wrapper field
        return orders.map(o => this.mapOrder(o, storeName, clientId));
    }
    // ── Map raw Zetpy order → OmsOrder ───────────────────────────────────────
    mapOrder(o, storeName, clientId) {
        const addr = o.shipping_address ?? {}; // TODO: confirm field name
        const items = (o.items ?? []).map(i => ({
            sku: String(i.sku ?? ''),
            name: String(i.name ?? 'Item'),
            qty: Number(i.quantity) || 1, // TODO: confirm field name
            unitPrice: Number(i.unit_price) || 0, // TODO: confirm field name
        }));
        // Zetpy aggregates multiple channels, so preserve the source channel
        // TODO: confirm o.channel values match: 'shopee','lazada','tiktok','shopify',…
        const sourceChannel = String(o.channel ?? 'zetpy');
        return {
            id: `ZTP-${o.id}`, // TODO: confirm id field
            clientId,
            clientName: storeName,
            channel: 'zetpy',
            orderDate: String(o.created_at ?? new Date().toISOString()), // TODO: confirm
            status: STATUS_MAP[String(o.status ?? '').toLowerCase()] ?? 'pending',
            currency: String(o.currency ?? 'MYR'), // TODO: confirm field
            notes: String(o.buyer_note ?? ''), // TODO: confirm field
            items,
            shipping: {
                recipient: addr.name ?? '',
                name: addr.name ?? '',
                addressLine1: addr.address1 ?? '', // TODO: confirm field
                addressLine2: addr.address2 ?? '',
                city: addr.city ?? '',
                state: addr.state ?? '',
                zip: addr.postcode ?? '', // TODO: confirm field
                country: addr.country ?? '',
                phone: addr.phone ?? '',
            },
            subtotal: Number(o.subtotal ?? 0), // TODO: confirm field
            shippingCost: Number(o.shipping_fee ?? 0), // TODO: confirm field
            tax: 0,
            total: Number(o.total ?? 0), // TODO: confirm field
            source: {
                type: 'zetpy',
                externalId: String(o.id), // TODO: confirm id field
                orderName: String(o.order_number ?? o.id), // TODO: confirm field
                ingestedAt: new Date().toISOString(),
                // Preserve original marketplace for display
                ...(sourceChannel !== 'zetpy' ? { originChannel: sourceChannel } : {}),
            },
        };
    }
    // ── pushFulfillment ───────────────────────────────────────────────────────
    async pushFulfillment(creds, fulfillment) {
        const apiKey = this.assertKey(creds);
        // TODO: confirm endpoint path and body field names
        await this.request(apiKey, 'POST', `/orders/${fulfillment.externalOrderId}/fulfill`, // TODO: confirm endpoint
        {
            tracking_number: fulfillment.trackingNumber ?? '', // TODO: confirm field
            carrier: fulfillment.carrier ?? '', // TODO: confirm field
            notify_buyer: true, // TODO: confirm field + if supported
        });
        return { ok: true };
    }
}
exports.ZetpyAdapter = ZetpyAdapter;
exports.zetpyAdapter = new ZetpyAdapter();
//# sourceMappingURL=zetpy.adapter.js.map