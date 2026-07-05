import type { IMarketplaceAdapter, AdapterCredentials, OmsOrder, OmsFulfillment, FulfillmentResult, FetchOrdersOptions, OAuthMeta, OAuthCallbackResult } from '../marketplace-gateway/marketplace.types';
export declare const lazadaOAuthMeta: OAuthMeta;
export declare function buildLazadaAuthUrl(appKey: string, callbackUrl: string): string;
export declare function exchangeLazadaCode(creds: AdapterCredentials, code: string): Promise<OAuthCallbackResult>;
export declare class LazadaAdapter implements IMarketplaceAdapter {
    readonly channel: "lazada";
    private call;
    fetchOrders(creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<OmsOrder[]>;
    pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult>;
}
export declare const lazadaAdapter: LazadaAdapter;
//# sourceMappingURL=lazada.adapter.d.ts.map