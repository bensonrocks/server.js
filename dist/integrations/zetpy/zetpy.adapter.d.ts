import type { IMarketplaceAdapter, AdapterCredentials, OmsOrder, OmsFulfillment, FulfillmentResult, FetchOrdersOptions, OAuthMeta } from '../marketplace-gateway/marketplace.types';
export declare const zetpyOAuthMeta: OAuthMeta;
export declare class ZetpyAdapter implements IMarketplaceAdapter {
    readonly channel: "zetpy";
    readonly requiresLicense = true;
    private assertKey;
    private request;
    fetchOrders(creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<OmsOrder[]>;
    private mapOrder;
    pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult>;
}
export declare const zetpyAdapter: ZetpyAdapter;
//# sourceMappingURL=zetpy.adapter.d.ts.map