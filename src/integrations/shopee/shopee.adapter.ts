import crypto from 'crypto';
import type {
  IMarketplaceAdapter,
  AdapterCredentials,
  OmsOrder,
  OmsFulfillment,
  FulfillmentResult,
  FetchOrdersOptions,
  OAuthMeta,
  OAuthCallbackResult,
} from '../marketplace-gateway/marketplace.types';
import type { OrderStatus } from '../marketplace-gateway/marketplace.types';

// ─────────────────────────────────────────────────────────────────────────────
//  Shopee Adapter — Shopee Open Platform v2
//  Docs: https://open.shopee.com/developer-guide/intro
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 'https://partner.shopeemobile.com';

const STATUS_MAP: Record<string, OrderStatus> = {
  UNPAID:           'pending',
  READY_TO_SHIP:    'confirmed',
  PROCESSED:        'processing',
  RETRY_SHIP:       'processing',
  SHIPPED:          'shipped',
  TO_RETURN:        'shipped',
  COMPLETED:        'delivered',
  CANCELLED:        'cancelled',
  IN_CANCEL:        'cancelled',
};

function shopeeSign(partnerKey: string, partnerId: string, path: string, ts: number, token = '', shopId = ''): string {
  const msg = `${partnerId}${path}${ts}${token}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(msg).digest('hex');
}

export const shopeeOAuthMeta: OAuthMeta = {
  id:               'shopee',
  name:             'Shopee',
  type:             'ecommerce',
  authType:         'oauth',
  requiredForOAuth: ['partnerId'],
  defaultStoreName: 'Shopee Store',
};

export function buildShopeeAuthUrl(partnerId: string, partnerKey: string, callbackUrl: string): string {
  const ts   = Math.floor(Date.now() / 1000);
  const path = '/api/v2/shop/auth_partner';
  const sig  = shopeeSign(partnerKey, partnerId, path, ts);
  const p    = new URLSearchParams({ partner_id: partnerId, timestamp: String(ts), sign: sig, redirect: callbackUrl });
  return `${BASE}${path}?${p}`;
}

export async function exchangeShopeeCode(
  creds: AdapterCredentials,
  code: string,
  shopId: string,
): Promise<OAuthCallbackResult> {
  const { partnerId, partnerKey } = creds as { partnerId: string; partnerKey: string };
  const ts   = Math.floor(Date.now() / 1000);
  const path = '/api/v2/auth/token/get';
  const sig  = shopeeSign(partnerKey, partnerId, path, ts);
  const res  = await fetch(
    `${BASE}${path}?partner_id=${encodeURIComponent(partnerId)}&timestamp=${ts}&sign=${sig}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(partnerId) }),
    },
  );
  const j = await res.json() as { access_token?: string; refresh_token?: string; expire_in?: number; error?: string; message?: string };
  if (j.error) throw new Error(j.message ?? 'Shopee token exchange failed');
  return { accessToken: j.access_token!, refreshToken: j.refresh_token, expiresIn: j.expire_in, shopId };
}

export class ShopeeAdapter implements IMarketplaceAdapter {
  readonly channel = 'shopee' as const;

  private buildParams(
    creds: AdapterCredentials,
    path: string,
    extra: Record<string, string> = {},
  ): URLSearchParams {
    const partnerId = String(creds.partnerId ?? '');
    const partnerKey= String(creds.partnerKey ?? '');
    const token     = String(creds.accessToken ?? '');
    const shopId    = String(creds.shopId ?? '');
    const ts        = Math.floor(Date.now() / 1000);
    const sign      = shopeeSign(partnerKey, partnerId, path, ts, token, shopId);
    return new URLSearchParams({ partner_id: partnerId, timestamp: String(ts), sign, access_token: token, shop_id: shopId, ...extra });
  }

  async fetchOrders(creds: AdapterCredentials, opts: FetchOrdersOptions = {}): Promise<OmsOrder[]> {
    const path  = '/api/v2/order/get_order_list';
    const tsNow = Math.floor(Date.now() / 1000);
    const tsFrom = opts.since
      ? Math.floor(new Date(opts.since).getTime() / 1000)
      : tsNow - 7 * 86400;
    const params = this.buildParams(creds, path, {
      time_range_field: 'create_time',
      time_from:        String(tsFrom),
      time_to:          String(tsNow),
      page_size:        String(opts.pageSize ?? 50),
      cursor:           '',
    });
    const res  = await fetch(`${BASE}${path}?${params}`);
    const json = await res.json() as { error?: string; message?: string; response?: { order_list?: Record<string, unknown>[] } };
    if (json.error && json.error !== '') throw new Error(json.message ?? 'Shopee API error');

    const orders    = json.response?.order_list ?? [];
    const storeName = String(creds.storeName ?? 'Shopee Store');
    const clientId  = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    return orders.map(o => {
      type Item = Record<string, unknown>;
      const addr  = (o.recipient_address ?? {}) as Record<string, string>;
      const items: OmsOrder['items'] = ((o.item_list ?? []) as Item[]).map(i => ({
        sku:       String(i.item_sku ?? ''),
        name:      String(i.item_name ?? 'Item'),
        qty:       Number(i.model_quantity_purchased) || 1,
        unitPrice: Number(i.model_discounted_price)   || 0,
        variantId: String(i.item_id ?? ''),
      }));

      return {
        id:         `SPE-${o.order_sn}`,
        clientId,
        clientName: storeName,
        channel:    'shopee' as const,
        orderDate:  new Date(Number(o.create_time) * 1000).toISOString(),
        status:     STATUS_MAP[String(o.order_status ?? '')] ?? 'pending',
        currency:   String(o.currency ?? 'MYR'),
        notes:      String(o.message_to_seller ?? ''),
        items,
        shipping: {
          recipient:    addr.name ?? '',
          name:         addr.name ?? '',
          addressLine1: addr.full_address ?? '',
          addressLine2: '',
          city:         addr.city    ?? '',
          state:        addr.state   ?? '',
          zip:          addr.zipcode ?? '',
          country:      addr.country ?? '',
          phone:        addr.phone   ?? '',
        },
        subtotal:     Number(o.total_amount ?? 0),
        shippingCost: Number(o.actual_shipping_cost ?? 0),
        tax:          0,
        total:        Number(o.total_amount ?? 0),
        source: {
          type:       'shopee' as const,
          externalId: String(o.order_sn),
          orderName:  String(o.order_sn),
          ingestedAt: new Date().toISOString(),
        },
      };
    });
  }

  async pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult> {
    const path   = '/api/v2/logistics/ship_order';
    const params = this.buildParams(creds, path);
    const body: Record<string, unknown> = { order_sn: fulfillment.externalOrderId };
    if (fulfillment.trackingNumber) {
      body.pickup = { tracking_no: fulfillment.trackingNumber };
    }
    const res  = await fetch(`${BASE}${path}?${params}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json() as { error?: string; message?: string };
    if (json.error && json.error !== '') throw new Error(json.message ?? 'Shopee fulfillment error');
    return { ok: true };
  }
}

export const shopeeAdapter = new ShopeeAdapter();
