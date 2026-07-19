// ─────────────────────────────────────────────────────────────────────────────
//  Platform Gateway — public surface
//
//  A portable, zero-dependency marketplace-integration layer. One unified API
//  over ZORT and the major selling platforms, returning Standard Models so your
//  app never touches a platform-specific payload shape.
//
//  Import ONLY from this barrel. Adapter-internal types (ZortOrder, etc.) are
//  deliberately not exported — they must never leak into business logic.
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

// ── Audit log (raw-payload capture; pluggable sink for your own persistence) ─
export { auditLogService }                               from './audit/audit-log.service';
export type { AuditEntry, AuditSink }                    from './audit/audit-log.service';

// ── Adapters (register your own combination, or extend these) ────────────────
export { ZortAdapter, zortAdapter }                      from './adapters/zort/zort.adapter';
export { ShopeeDirectAdapter, shopeeDirectAdapter }      from './adapters/shopee-direct/shopee-direct.adapter';
export { LazadaDirectAdapter, lazadaDirectAdapter }      from './adapters/lazada-direct/lazada-direct.adapter';
export { TiktokDirectAdapter, tiktokDirectAdapter }      from './adapters/tiktok-direct/tiktok-direct.adapter';
export { ShopifyDirectAdapter, shopifyDirectAdapter }    from './adapters/shopify-direct/shopify-direct.adapter';

// ── Gateway service ───────────────────────────────────────────────────────────
export { MarketplaceGatewayService }                     from './gateway.service';

// ── Pre-wired singleton ────────────────────────────────────────────────────────
//  ZORT is production-ready; the *-direct adapters are scaffolds you complete
//  once each platform's developer account is approved (see README + the TODO
//  header in each adapter for the exact application URL).
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
