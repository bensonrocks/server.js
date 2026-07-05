export type MarketplaceChannel = 'shopify' | 'lazada' | 'shopee' | 'tiktok' | 'api2cart' | 'zetpy' | 'channelengine';
export type OrderStatus = 'pending' | 'confirmed' | 'processing' | 'packed' | 'shipped' | 'delivered' | 'cancelled';
export interface OmsOrderItem {
    sku: string;
    name: string;
    qty: number;
    unitPrice: number;
    variantId?: string;
}
export interface OmsShipping {
    recipient: string;
    name: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone: string;
}
export interface OmsOrderSource {
    type: MarketplaceChannel;
    externalId: string;
    orderName?: string;
    shippingName?: string;
    ingestedAt: string;
    trackingNo?: string;
    courier?: string;
    trackingUrl?: string;
    lastFulfilledAt?: string;
    lastSyncedAt?: string;
    cancelledAt?: string;
}
export interface OmsOrder {
    id: string;
    clientId: string;
    clientName: string;
    channel: MarketplaceChannel;
    orderDate: string;
    status: OrderStatus;
    currency: string;
    notes: string;
    items: OmsOrderItem[];
    shipping: OmsShipping;
    subtotal: number;
    shippingCost: number;
    tax: number;
    total: number;
    source: OmsOrderSource;
}
export interface OmsInventoryItem {
    sku: string;
    name: string;
    description?: string;
    category?: string;
    unit: string;
    location?: string;
    stockQty: number;
    reservedQty: number;
    reorderPoint: number;
    costPrice: number;
    sellPrice: number;
    clientId?: string;
}
export interface OmsFulfillment {
    orderId: string;
    externalOrderId: string;
    shopDomain?: string;
    trackingNumber?: string;
    carrier?: string;
    trackingUrl?: string;
    notifyCustomer: boolean;
    message?: string;
}
export interface FulfillmentResult {
    ok: boolean;
    skipped?: boolean;
    reason?: string;
    fulfillmentId?: string | number;
    error?: string;
}
export interface WaybillInfo {
    url: string | null;
    trackingNumber: string | null;
    carrier: string | null;
}
export interface InventorySyncResult {
    pushed?: number;
    pulled?: number;
    errors?: string[];
}
export interface AdapterCredentials {
    accessToken?: string;
    shopDomain?: string;
    apiKey?: string;
    apiSecret?: string;
    appKey?: string;
    appSecret?: string;
    partnerId?: string;
    partnerKey?: string;
    shopId?: string;
    region?: string;
    storeName?: string;
    refreshToken?: string;
    licenseKey?: string;
    storeKey?: string;
    storeUrl?: string;
    [key: string]: unknown;
}
export interface FetchOrdersOptions {
    since?: string;
    pageSize?: number;
    status?: string;
    offset?: number;
}
export interface IMarketplaceAdapter {
    readonly channel: MarketplaceChannel;
    readonly requiresLicense?: boolean;
    /** Return orders already mapped to OmsOrder format. */
    fetchOrders(creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<OmsOrder[]>;
    /** Push shipment + tracking back to the marketplace. */
    pushFulfillment?(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult>;
    /** Retrieve existing tracking info from the marketplace. */
    fetchWaybill?(creds: AdapterCredentials, externalId: string): Promise<WaybillInfo>;
    /** Push IDEALONE inventory quantities to the marketplace. */
    syncInventoryToMarketplace?(creds: AdapterCredentials, items: OmsInventoryItem[]): Promise<InventorySyncResult>;
    /** Pull marketplace inventory quantities into IDEALONE format. */
    syncInventoryFromMarketplace?(creds: AdapterCredentials): Promise<OmsInventoryItem[]>;
}
export interface OAuthMeta {
    id: MarketplaceChannel;
    name: string;
    type: string;
    authType: 'oauth' | 'apikey' | 'token';
    requiredForOAuth?: string[];
    regions?: string[];
    defaultStoreName?: string;
}
export interface OAuthCallbackResult {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    scope?: string;
    shopDomain?: string;
    shopId?: string;
}
//# sourceMappingURL=marketplace.types.d.ts.map