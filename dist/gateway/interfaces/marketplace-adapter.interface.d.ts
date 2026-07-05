import type { StandardOrder } from '../models/standard-order';
import type { StandardInventory } from '../models/standard-inventory';
import type { StandardShipment, StandardFulfillmentResult } from '../models/standard-shipment';
export interface AdapterCredentials {
    storeName?: string;
    storename?: string;
    apikey?: string;
    apisecret?: string;
    licenseKey?: string;
    email?: string;
    password?: string;
    accessToken?: string;
    refreshToken?: string;
    shopId?: string;
    appKey?: string;
    appSecret?: string;
    partnerId?: string;
    partnerKey?: string;
    shopDomain?: string;
    apiKey?: string;
    apiSecret?: string;
}
export interface FetchOrdersOptions {
    since?: string;
    status?: string;
    pageSize?: number;
    page?: number;
}
export interface IMarketplaceAdapter {
    /** Unique channel key, e.g. 'zort', 'shopee_direct' */
    readonly channel: string;
    /** true = adapter requires a paid subscription key */
    readonly requiresLicense?: boolean;
    /**
     * Pull orders from the platform.
     * Must return StandardOrder[] — never leak internal platform types.
     */
    fetchOrders(credentials: AdapterCredentials, options?: FetchOrdersOptions): Promise<StandardOrder[]>;
    /**
     * Push a tracking number back to the platform after packing.
     * Receives a StandardShipment — must not accept platform-specific objects.
     */
    pushShipment(credentials: AdapterCredentials, shipment: StandardShipment): Promise<StandardFulfillmentResult>;
    /** Pull inventory levels from the platform (optional). */
    fetchInventory?(credentials: AdapterCredentials): Promise<StandardInventory[]>;
    /** Push IDEALone stock levels to the platform (optional). */
    syncInventory?(credentials: AdapterCredentials, items: StandardInventory[]): Promise<void>;
}
//# sourceMappingURL=marketplace-adapter.interface.d.ts.map