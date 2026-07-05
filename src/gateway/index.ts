// ─────────────────────────────────────────────────────────────────────────────
//  IDEALone Marketplace Gateway — public surface
//
//  OMS modules MUST only import from this barrel.
//  Adapter-internal types (ZortOrder, ZortCredentials, etc.) are deliberately
//  NOT exported here — they must never appear in OMS business logic.
// ─────────────────────────────────────────────────────────────────────────────

// ── Standard Models (the only types OMS code should reference) ───────────────
export type { StandardCustomer }                         from './models/standard-customer';
export type { OrderStatus,
              StandardOrder,
              StandardOrderItem,
              StandardShippingAddress,
              StandardOrderSource }                      from './models/standard-order';
export type { StandardInventory }                        from './models/standard-inventory';
export type { StandardShipment,
              StandardFulfillmentResult }                from './models/standard-shipment';

// ── Adapter interface (needed only when building a new adapter) ──────────────
export type { IMarketplaceAdapter,
              AdapterCredentials,
              FetchOrdersOptions }                       from './interfaces/marketplace-adapter.interface';

// ── Gateway service ───────────────────────────────────────────────────────────
export { MarketplaceGatewayService }                     from './gateway.service';

// ── Audit log (admin / diagnostic use — not for OMS business logic) ──────────
export { auditLogService }                               from './audit/audit-log.service';

// ── Pre-wired singleton ────────────────────────────────────────────────────────
import { MarketplaceGatewayService }                     from './gateway.service';
import { zortAdapter }                                   from './adapters/zort/zort.adapter';
import { shopeeDirectAdapter }                           from './adapters/shopee-direct/shopee-direct.adapter';
import { lazadaDirectAdapter }                           from './adapters/lazada-direct/lazada-direct.adapter';
import { tiktokDirectAdapter }                           from './adapters/tiktok-direct/tiktok-direct.adapter';
import { shopifyDirectAdapter }                          from './adapters/shopify-direct/shopify-direct.adapter';

export const gateway = new MarketplaceGatewayService()
  .register(zortAdapter)
  .register(shopeeDirectAdapter)
  .register(lazadaDirectAdapter)
  .register(tiktokDirectAdapter)
  .register(shopifyDirectAdapter);
