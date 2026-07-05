import type { IMarketplaceAdapter, AdapterCredentials, FetchOrdersOptions } from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder } from '../../models/standard-order';
import type { StandardInventory } from '../../models/standard-inventory';
import type { StandardShipment, StandardFulfillmentResult } from '../../models/standard-shipment';
export declare class ZetpyAdapter implements IMarketplaceAdapter {
    readonly channel = "zetpy";
    readonly requiresLicense = true;
    fetchOrders(creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<StandardOrder[]>;
    pushShipment(creds: AdapterCredentials, shipment: StandardShipment): Promise<StandardFulfillmentResult>;
    syncInventory(creds: AdapterCredentials, items: StandardInventory[]): Promise<void>;
}
export declare const zetpyAdapter: ZetpyAdapter;
//# sourceMappingURL=zetpy.adapter.d.ts.map