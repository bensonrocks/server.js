"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.shopifyOAuthMeta = exports.SHOPIFY_SCOPES = void 0;
exports.normaliseShopDomain = normaliseShopDomain;
exports.buildShopifyAuthUrl = buildShopifyAuthUrl;
exports.exchangeShopifyCode = exchangeShopifyCode;
exports.verifyShopifyOAuthHmac = verifyShopifyOAuthHmac;
const crypto_1 = __importDefault(require("crypto"));
exports.SHOPIFY_SCOPES = [
    'read_orders', 'write_orders',
    'read_customers',
    'read_fulfillments', 'write_fulfillments',
    'read_inventory', 'write_inventory',
    'read_products',
].join(',');
exports.shopifyOAuthMeta = {
    id: 'shopify',
    name: 'Shopify',
    type: 'ecommerce',
    authType: 'oauth',
    requiredForOAuth: ['shopDomain', 'apiKey'],
    defaultStoreName: 'Shopify Store',
};
function normaliseShopDomain(raw) {
    let s = raw.trim().replace(/https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    if (!s.includes('.'))
        s = `${s}.myshopify.com`;
    return s;
}
function buildShopifyAuthUrl(shopDomain, clientId, callbackUrl, state) {
    const shop = normaliseShopDomain(shopDomain);
    const p = new URLSearchParams({
        client_id: clientId,
        scope: exports.SHOPIFY_SCOPES,
        redirect_uri: callbackUrl,
        state,
    });
    return `https://${shop}/admin/oauth/authorize?${p}`;
}
async function exchangeShopifyCode(shopDomain, code, clientId, clientSecret) {
    const shop = normaliseShopDomain(shopDomain);
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const j = await res.json();
    if (!j.access_token)
        throw new Error(j.error_description ?? 'Shopify token exchange failed');
    return { accessToken: j.access_token, scope: j.scope, shopDomain: shop };
}
function verifyShopifyOAuthHmac(queryObj, clientSecret) {
    const { hmac, ...rest } = queryObj;
    if (!hmac)
        return false;
    const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
    const expected = crypto_1.default.createHmac('sha256', clientSecret).update(message).digest('hex');
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=shopify.oauth.js.map