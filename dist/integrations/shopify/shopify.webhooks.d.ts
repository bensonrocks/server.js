import type { OmsOrder } from '../marketplace-gateway/marketplace.types';
export declare const SHOPIFY_WEBHOOK_TOPICS: readonly ["orders/create", "orders/updated", "orders/cancelled", "app/uninstalled", "customers/data_request", "customers/redact", "shop/redact"];
export type ShopifyWebhookTopic = typeof SHOPIFY_WEBHOOK_TOPICS[number];
export interface ShopifyWebhookEvent {
    topic: ShopifyWebhookTopic;
    shopDomain: string;
    payload: Record<string, unknown>;
}
export declare function verifyShopifyWebhookHmac(rawBody: Buffer, hmacHeader: string, clientSecret: string): boolean;
export declare function parseWebhookOrder(shopDomain: string, payload: Record<string, unknown>, storeName?: string): OmsOrder;
export declare function registerShopifyWebhooks(shopDomain: string, accessToken: string, webhookUrl: string): Promise<void>;
//# sourceMappingURL=shopify.webhooks.d.ts.map