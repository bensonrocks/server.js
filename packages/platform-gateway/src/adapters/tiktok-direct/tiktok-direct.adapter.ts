// TODO: implement when TikTok Shop Partner account is approved.
// Apply at: https://partner.tiktokshop.com
// Auth: HMAC-SHA256 (appSecret + sorted_params + body + appSecret)

import type { IMarketplaceAdapter,
              AdapterCredentials,
              FetchOrdersOptions }        from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder }             from '../../models/standard-order';
import type { StandardInventory }         from '../../models/standard-inventory';
import type { StandardShipment,
              StandardFulfillmentResult } from '../../models/standard-shipment';

export class TiktokDirectAdapter implements IMarketplaceAdapter {
  readonly channel = 'tiktok_direct';

  async fetchOrders(
    _creds: AdapterCredentials,
    _opts?: FetchOrdersOptions,
  ): Promise<StandardOrder[]> {
    throw new Error('TiktokDirectAdapter: pending TikTok Shop Partner approval');
  }

  async pushShipment(
    _creds: AdapterCredentials,
    _shipment: StandardShipment,
  ): Promise<StandardFulfillmentResult> {
    throw new Error('TiktokDirectAdapter: pending TikTok Shop Partner approval');
  }

  async fetchInventory(_creds: AdapterCredentials): Promise<StandardInventory[]> {
    throw new Error('TiktokDirectAdapter: pending TikTok Shop Partner approval');
  }
}

export const tiktokDirectAdapter = new TiktokDirectAdapter();
