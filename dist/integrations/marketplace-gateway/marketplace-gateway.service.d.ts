import type { IMarketplaceAdapter, MarketplaceChannel, AdapterCredentials, OmsOrder, OmsFulfillment, FulfillmentResult, WaybillInfo, OmsInventoryItem, InventorySyncResult, FetchOrdersOptions, OAuthMeta } from './marketplace.types';
export declare class MarketplaceGatewayService {
    private readonly adapters;
    private readonly oauthMeta;
    register(adapter: IMarketplaceAdapter, meta?: OAuthMeta): this;
    has(channel: MarketplaceChannel): boolean;
    get(channel: MarketplaceChannel): IMarketplaceAdapter;
    getMeta(channel: MarketplaceChannel): OAuthMeta | undefined;
    channels(): MarketplaceChannel[];
    allMeta(): Array<OAuthMeta & {
        channel: MarketplaceChannel;
        requiresLicense?: boolean;
    }>;
    fetchOrders(channel: MarketplaceChannel, creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<OmsOrder[]>;
    pushFulfillment(channel: MarketplaceChannel, creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult>;
    fetchWaybill(channel: MarketplaceChannel, creds: AdapterCredentials, externalId: string): Promise<WaybillInfo>;
    syncInventoryToMarketplace(channel: MarketplaceChannel, creds: AdapterCredentials, items: OmsInventoryItem[]): Promise<InventorySyncResult>;
    syncInventoryFromMarketplace(channel: MarketplaceChannel, creds: AdapterCredentials): Promise<OmsInventoryItem[]>;
}
export declare const gatewayService: MarketplaceGatewayService;
//# sourceMappingURL=marketplace-gateway.service.d.ts.map