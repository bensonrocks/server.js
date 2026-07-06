import type { IMarketplaceAdapter,
              AdapterCredentials,
              FetchOrdersOptions }             from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder }                  from '../../models/standard-order';
import type { StandardShipment,
              StandardFulfillmentResult }      from '../../models/standard-shipment';
import type { ZortOrderListResponse,
              ZortActionResponse }             from './zort.types';
import { zortClient }                          from './zort.client';
import { mapZortOrder }                        from './zort.mapper';
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
}

export const zortAdapter = new ZortAdapter();
