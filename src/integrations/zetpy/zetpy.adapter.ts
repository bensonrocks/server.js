import type {
  IMarketplaceAdapter,
  AdapterCredentials,
  OmsOrder,
  OmsFulfillment,
  FulfillmentResult,
  FetchOrdersOptions,
  OAuthMeta,
  OrderStatus,
} from '../marketplace-gateway/marketplace.types';

// ─────────────────────────────────────────────────────────────────────────────
//  Zetpy Adapter — Multi-channel aggregator (SEA: Shopee, Lazada, TikTok, etc.)
//  Docs:  https://developers.zetpy.com  (login required)
//
//  ⚠️  SKELETON — field names and paths below are best-guess from common REST
//  conventions.  Verify every TODO against the real Zetpy API docs / Postman
//  collection before going live.
// ─────────────────────────────────────────────────────────────────────────────

// TODO: confirm exact base URL (may be https://app.zetpy.com/api or https://api.zetpy.com/v1)
const API_BASE = 'https://api.zetpy.com/v1';

// TODO: confirm auth header name & format (Bearer token, X-API-Key, etc.)
function authHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,   // TODO: confirm header
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
}

// TODO: map real Zetpy order statuses to OMS statuses
// Common Zetpy status strings (guessed — verify against actual API response)
const STATUS_MAP: Record<string, OrderStatus> = {
  pending:            'pending',     // TODO: verify actual status strings
  confirmed:          'confirmed',
  processing:         'processing',
  ready_to_ship:      'processing',
  shipped:            'shipped',
  in_transit:         'shipped',
  delivered:          'delivered',
  completed:          'delivered',
  cancelled:          'cancelled',
  canceled:           'cancelled',
};

export const zetpyOAuthMeta: OAuthMeta = {
  id:               'zetpy',
  name:             'Zetpy',
  type:             'ecommerce',
  authType:         'apikey',
  requiredForOAuth: [],
  defaultStoreName: 'Zetpy Store',
};

// ── Types for raw Zetpy API responses (update once real docs confirmed) ──────

interface ZetpyOrderItem {
  sku:         string;   // TODO: confirm field name
  name:        string;   // TODO: confirm
  quantity:    number;   // TODO: confirm (may be qty or item_quantity)
  unit_price:  number;   // TODO: confirm (may be price or sale_price)
}

interface ZetpyAddress {
  name:        string;   // TODO: confirm
  phone:       string;   // TODO: confirm
  address1:    string;   // TODO: confirm (may be address_line_1)
  address2:    string;
  city:        string;
  state:       string;
  postcode:    string;   // TODO: confirm (may be zip or postal_code)
  country:     string;
}

interface ZetpyOrder {
  id:             string | number;  // TODO: confirm field name (may be order_id)
  order_number:   string;           // TODO: confirm (may be reference_number)
  channel:        string;           // source marketplace: shopee, lazada, tiktok…  TODO: confirm field
  status:         string;           // TODO: verify status strings
  currency:       string;           // TODO: confirm
  created_at:     string;           // TODO: confirm (may be order_date or created_time)
  subtotal:       number;           // TODO: confirm (may be sub_total or item_total)
  shipping_fee:   number;           // TODO: confirm
  total:          number;           // TODO: confirm (may be total_amount)
  buyer_note:     string;           // TODO: confirm (may be note or remarks)
  items:          ZetpyOrderItem[]; // TODO: confirm array field name (may be line_items or products)
  shipping_address: ZetpyAddress;   // TODO: confirm (may be delivery_address)
}

interface ZetpyOrderListResponse {
  data:         ZetpyOrder[];       // TODO: confirm (may be orders or results)
  total:        number;             // TODO: confirm
  page:         number;             // TODO: confirm
  per_page:     number;             // TODO: confirm
  last_page:    number;             // TODO: confirm (may be total_pages)
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class ZetpyAdapter implements IMarketplaceAdapter {
  readonly channel      = 'zetpy' as const;
  readonly requiresLicense = true;

  private assertKey(creds: AdapterCredentials): string {
    const key = String(creds.licenseKey ?? creds.apiKey ?? '');
    if (!key) {
      throw Object.assign(
        new Error('Zetpy requires an API key — obtain one from your Zetpy account settings.'),
        { status: 402 },
      );
    }
    return key;
  }

  // ── Internal request helper ───────────────────────────────────────────────

  private async request<T>(
    apiKey: string,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string>,
  ): Promise<T> {
    let url = `${API_BASE}${path}`;
    if (params && Object.keys(params).length) {
      url += `?${new URLSearchParams(params)}`;
    }
    const res = await fetch(url, {
      method,
      headers: authHeaders(apiKey),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Zetpy ${method} ${path} → HTTP ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  // ── fetchOrders ───────────────────────────────────────────────────────────

  async fetchOrders(creds: AdapterCredentials, opts: FetchOrdersOptions = {}): Promise<OmsOrder[]> {
    const apiKey    = this.assertKey(creds);
    const storeName = String(creds.storeName ?? 'Zetpy Store');
    const clientId  = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    // TODO: confirm endpoint path (may be /orders or /api/orders)
    // TODO: confirm query param names for date range and pagination
    const params: Record<string, string> = {
      per_page: String(opts.pageSize ?? 50),    // TODO: confirm param name
      page:     '1',                             // TODO: confirm param name
    };
    if (opts.since) {
      params['created_from'] = new Date(opts.since).toISOString();  // TODO: confirm
    }
    if (opts.status) {
      params['status'] = opts.status;            // TODO: confirm filter param
    }

    const resp = await this.request<ZetpyOrderListResponse>(
      apiKey, 'GET',
      '/orders',   // TODO: confirm endpoint path
      undefined,
      params,
    );

    const orders = resp.data ?? [];              // TODO: confirm response wrapper field

    return orders.map(o => this.mapOrder(o, storeName, clientId));
  }

  // ── Map raw Zetpy order → OmsOrder ───────────────────────────────────────

  private mapOrder(o: ZetpyOrder, storeName: string, clientId: string): OmsOrder {
    const addr = o.shipping_address ?? ({} as ZetpyAddress);  // TODO: confirm field name

    const items: OmsOrder['items'] = (o.items ?? []).map(i => ({  // TODO: confirm array name
      sku:       String(i.sku        ?? ''),
      name:      String(i.name       ?? 'Item'),
      qty:       Number(i.quantity)  || 1,       // TODO: confirm field name
      unitPrice: Number(i.unit_price) || 0,      // TODO: confirm field name
    }));

    // Zetpy aggregates multiple channels, so preserve the source channel
    // TODO: confirm o.channel values match: 'shopee','lazada','tiktok','shopify',…
    const sourceChannel = String(o.channel ?? 'zetpy');

    return {
      id:         `ZTP-${o.id}`,                          // TODO: confirm id field
      clientId,
      clientName: storeName,
      channel:    'zetpy',
      orderDate:  String(o.created_at ?? new Date().toISOString()),  // TODO: confirm
      status:     STATUS_MAP[String(o.status ?? '').toLowerCase()] ?? 'pending',
      currency:   String(o.currency ?? 'MYR'),             // TODO: confirm field
      notes:      String(o.buyer_note ?? ''),              // TODO: confirm field
      items,
      shipping: {
        recipient:    addr.name        ?? '',
        name:         addr.name        ?? '',
        addressLine1: addr.address1    ?? '',               // TODO: confirm field
        addressLine2: addr.address2    ?? '',
        city:         addr.city        ?? '',
        state:        addr.state       ?? '',
        zip:          addr.postcode    ?? '',               // TODO: confirm field
        country:      addr.country     ?? '',
        phone:        addr.phone       ?? '',
      },
      subtotal:     Number(o.subtotal   ?? 0),             // TODO: confirm field
      shippingCost: Number(o.shipping_fee ?? 0),           // TODO: confirm field
      tax:          0,
      total:        Number(o.total      ?? 0),             // TODO: confirm field
      source: {
        type:       'zetpy',
        externalId: String(o.id),                          // TODO: confirm id field
        orderName:  String(o.order_number ?? o.id),        // TODO: confirm field
        ingestedAt: new Date().toISOString(),
        // Preserve original marketplace for display
        ...(sourceChannel !== 'zetpy' ? { originChannel: sourceChannel } : {}),
      } as OmsOrder['source'],
    };
  }

  // ── pushFulfillment ───────────────────────────────────────────────────────

  async pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult> {
    const apiKey = this.assertKey(creds);

    // TODO: confirm endpoint path and body field names
    await this.request(apiKey, 'POST',
      `/orders/${fulfillment.externalOrderId}/fulfill`,   // TODO: confirm endpoint
      {
        tracking_number: fulfillment.trackingNumber ?? '', // TODO: confirm field
        carrier:         fulfillment.carrier         ?? '', // TODO: confirm field
        notify_buyer:    true,                             // TODO: confirm field + if supported
      },
    );

    return { ok: true };
  }
}

export const zetpyAdapter = new ZetpyAdapter();
