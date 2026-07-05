export type { StandardCustomer } from './models/standard-customer';
export type { OrderStatus, StandardOrder, StandardOrderItem, StandardShippingAddress, StandardOrderSource } from './models/standard-order';
export type { StandardInventory } from './models/standard-inventory';
export type { StandardShipment, StandardFulfillmentResult } from './models/standard-shipment';
export type { IMarketplaceAdapter, AdapterCredentials, FetchOrdersOptions } from './interfaces/marketplace-adapter.interface';
export { MarketplaceGatewayService } from './gateway.service';
export { auditLogService } from './audit/audit-log.service';
import { MarketplaceGatewayService } from './gateway.service';
export declare const gateway: MarketplaceGatewayService;
//# sourceMappingURL=index.d.ts.map