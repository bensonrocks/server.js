"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shopifyAdapter = exports.ShopifyAdapter = void 0;
const shopify_mapper_1 = require("./shopify.mapper");
const API_VER = '2025-01';
// ── HTTP helpers ──────────────────────────────────────────────────────────────
function shopHost(domain) {
    return domain.replace(/https?:\/\//, '').replace(/\/$/, '');
}
function authHeaders(token) {
    return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}
async function shopifyGet(shop, token, path) {
    const res = await fetch(`https://${shop}/admin/api/${API_VER}${path}`, { headers: authHeaders(token) });
    const json = await res.json();
    if (json.errors) {
        const e = json.errors;
        throw new Error(typeof e === 'string' ? e : JSON.stringify(e));
    }
    return json;
}
async function shopifyPost(shop, token, path, body) {
    const res = await fetch(`https://${shop}/admin/api/${API_VER}${path}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.errors) {
        const e = json.errors;
        throw new Error(typeof e === 'string' ? e : JSON.stringify(e));
    }
    return json;
}
async function shopifyGql(shop, token, query, variables) {
    const res = await fetch(`https://${shop}/admin/api/${API_VER}/graphql.json`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors?.length)
        throw new Error(json.errors[0].message);
    return json.data;
}
// ── Shopify Adapter ───────────────────────────────────────────────────────────
class ShopifyAdapter {
    channel = 'shopify';
    creds(creds) {
        const shop = shopHost(String(creds.shopDomain ?? ''));
        const token = String(creds.accessToken ?? '');
        if (!shop)
            throw Object.assign(new Error('Shopify shop domain not configured'), { status: 400 });
        if (!token)
            throw Object.assign(new Error('Shopify access token not configured'), { status: 400 });
        return { shop, token };
    }
    async fetchOrders(creds, opts = {}) {
        const { shop, token } = this.creds(creds);
        const since = opts.since
            ? new Date(opts.since).toISOString()
            : new Date(Date.now() - 7 * 86400000).toISOString();
        const params = new URLSearchParams({
            status: 'any',
            limit: String(opts.pageSize ?? 50),
            created_at_min: since,
        });
        const json = await shopifyGet(shop, token, `/orders.json?${params}`);
        const store = String(creds.shopDomain ?? 'Shopify Store');
        return (json.orders ?? []).map(o => (0, shopify_mapper_1.mapShopifyOrder)(o, store));
    }
    async pushFulfillment(creds, fulfillment) {
        const { shop, token } = this.creds(creds);
        const { externalOrderId, trackingNumber, carrier, trackingUrl, notifyCustomer, message } = fulfillment;
        const foRes = await shopifyGet(shop, token, `/orders/${externalOrderId}/fulfillment_orders.json`);
        const openFOs = (foRes.fulfillment_orders ?? []).filter(fo => fo.status === 'open');
        if (!openFOs.length)
            return { ok: false, skipped: true, reason: 'no open fulfillment orders' };
        const trackingInfo = trackingNumber
            ? { number: trackingNumber, ...(carrier && { company: carrier }), ...(trackingUrl && { url: trackingUrl }) }
            : undefined;
        await shopifyPost(shop, token, '/fulfillments.json', {
            fulfillment: {
                message: message ?? 'Shipped via IdealOne OMS',
                notify_customer: notifyCustomer,
                ...(trackingInfo && { tracking_info: trackingInfo }),
                line_items_by_fulfillment_order: openFOs.map(fo => ({ fulfillment_order_id: fo.id })),
            },
        });
        return { ok: true };
    }
    async fetchWaybill(creds, externalId) {
        const { shop, token } = this.creds(creds);
        const json = await shopifyGet(shop, token, `/orders/${externalId}/fulfillments.json`);
        const f = json.fulfillments?.find(x => x.status === 'success') ?? json.fulfillments?.[0];
        if (!f)
            throw new Error('No fulfillments found on this Shopify order yet');
        return {
            url: f.tracking_url ?? null,
            trackingNumber: f.tracking_number ?? null,
            carrier: f.tracking_company ?? null,
        };
    }
    async syncInventoryFromMarketplace(creds) {
        const { shop, token } = this.creds(creds);
        const QUERY = `
      query Products($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title
            variants(first: 100) {
              nodes { id sku title inventoryQuantity }
            }
          }
        }
      }
    `;
        const items = [];
        let cursor;
        let hasNext = true;
        while (hasNext) {
            const data = await shopifyGql(shop, token, QUERY, { first: 50, after: cursor ?? null });
            for (const product of data.products.nodes) {
                for (const v of product.variants.nodes) {
                    if (!v.sku)
                        continue;
                    items.push({
                        sku: v.sku,
                        name: `${product.title} – ${v.title}`,
                        unit: 'pcs',
                        stockQty: v.inventoryQuantity ?? 0,
                        reservedQty: 0,
                        reorderPoint: 0,
                        costPrice: 0,
                        sellPrice: 0,
                    });
                }
            }
            hasNext = data.products.pageInfo.hasNextPage;
            cursor = data.products.pageInfo.endCursor;
        }
        return items;
    }
    async syncInventoryToMarketplace(_creds, _items) {
        // Full inventory push with location mapping is handled by lib/shopify-app/inventory.js
        return {
            pushed: 0,
            errors: ['Use POST /api/shopify/sync-inventory/push for full inventory sync with location mapping'],
        };
    }
}
exports.ShopifyAdapter = ShopifyAdapter;
exports.shopifyAdapter = new ShopifyAdapter();
//# sourceMappingURL=shopify.adapter.js.map