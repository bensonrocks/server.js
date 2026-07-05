import type { IMarketplaceAdapter, AdapterCredentials, OmsOrder, OmsFulfillment, FulfillmentResult, FetchOrdersOptions, OAuthMeta, OAuthCallbackResult } from '../marketplace-gateway/marketplace.types';
export declare const tiktokOAuthMeta: OAuthMeta;
export declare function buildTiktokAuthUrl(appKey: string, callbackUrl: string): string;
export declare function exchangeTiktokCode(creds: AdapterCredentials, code: string): Promise<OAuthCallbackResult>;
export declare class TiktokAdapter implements IMarketplaceAdapter {
    readonly channel: "tiktok";
    private post;
    fetchOrders(creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<OmsOrder[]>;
    pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult>;
}
export declare const tiktokAdapter: TiktokAdapter;
//# sourceMappingURL=tiktok.adapter.d.ts.map