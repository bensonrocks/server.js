import type { IMarketplaceAdapter, AdapterCredentials, OmsOrder, OmsFulfillment, FulfillmentResult, FetchOrdersOptions, OAuthMeta, OAuthCallbackResult } from '../marketplace-gateway/marketplace.types';
export declare const shopeeOAuthMeta: OAuthMeta;
export declare function buildShopeeAuthUrl(partnerId: string, partnerKey: string, callbackUrl: string): string;
export declare function exchangeShopeeCode(creds: AdapterCredentials, code: string, shopId: string): Promise<OAuthCallbackResult>;
export declare class ShopeeAdapter implements IMarketplaceAdapter {
    readonly channel: "shopee";
    private buildParams;
    fetchOrders(creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<OmsOrder[]>;
    pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult>;
}
export declare const shopeeAdapter: ShopeeAdapter;
//# sourceMappingURL=shopee.adapter.d.ts.map