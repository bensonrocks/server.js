"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHOPIFY_WEBHOOK_TOPICS = void 0;
exports.verifyShopifyWebhookHmac = verifyShopifyWebhookHmac;
exports.parseWebhookOrder = parseWebhookOrder;
exports.registerShopifyWebhooks = registerShopifyWebhooks;
const crypto_1 = __importDefault(require("crypto"));
const shopify_mapper_1 = require("./shopify.mapper");
exports.SHOPIFY_WEBHOOK_TOPICS = [
    'orders/create',
    'orders/updated',
    'orders/cancelled',
    'app/uninstalled',
    'customers/data_request',
    'customers/redact',
    'shop/redact',
];
// Verify X-Shopify-Hmac-Sha256 header (base64 HMAC-SHA256 of raw body)
function verifyShopifyWebhookHmac(rawBody, hmacHeader, clientSecret) {
    if (!hmacHeader)
        return false;
    const expected = crypto_1.default.createHmac('sha256', clientSecret).update(rawBody).digest('base64');
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(expected));
    }
    catch {
        return false;
    }
}
// Parse a Shopify webhook order payload into OmsOrder format
function parseWebhookOrder(shopDomain, payload, storeName) {
    return (0, shopify_mapper_1.mapShopifyOrder)(payload, storeName ?? shopDomain);
}
const SHOPIFY_API_VER = '2025-01';
// Register all required webhook topics for a shop
async function registerShopifyWebhooks(shopDomain, accessToken, webhookUrl) {
    for (const topic of exports.SHOPIFY_WEBHOOK_TOPICS) {
        try {
            const res = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VER}/webhooks.json`, {
                method: 'POST',
                headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({ webhook: { topic, address: webhookUrl, format: 'json' } }),
            });
            const j = await res.json();
            if (j.errors) {
                console.warn(`[shopify-webhooks] ${topic} error:`, j.errors);
            }
        }
        catch (e) {
            console.warn(`[shopify-webhooks] failed to register ${topic}:`, e.message);
        }
    }
}
//# sourceMappingURL=shopify.webhooks.js.map