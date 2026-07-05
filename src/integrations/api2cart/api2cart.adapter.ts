import type {
  IMarketplaceAdapter,
  AdapterCredentials,
  OmsOrder,
  OmsFulfillment,
  FulfillmentResult,
  FetchOrdersOptions,
} from '../marketplace-gateway/marketplace.types';
import type { OAuthMeta } from '../marketplace-gateway/marketplace.types';
import { mapApi2CartOrder } from './api2cart.mapper';

// ─────────────────────────────────────────────────────────────────────────────
//  API2Cart Adapter — paid multi-cart connector (40+ shopping carts via one API)
//  License required. Contact your IdealOne representative to activate.
//  Docs: https://api2cart.com/docs/
// ─────────────────────────────────────────────────────────────────────────────

const API2CART_BASE = 'https://api.api2cart.com/v1.1';

export const api2CartOAuthMeta: OAuthMeta = {
  id:               'api2cart',
  name:             'API2Cart (Multi-Cart)',
  type:             'ecommerce',
  authType:         'apikey',
  requiredForOAuth: ['licenseKey', 'storeKey'],
  defaultStoreName: 'API2Cart Store',
};

export class Api2CartAdapter implements IMarketplaceAdapter {
  readonly channel         = 'api2cart' as const;
  readonly requiresLicense = true;

  private assertLicense(creds: AdapterCredentials): { apiKey: string; storeKey: string } {
    if (!creds.licenseKey) {
      throw Object.assign(
        new Error('API2Cart requires a paid licence key. Contact your IdealOne representative.'),
        { status: 402 },
      );
    }
    return { apiKey: String(creds.licenseKey), storeKey: String(creds.storeKey ?? '') };
  }

  private async request(
    apiKey: string,
    storeKey: string,
    endpoint: string,
    params: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${API2CART_BASE}${endpoint}.json`);
    url.searchParams.set('api_key', apiKey);
    if (storeKey) url.searchParams.set('store_key', storeKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res  = await fetch(url.toString());
    const json = await res.json() as { return?: Record<string, unknown>; status?: string; message?: string };
    if (json.status === 'error') throw new Error(json.message ?? 'API2Cart error');
    return (json.return ?? {}) as Record<string, unknown>;
  }

  async fetchOrders(creds: AdapterCredentials, opts: FetchOrdersOptions = {}): Promise<OmsOrder[]> {
    const { apiKey, storeKey } = this.assertLicense(creds);
    const since = opts.since
      ? new Date(opts.since).toISOString()
      : new Date(Date.now() - 7 * 86400000).toISOString();
    const data  = await this.request(apiKey, storeKey, '/order.list', {
      created_from: since,
      count:        String(opts.pageSize ?? 50),
      start:        String(opts.offset   ?? 0),
    });
    const orders = (data.orders as Record<string, unknown>[]) ?? [];
    const store  = String(creds.storeName ?? creds.storeUrl ?? 'API2Cart Store');
    return orders.map(o => mapApi2CartOrder(o, store));
  }

  async pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult> {
    const { apiKey, storeKey } = this.assertLicense(creds);
    const params: Record<string, string> = { order_id: fulfillment.externalOrderId };
    if (fulfillment.trackingNumber) params.tracking_number = fulfillment.trackingNumber;
    if (fulfillment.carrier)        params.shipping_provider = fulfillment.carrier;
    await this.request(apiKey, storeKey, '/order.shipment.add', params);
    return { ok: true };
  }
}

export const api2CartAdapter = new Api2CartAdapter();
