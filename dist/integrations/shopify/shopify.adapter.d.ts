import type { IMarketplaceAdapter, AdapterCredentials, OmsOrder, OmsFulfillment, FulfillmentResult, WaybillInfo, OmsInventoryItem, InventorySyncResult, FetchOrdersOptions } from '../marketplace-gateway/marketplace.types';
export declare class ShopifyAdapter implements IMarketplaceAdapter {
    readonly channel: "shopify";
    private creds;
    fetchOrders(creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<OmsOrder[]>;
    pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult>;
    fetchWaybill(creds: AdapterCredentials, externalId: string): Promise<WaybillInfo>;
    syncInventoryFromMarketplace(creds: AdapterCredentials): Promise<OmsInventoryItem[]>;
    syncInventoryToMarketplace(_creds: AdapterCredentials, _items: OmsInventoryItem[]): Promise<InventorySyncResult>;
}
export declare const shopifyAdapter: ShopifyAdapter;
//# sourceMappingURL=shopify.adapter.d.ts.map