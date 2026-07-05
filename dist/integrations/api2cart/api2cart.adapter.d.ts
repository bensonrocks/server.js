import type { IMarketplaceAdapter, AdapterCredentials, OmsOrder, OmsFulfillment, FulfillmentResult, FetchOrdersOptions } from '../marketplace-gateway/marketplace.types';
import type { OAuthMeta } from '../marketplace-gateway/marketplace.types';
export declare const api2CartOAuthMeta: OAuthMeta;
export declare class Api2CartAdapter implements IMarketplaceAdapter {
    readonly channel: "api2cart";
    readonly requiresLicense = true;
    private assertLicense;
    private request;
    fetchOrders(creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<OmsOrder[]>;
    pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult>;
}
export declare const api2CartAdapter: Api2CartAdapter;
//# sourceMappingURL=api2cart.adapter.d.ts.map