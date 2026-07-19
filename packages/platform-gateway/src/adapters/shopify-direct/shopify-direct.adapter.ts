// TODO: implement using existing lib/shopify-app/ infrastructure.
// Shopify public app flow is already built — wire it to this adapter.
// Apply at: https://partners.shopify.com → Create App (Public)

import type { IMarketplaceAdapter,
              AdapterCredentials,
              FetchOrdersOptions }        from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder }             from '../../models/standard-order';
import type { StandardInventory }         from '../../models/standard-inventory';
import type { StandardShipment,
              StandardFulfillmentResult } from '../../models/standard-shipment';

export class ShopifyDirectAdapter implements IMarketplaceAdapter {
  readonly channel = 'shopify_direct';

  async fetchOrders(
    _creds: AdapterCredentials,
    _opts?: FetchOrdersOptions,
  ): Promise<StandardOrder[]> {
    throw new Error('ShopifyDirectAdapter: pending wiring to lib/shopify-app');
  }

  async pushShipment(
    _creds: AdapterCredentials,
    _shipment: StandardShipment,
  ): Promise<StandardFulfillmentResult> {
    throw new Error('ShopifyDirectAdapter: pending wiring to lib/shopify-app');
  }

  async fetchInventory(_creds: AdapterCredentials): Promise<StandardInventory[]> {
    throw new Error('ShopifyDirectAdapter: pending wiring to lib/shopify-app');
  }
}

export const shopifyDirectAdapter = new ShopifyDirectAdapter();
