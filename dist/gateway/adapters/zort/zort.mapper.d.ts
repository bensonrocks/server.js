import type { ZortOrder, ZortProduct, ZortContact } from './zort.types';
import type { StandardOrder } from '../../models/standard-order';
import type { StandardCustomer } from '../../models/standard-customer';
import type { StandardInventory } from '../../models/standard-inventory';
export declare function mapZortProductToInventory(p: ZortProduct, channel: string): StandardInventory;
export declare function mapZortContactToCustomer(c: ZortContact): StandardCustomer & {
    id: string;
    address: string;
    taxId: string;
};
export declare function mapZortOrder(raw: ZortOrder, channel: string, clientId: string, clientName: string, auditRef?: string): StandardOrder;
//# sourceMappingURL=zort.mapper.d.ts.map