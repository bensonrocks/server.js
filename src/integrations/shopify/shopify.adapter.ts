import type {
  IMarketplaceAdapter,
  AdapterCredentials,
  OmsOrder,
  OmsFulfillment,
  FulfillmentResult,
  WaybillInfo,
  OmsInventoryItem,
  InventorySyncResult,
  FetchOrdersOptions,
} from '../marketplace-gateway/marketplace.types';
import { mapShopifyOrder } from './shopify.mapper';

const API_VER = '2025-01';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function shopHost(domain: string): string {
  return domain.replace(/https?:\/\//, '').replace(/\/$/, '');
}

function authHeaders(token: string): Record<string, string> {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

async function shopifyGet<T>(shop: string, token: string, path: string): Promise<T> {
  const res  = await fetch(`https://${shop}/admin/api/${API_VER}${path}`, { headers: authHeaders(token) });
  const json = await res.json() as T & { errors?: unknown };
  if ((json as { errors?: unknown }).errors) {
    const e = (json as { errors: unknown }).errors;
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e));
  }
  return json;
}

async function shopifyPost<T>(shop: string, token: string, path: string, body: unknown): Promise<T> {
  const res  = await fetch(`https://${shop}/admin/api/${API_VER}${path}`, {
    method:  'POST',
    headers: authHeaders(token),
    body:    JSON.stringify(body),
  });
  const json = await res.json() as T & { errors?: unknown };
  if ((json as { errors?: unknown }).errors) {
    const e = (json as { errors: unknown }).errors;
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e));
  }
  return json;
}

async function shopifyGql<T>(shop: string, token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res  = await fetch(`https://${shop}/admin/api/${API_VER}/graphql.json`, {
    method:  'POST',
    headers: authHeaders(token),
    body:    JSON.stringify({ query, variables }),
  });
  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

// ── Shopify Adapter ───────────────────────────────────────────────────────────

export class ShopifyAdapter implements IMarketplaceAdapter {
  readonly channel = 'shopify' as const;

  private creds(creds: AdapterCredentials): { shop: string; token: string } {
    const shop  = shopHost(String(creds.shopDomain ?? ''));
    const token = String(creds.accessToken ?? '');
    if (!shop)  throw Object.assign(new Error('Shopify shop domain not configured'), { status: 400 });
    if (!token) throw Object.assign(new Error('Shopify access token not configured'), { status: 400 });
    return { shop, token };
  }

  async fetchOrders(creds: AdapterCredentials, opts: FetchOrdersOptions = {}): Promise<OmsOrder[]> {
    const { shop, token } = this.creds(creds);
    const since  = opts.since
      ? new Date(opts.since).toISOString()
      : new Date(Date.now() - 7 * 86400000).toISOString();
    const params = new URLSearchParams({
      status:          'any',
      limit:           String(opts.pageSize ?? 50),
      created_at_min:  since,
    });
    const json   = await shopifyGet<{ orders?: Record<string, unknown>[] }>(shop, token, `/orders.json?${params}`);
    const store  = String(creds.shopDomain ?? 'Shopify Store');
    return (json.orders ?? []).map(o => mapShopifyOrder(o, store));
  }

  async pushFulfillment(creds: AdapterCredentials, fulfillment: OmsFulfillment): Promise<FulfillmentResult> {
    const { shop, token } = this.creds(creds);
    const { externalOrderId, trackingNumber, carrier, trackingUrl, notifyCustomer, message } = fulfillment;

    type FO = { id: string; status: string };
    const foRes = await shopifyGet<{ fulfillment_orders?: FO[] }>(
      shop, token, `/orders/${externalOrderId}/fulfillment_orders.json`
    );
    const openFOs = (foRes.fulfillment_orders ?? []).filter(fo => fo.status === 'open');
    if (!openFOs.length) return { ok: false, skipped: true, reason: 'no open fulfillment orders' };

    const trackingInfo = trackingNumber
      ? { number: trackingNumber, ...(carrier && { company: carrier }), ...(trackingUrl && { url: trackingUrl }) }
      : undefined;

    await shopifyPost(shop, token, '/fulfillments.json', {
      fulfillment: {
        message:         message ?? 'Shipped via IdealOne OMS',
        notify_customer: notifyCustomer,
        ...(trackingInfo && { tracking_info: trackingInfo }),
        line_items_by_fulfillment_order: openFOs.map(fo => ({ fulfillment_order_id: fo.id })),
      },
    });
    return { ok: true };
  }

  async fetchWaybill(creds: AdapterCredentials, externalId: string): Promise<WaybillInfo> {
    const { shop, token } = this.creds(creds);
    type Fulfillment = { status: string; tracking_url?: string; tracking_number?: string; tracking_company?: string };
    const json = await shopifyGet<{ fulfillments?: Fulfillment[] }>(
      shop, token, `/orders/${externalId}/fulfillments.json`
    );
    const f = json.fulfillments?.find(x => x.status === 'success') ?? json.fulfillments?.[0];
    if (!f) throw new Error('No fulfillments found on this Shopify order yet');
    return {
      url:            f.tracking_url     ?? null,
      trackingNumber: f.tracking_number  ?? null,
      carrier:        f.tracking_company ?? null,
    };
  }

  async syncInventoryFromMarketplace(creds: AdapterCredentials): Promise<OmsInventoryItem[]> {
    const { shop, token } = this.creds(creds);

    type VariantNode = { id: string; sku: string; title: string; inventoryQuantity: number };
    type ProductNode = {
      id: string; title: string;
      variants: { nodes: VariantNode[] };
    };
    type ProductsData = {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        nodes: ProductNode[];
      };
    };

    const QUERY = `
      query Products($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title
            variants(first: 100) {
              nodes { id sku title inventoryQuantity }
            }
          }
        }
      }
    `;

    const items: OmsInventoryItem[] = [];
    let cursor: string | undefined;
    let hasNext = true;

    while (hasNext) {
      const data = await shopifyGql<ProductsData>(shop, token, QUERY, { first: 50, after: cursor ?? null });
      for (const product of data.products.nodes) {
        for (const v of product.variants.nodes) {
          if (!v.sku) continue;
          items.push({
            sku:          v.sku,
            name:         `${product.title} – ${v.title}`,
            unit:         'pcs',
            stockQty:     v.inventoryQuantity ?? 0,
            reservedQty:  0,
            reorderPoint: 0,
            costPrice:    0,
            sellPrice:    0,
          });
        }
      }
      hasNext = data.products.pageInfo.hasNextPage;
      cursor  = data.products.pageInfo.endCursor;
    }
    return items;
  }

  async syncInventoryToMarketplace(
    _creds: AdapterCredentials,
    _items: OmsInventoryItem[],
  ): Promise<InventorySyncResult> {
    // Full inventory push with location mapping is handled by lib/shopify-app/inventory.js
    return {
      pushed: 0,
      errors: ['Use POST /api/shopify/sync-inventory/push for full inventory sync with location mapping'],
    };
  }
}

export const shopifyAdapter = new ShopifyAdapter();
