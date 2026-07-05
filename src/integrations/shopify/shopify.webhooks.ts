import crypto from 'crypto';
import type { OmsOrder } from '../marketplace-gateway/marketplace.types';
import { mapShopifyOrder } from './shopify.mapper';

export const SHOPIFY_WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'app/uninstalled',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
] as const;

export type ShopifyWebhookTopic = typeof SHOPIFY_WEBHOOK_TOPICS[number];

export interface ShopifyWebhookEvent {
  topic:      ShopifyWebhookTopic;
  shopDomain: string;
  payload:    Record<string, unknown>;
}

// Verify X-Shopify-Hmac-Sha256 header (base64 HMAC-SHA256 of raw body)
export function verifyShopifyWebhookHmac(
  rawBody: Buffer,
  hmacHeader: string,
  clientSecret: string,
): boolean {
  if (!hmacHeader) return false;
  const expected = crypto.createHmac('sha256', clientSecret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Parse a Shopify webhook order payload into OmsOrder format
export function parseWebhookOrder(
  shopDomain: string,
  payload: Record<string, unknown>,
  storeName?: string,
): OmsOrder {
  return mapShopifyOrder(payload, storeName ?? shopDomain);
}

const SHOPIFY_API_VER = '2025-01';

// Register all required webhook topics for a shop
export async function registerShopifyWebhooks(
  shopDomain: string,
  accessToken: string,
  webhookUrl: string,
): Promise<void> {
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    try {
      const res = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VER}/webhooks.json`, {
        method:  'POST',
        headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ webhook: { topic, address: webhookUrl, format: 'json' } }),
      });
      const j = await res.json() as { errors?: unknown };
      if (j.errors) {
        console.warn(`[shopify-webhooks] ${topic} error:`, j.errors);
      }
    } catch (e) {
      console.warn(`[shopify-webhooks] failed to register ${topic}:`, (e as Error).message);
    }
  }
}
