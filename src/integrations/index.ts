// ─────────────────────────────────────────────────────────────────────────────
//  IdealOne OMS — Marketplace Gateway
//  Registers all adapters into the central gateway service.
// ─────────────────────────────────────────────────────────────────────────────

export * from './marketplace-gateway/marketplace.types';
export * from './marketplace-gateway/marketplace-gateway.service';

export * from './shopify/shopify.adapter';
export * from './shopify/shopify.mapper';
export * from './shopify/shopify.oauth';
export * from './shopify/shopify.webhooks';

export * from './api2cart/api2cart.adapter';
export * from './api2cart/api2cart.mapper';

export * from './zetpy/zetpy.adapter';

export * from './lazada/lazada.adapter';
export * from './shopee/shopee.adapter';
export * from './tiktok/tiktok.adapter';

// ── Wire up the singleton gateway ────────────────────────────────────────────

import { gatewayService } from './marketplace-gateway/marketplace-gateway.service';

import { shopifyAdapter }  from './shopify/shopify.adapter';
import { shopifyOAuthMeta }  from './shopify/shopify.oauth';

import { api2CartAdapter, api2CartOAuthMeta } from './api2cart/api2cart.adapter';
import { zetpyAdapter, zetpyOAuthMeta }       from './zetpy/zetpy.adapter';

import { lazadaAdapter, lazadaOAuthMeta }  from './lazada/lazada.adapter';
import { shopeeAdapter, shopeeOAuthMeta }  from './shopee/shopee.adapter';
import { tiktokAdapter, tiktokOAuthMeta }  from './tiktok/tiktok.adapter';

gatewayService
  .register(shopifyAdapter,  shopifyOAuthMeta)
  .register(lazadaAdapter,   lazadaOAuthMeta)
  .register(shopeeAdapter,   shopeeOAuthMeta)
  .register(tiktokAdapter,   tiktokOAuthMeta)
  .register(api2CartAdapter, api2CartOAuthMeta)
  .register(zetpyAdapter,    zetpyOAuthMeta);

export { gatewayService };
