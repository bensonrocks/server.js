import type { IMarketplaceAdapter, AdapterCredentials, FetchOrdersOptions } from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder } from '../../models/standard-order';
import type { StandardInventory } from '../../models/standard-inventory';
import type { StandardShipment, StandardFulfillmentResult } from '../../models/standard-shipment';
import type { ZortProductListResponse, ZortWebhookResponse } from './zort.types';
export declare class ZortAdapter implements IMarketplaceAdapter {
    readonly channel = "zort";
    readonly requiresLicense = true;
    fetchOrders(creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<StandardOrder[]>;
    pushShipment(creds: AdapterCredentials, shipment: StandardShipment): Promise<StandardFulfillmentResult>;
    fetchInventory(creds: AdapterCredentials): Promise<StandardInventory[]>;
    syncInventory(creds: AdapterCredentials, items: StandardInventory[]): Promise<void>;
    fetchProducts(creds: AdapterCredentials): Promise<ZortProductListResponse['list']>;
    fetchCustomers(creds: AdapterCredentials): Promise<(import("../..").StandardCustomer & {
        id: string;
        address: string;
        taxId: string;
    })[]>;
    registerWebhook(creds: AdapterCredentials, url: string): Promise<ZortWebhookResponse>;
}
export declare const zortAdapter: ZortAdapter;
//# sourceMappingURL=zort.adapter.d.ts.map