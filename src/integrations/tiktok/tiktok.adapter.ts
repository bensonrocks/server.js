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
//  TikTok Shop Adapter — TikTok Shop Open Platform
//  Docs: https://partner.tiktokshop.com/docv2/page/650a14d4e4c1452e7b8a3e12
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE  = 'https://open-api.tiktokglobalshop.com';
const AUTH_URL  = 'https://auth.tiktok-shops.com/oauth/authorize';
const API_VER   = '202309';

const STATUS_MAP: Record<string, OrderStatus> = {
  UNPAID:                   'pending',
  ON_HOLD:                  'pending',
  AWAITING_SHIPMENT:        'confirmed',
  PARTIALLY_SHIPPING:       'processing',
  AWAITING_COLLECTION:      'processing',
  IN_TRANSIT:               'shipped',
  DELIVERED:                'delivered',
  COMPLETED:                'delivered',
  CANCELLED:                'cancelled',
};

function tiktokSign(appSecret: string, params: Record<string, string>, body = ''): string {
  const exclude = new Set(['sign', 'access_token']);
  const str = Object.keys(params)
    .filter(k => !exclude.has(k))
    .sort()
    .map(k => `${k}${params[k]}`)
    .join('');
  return crypto.createHmac('sha256', appSecret).update(`${appSecret}${str}${body}${appSecret}`).digest('hex');
}

export const tiktokOAuthMeta: OAuthMeta = {
  id:               'tiktok',
  name:             'TikTok Shop',
  type:             'ecommerce',
  authType:         'oauth',
  requiredForOAuth: ['appKey'],
  defaultStoreName: 'TikTok Shop',
};

export function buildTiktokAuthUrl(appKey: string, callbackUrl: string): string {
  const p = new URLSearchParams({ app_key: appKey, state: 'idealoms', redirect_uri: callbackUrl });
  return `${AUTH_URL}?${p}`;
}

export async function exchangeTiktokCode(
  creds: AdapterCredentials,
  code: string,
): Promise<OAuthCallbackResult> {
  const appKey    = String(creds.appKey    ?? '');
  const appSecret = String(creds.appSecret ?? '');
  const ts        = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = { app_key: appKey, auth_code: code, grant_type: 'authorized_code', timestamp: String(ts) };
  params.sign     = tiktokSign(appSecret, params);
  const res       = await fetch(`${API_BASE}/api/v2/token/get?${new URLSearchParams(params)}`);
  const j         = await res.json() as { code?: number; message?: string; data?: { access_token?: string; refresh_token?: string; access_token_expire_in?: number } };
  if (j.code !== 0) throw new Error(j.message ?? 'TikTok token exchange failed');
  return {
    accessToken:  j.data?.access_token!,
    refreshToken: j.data?.refresh_token,
    expiresIn:    j.data?.access_token_expire_in,
  };
}

export class TiktokAdapter implements IMarketplaceAdapter {
  readonly channel = 'tiktok' as const;

  private async post<T>(creds: AdapterCredentials, endpoint: string, bodyObj: Record<string, unknown>): Promise<T> {
    const appKey    = String(creds.appKey    ?? '');
    const appSecret = String(creds.appSecret ?? '');
    const token     = String(creds.accessToken ?? '');
    const shopId    = String(creds.shopId ?? '');
    const ts        = Math.floor(Date.now() / 1000);

    const params: Record<string, string> = {
      app_key:      appKey,
      access_token: token,
      timestamp:    String(ts),
      shop_id:      shopId,
      version:      API_VER,
    };
    const bodyStr    = JSON.stringify(bodyObj);
    params.sign      = tiktokSign(appSecret, params, bodyStr);

    const res  = await fetch(`${API_BASE}${endpoint}?${new URLSearchParams(params)}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    bodyStr,
    });
    const json = await res.json() as { code?: number; message?: string; data?: T };
    if (json.code !== 0) throw new Error(`TikTok error ${json.code}: ${json.message}`);
    return json.data as T;
  }

  async fetchOrders(creds: AdapterCredentials, opts: FetchOrdersOptions = {}): Promise<OmsOrder[]> {
    const tsNow  = Math.floor(Date.now() / 1000);
    const tsFrom = opts.since ? Math.floor(new Date(opts.since).getTime() / 1000) : tsNow - 7 * 86400;

    type TikOrder = Record<string, unknown>;
    const data = await this.post<{ order_list?: TikOrder[] }>(creds, '/api/orders/search', {
      create_time_ge: tsFrom,
      create_time_lt: tsNow,
      page_size:      opts.pageSize ?? 50,
      status:         opts.status  ?? 'AWAITING_SHIPMENT',
    });

    const orders    = data.order_list ?? [];
    const storeName = String(creds.storeName ?? 'TikTok Shop');
    const clientId  = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    return orders.map(o => {
      type LineItem = Record<string, unknown>;
      const addr  = (o.recipient_address ?? {}) as Record<string, string>;
      const items: OmsOrder['items'] = ((o.item_list ?? []) as LineItem[]).map(i => ({
        sku:       String(i.seller_sku ?? ''),
        name:      String(i.product_name ?? 'Item'),
        qty:       Number(i.quantity) || 1,
        unitPrice: Number(i.sale_price) || 0,
      }));

      return {
        id:         `TTK-${o.order_id}`,
        clientId,
        clientName: storeName,
        channel:    'tiktok' as const,
        orderDate:  new Date(Number(o.create_time) * 1000).toISOString(),
        status:     STATUS_MAP[String(o.order_status ?? '')] ?? 'pending',
        currency:   String(o.currency ?? 'MYR'),
        notes:      String(o.buyer_message ?? ''),
        items,
        shipping: {
          recipient:    addr.name ?? '',
          name:         addr.name ?? '',
          addressLine1: addr.full_address ?? '',
          addressLine2: '',
          city:         addr.district_info ?? '',
          state:        addr.region     ?? '',
          zip:          addr.zipcode    ?? '',
          country:      addr.region_code ?? '',
          phone:        addr.phone_number ?? '',
        },
        subtotal:     Number((o.payment as Record<string, unknown>)?.sub_total ?? o.total_amount ?? 0),
        shippingCost: Number((o.payment as Record<string, unknown>)?.shipping_fee ?? 0),
        tax:          0,
        total:        Number((o.payment as Record<string, unknown>)?.total_amount ?? o.total_amount ?? 0),
        source: {
          type:       'tiktok' as const,
          externalId: String(o.order_id),
          orderName:  String(o.order_id),
          ingestedAt: new Date().toISOString(),
        },
      };
    });
  }

  async pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult> {
    await this.post(creds, '/api/fulfillment/ship_order', {
      order_id:         fulfillment.externalOrderId,
      tracking_number:  fulfillment.trackingNumber ?? '',
      shipping_provider_id: fulfillment.carrier ?? '',
    });
    return { ok: true };
  }
}

export const tiktokAdapter = new TiktokAdapter();
