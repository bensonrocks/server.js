import type { IMarketplaceAdapter,
              AdapterCredentials,
              FetchOrdersOptions }             from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder }                  from '../../models/standard-order';
import type { StandardShipment,
              StandardFulfillmentResult }      from '../../models/standard-shipment';
import type { ZortOrderListResponse,
              ZortUpdateStatusBody,
              ZortUpdateStatusResponse }       from './zort.types';
import { zortClient }                          from './zort.client';
import { mapZortOrder }                        from './zort.mapper';
import { auditLogService }                     from '../../audit/audit-log.service';

// ─────────────────────────────────────────────────────────────────────────────
//  ZortAdapter — wraps ZORT API V4
//  Docs: https://developers.zortout.com (login required)
//  Base: https://open-api.zortout.com/v4
//  Auth: headers storename / apikey / apisecret
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
  return { storename, apikey, apisecret };
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
    if (opts.since)  params.createdafter = opts.since;    // TODO: confirm param name
    if (opts.status) params.status       = opts.status;

    // ① Fetch raw — ZORT types stay inside this method
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
    const orders = raw.list ?? [];  // TODO: confirm envelope field name
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

    const body: ZortUpdateStatusBody = {
      ordernumber:       shipment.externalOrderId,  // TODO: confirm field name
      status:            'Shipping',                 // TODO: confirm ZORT status string
      trackingnumber:    shipment.trackingNumber,    // TODO: confirm field name
      shippingprovider:  shipment.carrier ?? '',     // TODO: confirm field name
    };

    // Audit the outbound push too
    auditLogService.save({
      channel:    'zort',
      operation:  'pushShipment',
      externalId: shipment.externalOrderId,
      rawPayload: body,
      tenantId:   clientId,
    });

    const result = await zortClient.post<ZortUpdateStatusResponse>(
      zortCreds, '/Order/UpdateOrderStatus', body,
    );

    return { ok: !result.error, message: result.result ?? result.error };
  }
}

export const zortAdapter = new ZortAdapter();
