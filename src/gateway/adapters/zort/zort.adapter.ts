import type { IMarketplaceAdapter,
              AdapterCredentials,
              FetchOrdersOptions }             from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder }                  from '../../models/standard-order';
import type { StandardInventory }             from '../../models/standard-inventory';
import type { StandardShipment,
              StandardFulfillmentResult }      from '../../models/standard-shipment';
import type { ZortOrderListResponse,
              ZortActionResponse,
              ZortProductListResponse,
              ZortContactListResponse,
              ZortWebhookBody,
              ZortWebhookResponse }            from './zort.types';
import { zortClient }                          from './zort.client';
import { mapZortOrder, mapZortProductToInventory, mapZortContactToCustomer } from './zort.mapper';
import { auditLogService }                     from '../../audit/audit-log.service';

// ─────────────────────────────────────────────────────────────────────────────
//  ZortAdapter — wraps ZORT API V4
//  Base: {{url}} in Postman — defaults to https://open.zortout.com
//        Override per-tenant via creds.baseUrl if needed.
//  Auth: headers storename / apikey / apisecret on every request
// ─────────────────────────────────────────────────────────────────────────────

function assertCreds(creds: AdapterCredentials) {
  const storename = String(creds.storename ?? creds.storeName ?? '');
  const apikey    = String(creds.apikey    ?? '');
  const apisecret = String(creds.apisecret ?? '');
  if (!storename || !apikey || !apisecret) {
    throw Object.assign(
      new Error('ZORT requires storename, apikey and apisecret.'),
      { status: 401 },
    );
  }
  return {
    storename,
    apikey,
    apisecret,
    baseUrl: creds.baseUrl ? String(creds.baseUrl) : undefined,
  };
}

export class ZortAdapter implements IMarketplaceAdapter {
  readonly channel         = 'zort';
  readonly requiresLicense = true;

  async fetchOrders(
    creds: AdapterCredentials,
    opts: FetchOrdersOptions = {},
  ): Promise<StandardOrder[]> {
    const zortCreds  = assertCreds(creds);
    const clientId   = String(creds.storeName ?? creds.storename ?? 'zort');
    const clientName = String(creds.storeName ?? 'ZORT Store');

    const params: Record<string, string> = {
      page:  String(opts.page     ?? 1),
      limit: String(opts.pageSize ?? 50),
    };
    if (opts.since)  params.createdafter = opts.since;   // confirmed: Postman GetOrders
    if (opts.until)  params.createdbefore = opts.until;
    if (opts.status) params.status        = opts.status;

    // ① Fetch raw — ZORT types stay inside this adapter
    const raw = await zortClient.get<ZortOrderListResponse>(
      zortCreds, '/Order/GetOrders', params,
    );

    // ② Persist raw payload before any transformation (audit requirement)
    const auditRef = auditLogService.save({
      channel:    'zort',
      operation:  'fetchOrders',
      externalId: null,
      rawPayload: raw,
      tenantId:   clientId,
    });

    // ③ Map to Standard Models — ZortOrder never crosses this boundary
    const orders = raw.list ?? [];
    return orders.map(o =>
      mapZortOrder(o, this.channel, clientId, clientName, auditRef),
    );
  }

  async pushShipment(
    creds: AdapterCredentials,
    shipment: StandardShipment,
  ): Promise<StandardFulfillmentResult> {
    const zortCreds = assertCreds(creds);
    const clientId  = String(creds.storeName ?? creds.storename ?? 'zort');

    // Use ReadyToShip when a tracking number is provided; otherwise UpdateOrderStatus.
    // Both use query params only — no JSON body.
    const today = new Date().toISOString().slice(0, 10);

    let result: ZortActionResponse;

    if (shipment.trackingNumber) {
      // POST /Order/ReadyToShip?id=&shipment=&trackingno=
      const params: Record<string, string> = {
        shipment:   shipment.carrier ?? 'other',
        trackingno: shipment.trackingNumber,
        actionDate: today,
      };
      if (shipment.externalOrderId) params.number = shipment.externalOrderId;

      auditLogService.save({
        channel:    'zort',
        operation:  'pushShipment:ReadyToShip',
        externalId: shipment.externalOrderId,
        rawPayload: params,
        tenantId:   clientId,
      });

      result = await zortClient.postParams<ZortActionResponse>(
        zortCreds, '/Order/ReadyToShip', params,
      );
    } else {
      // POST /Order/UpdateOrderStatus?id=&status=3&actionDate=
      // status 3 = shipping (confirmed: numeric codes used in Postman collection)
      const params: Record<string, string> = {
        status:     '3',
        actionDate: today,
      };
      if (shipment.externalOrderId) params.number = shipment.externalOrderId;

      auditLogService.save({
        channel:    'zort',
        operation:  'pushShipment:UpdateOrderStatus',
        externalId: shipment.externalOrderId,
        rawPayload: params,
        tenantId:   clientId,
      });

      result = await zortClient.postParams<ZortActionResponse>(
        zortCreds, '/Order/UpdateOrderStatus', params,
      );
    }

    const ok = result.status === true || (!result.error && result.code !== 0);
    return { ok, message: result.message ?? result.result ?? result.error ?? '' };
  }

  // ── Inventory: pull stock levels from ZORT ──────────────────────────────────

  async fetchInventory(creds: AdapterCredentials): Promise<StandardInventory[]> {
    const zortCreds = assertCreds(creds);
    const all: StandardInventory[] = [];
    let page = 1;

    while (true) {
      const raw = await zortClient.get<ZortProductListResponse>(
        zortCreds, '/Product/GetProducts', { page: String(page), limit: '100' },
      );
      const list = raw.list ?? [];
      for (const p of list) {
        all.push(mapZortProductToInventory(p, this.channel));
      }
      if (list.length < 100) break;
      page++;
    }

    auditLogService.save({
      channel:    'zort',
      operation:  'fetchInventory',
      externalId: null,
      rawPayload: { count: all.length },
      tenantId:   String(creds.storeName ?? creds.storename ?? 'zort'),
    });

    return all;
  }

  // ── Inventory: push OMS stock levels → ZORT ─────────────────────────────────

  async syncInventory(creds: AdapterCredentials, items: StandardInventory[]): Promise<void> {
    const zortCreds = assertCreds(creds);
    for (const item of items) {
      if (!item.sku) continue;
      try {
        await zortClient.postParams<ZortActionResponse>(
          zortCreds, '/Product/AdjustInventory',
          { sku: item.sku, qty: String(item.qty) },
        );
      } catch (err) {
        // Log and continue — a single SKU failure should not abort the whole sync
        auditLogService.save({
          channel:    'zort',
          operation:  'syncInventory:error',
          externalId: item.sku,
          rawPayload: { error: (err as Error).message },
          tenantId:   String(creds.storeName ?? creds.storename ?? 'zort'),
        });
      }
    }
  }

  // ── Products: full product list with pricing ─────────────────────────────────

  async fetchProducts(creds: AdapterCredentials): Promise<ZortProductListResponse['list']> {
    const zortCreds = assertCreds(creds);
    const all: NonNullable<ZortProductListResponse['list']> = [];
    let page = 1;
    while (true) {
      const raw = await zortClient.get<ZortProductListResponse>(
        zortCreds, '/Product/GetProducts', { page: String(page), limit: '100' },
      );
      const list = raw.list ?? [];
      all.push(...list);
      if (list.length < 100) break;
      page++;
    }
    return all;
  }

  // ── Customers: pull contacts from ZORT ──────────────────────────────────────

  async fetchCustomers(creds: AdapterCredentials) {
    const zortCreds = assertCreds(creds);
    const all: ReturnType<typeof mapZortContactToCustomer>[] = [];
    let page = 1;
    while (true) {
      const raw = await zortClient.get<ZortContactListResponse>(
        zortCreds, '/Contact/GetContacts', { page: String(page), limit: '100' },
      );
      const list = raw.list ?? [];
      for (const c of list) all.push(mapZortContactToCustomer(c));
      if (list.length < 100) break;
      page++;
    }
    return all;
  }

  // ── Webhooks: register OMS callback URL with ZORT ───────────────────────────

  async registerWebhook(creds: AdapterCredentials, url: string): Promise<ZortWebhookResponse> {
    const zortCreds = assertCreds(creds);
    const body: ZortWebhookBody = {
      url,
      events: [
        'order.created',
        'order.modified',
        'order.status_changed',
        'order.tracking_changed',
        'product.quantity_changed',
        'contact.created',
        'contact.modified',
      ],
    };
    return zortClient.post<ZortWebhookResponse>(zortCreds, '/Webhook/UpdateWebhook', body);
  }
}

export const zortAdapter = new ZortAdapter();
