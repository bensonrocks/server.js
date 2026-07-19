// TODO: implement when Shopee Open Platform partner account is approved.
// Apply at: https://open.shopee.com
// Auth: HMAC-SHA256 (partnerId + path + timestamp + accessToken + shopId)

import type { IMarketplaceAdapter,
              AdapterCredentials,
              FetchOrdersOptions }        from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder }             from '../../models/standard-order';
import type { StandardInventory }         from '../../models/standard-inventory';
import type { StandardShipment,
              StandardFulfillmentResult } from '../../models/standard-shipment';

export class ShopeeDirectAdapter implements IMarketplaceAdapter {
  readonly channel = 'shopee_direct';

  async fetchOrders(
    _creds: AdapterCredentials,
    _opts?: FetchOrdersOptions,
  ): Promise<StandardOrder[]> {
    throw new Error('ShopeeDirectAdapter: pending Shopee Open Platform approval');
  }

  async pushShipment(
    _creds: AdapterCredentials,
    _shipment: StandardShipment,
  ): Promise<StandardFulfillmentResult> {
    throw new Error('ShopeeDirectAdapter: pending Shopee Open Platform approval');
  }

  async fetchInventory(_creds: AdapterCredentials): Promise<StandardInventory[]> {
    throw new Error('ShopeeDirectAdapter: pending Shopee Open Platform approval');
  }
}

export const shopeeDirectAdapter = new ShopeeDirectAdapter();
