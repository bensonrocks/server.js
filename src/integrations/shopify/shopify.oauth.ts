import crypto from 'crypto';
import type { OAuthMeta, OAuthCallbackResult } from '../marketplace-gateway/marketplace.types';

export const SHOPIFY_SCOPES = [
  'read_orders', 'write_orders',
  'read_customers',
  'read_fulfillments', 'write_fulfillments',
  'read_inventory', 'write_inventory',
  'read_products',
].join(',');

export const shopifyOAuthMeta: OAuthMeta = {
  id:               'shopify',
  name:             'Shopify',
  type:             'ecommerce',
  authType:         'oauth',
  requiredForOAuth: ['shopDomain', 'apiKey'],
  defaultStoreName: 'Shopify Store',
};

export function normaliseShopDomain(raw: string): string {
  let s = raw.trim().replace(/https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!s.includes('.')) s = `${s}.myshopify.com`;
  return s;
}

export function buildShopifyAuthUrl(
  shopDomain: string,
  clientId: string,
  callbackUrl: string,
  state: string,
): string {
  const shop = normaliseShopDomain(shopDomain);
  const p = new URLSearchParams({
    client_id:    clientId,
    scope:        SHOPIFY_SCOPES,
    redirect_uri: callbackUrl,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${p}`;
}

export async function exchangeShopifyCode(
  shopDomain: string,
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<OAuthCallbackResult> {
  const shop = normaliseShopDomain(shopDomain);
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const j = await res.json() as { access_token?: string; scope?: string; error_description?: string };
  if (!j.access_token) throw new Error(j.error_description ?? 'Shopify token exchange failed');
  return { accessToken: j.access_token, scope: j.scope, shopDomain: shop };
}

export function verifyShopifyOAuthHmac(queryObj: Record<string, string>, clientSecret: string): boolean {
  const { hmac, ...rest } = queryObj;
  if (!hmac) return false;
  const message  = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const expected = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
