import type { IMarketplaceAdapter, AdapterCredentials, FetchOrdersOptions } from './interfaces/marketplace-adapter.interface';
import type { StandardOrder } from './models/standard-order';
import type { StandardInventory } from './models/standard-inventory';
import type { StandardShipment, StandardFulfillmentResult } from './models/standard-shipment';
export declare class MarketplaceGatewayService {
    private readonly adapters;
    register(adapter: IMarketplaceAdapter): this;
    get(channel: string): IMarketplaceAdapter;
    has(channel: string): boolean;
    channels(): string[];
    adaptersWithLicense(): string[];
    fetchOrders(channel: string, creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<StandardOrder[]>;
    pushShipment(channel: string, creds: AdapterCredentials, shipment: StandardShipment): Promise<StandardFulfillmentResult>;
    fetchInventory(channel: string, creds: AdapterCredentials): Promise<StandardInventory[]>;
    syncInventory(channel: string, creds: AdapterCredentials, items: StandardInventory[]): Promise<void>;
    fetchWaybill(channel: string, creds: AdapterCredentials, externalOrderId: string): Promise<{
        url: string;
    }>;
}
//# sourceMappingURL=gateway.service.d.ts.map