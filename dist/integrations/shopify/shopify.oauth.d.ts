import type { OAuthMeta, OAuthCallbackResult } from '../marketplace-gateway/marketplace.types';
export declare const SHOPIFY_SCOPES: string;
export declare const shopifyOAuthMeta: OAuthMeta;
export declare function normaliseShopDomain(raw: string): string;
export declare function buildShopifyAuthUrl(shopDomain: string, clientId: string, callbackUrl: string, state: string): string;
export declare function exchangeShopifyCode(shopDomain: string, code: string, clientId: string, clientSecret: string): Promise<OAuthCallbackResult>;
export declare function verifyShopifyOAuthHmac(queryObj: Record<string, string>, clientSecret: string): boolean;
//# sourceMappingURL=shopify.oauth.d.ts.map