import type { IMarketplaceAdapter, AdapterCredentials, FetchOrdersOptions } from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder } from '../../models/standard-order';
import type { StandardShipment, StandardFulfillmentResult } from '../../models/standard-shipment';
export declare class ZortAdapter implements IMarketplaceAdapter {
    readonly channel = "zort";
    readonly requiresLicense = true;
    fetchOrders(creds: AdapterCredentials, opts?: FetchOrdersOptions): Promise<StandardOrder[]>;
    pushShipment(creds: AdapterCredentials, shipment: StandardShipment): Promise<StandardFulfillmentResult>;
}
export declare const zortAdapter: ZortAdapter;
//# sourceMappingURL=zort.adapter.d.ts.map