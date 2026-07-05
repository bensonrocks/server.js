import type { IMarketplaceAdapter, AdapterCredentials, FetchOrdersOptions } from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder } from '../../models/standard-order';
import type { StandardInventory } from '../../models/standard-inventory';
import type { StandardShipment, StandardFulfillmentResult } from '../../models/standard-shipment';
export declare class LazadaDirectAdapter implements IMarketplaceAdapter {
    readonly channel = "lazada_direct";
    fetchOrders(_creds: AdapterCredentials, _opts?: FetchOrdersOptions): Promise<StandardOrder[]>;
    pushShipment(_creds: AdapterCredentials, _shipment: StandardShipment): Promise<StandardFulfillmentResult>;
    fetchInventory(_creds: AdapterCredentials): Promise<StandardInventory[]>;
}
export declare const lazadaDirectAdapter: LazadaDirectAdapter;
//# sourceMappingURL=lazada-direct.adapter.d.ts.map