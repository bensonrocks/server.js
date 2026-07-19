// TODO: implement when Lazada Open Platform developer account is approved.
// Apply at: https://open.lazada.com
// Auth: HMAC-SHA256 signed params (appKey + sorted params concatenated + apiPath)

import type { IMarketplaceAdapter,
              AdapterCredentials,
              FetchOrdersOptions }        from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder }             from '../../models/standard-order';
import type { StandardInventory }         from '../../models/standard-inventory';
import type { StandardShipment,
              StandardFulfillmentResult } from '../../models/standard-shipment';

export class LazadaDirectAdapter implements IMarketplaceAdapter {
  readonly channel = 'lazada_direct';

  async fetchOrders(
    _creds: AdapterCredentials,
    _opts?: FetchOrdersOptions,
  ): Promise<StandardOrder[]> {
    throw new Error('LazadaDirectAdapter: pending Lazada Open Platform approval');
  }

  async pushShipment(
    _creds: AdapterCredentials,
    _shipment: StandardShipment,
  ): Promise<StandardFulfillmentResult> {
    throw new Error('LazadaDirectAdapter: pending Lazada Open Platform approval');
  }

  async fetchInventory(_creds: AdapterCredentials): Promise<StandardInventory[]> {
    throw new Error('LazadaDirectAdapter: pending Lazada Open Platform approval');
  }
}

export const lazadaDirectAdapter = new LazadaDirectAdapter();
