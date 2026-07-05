import type { IMarketplaceAdapter,
              AdapterCredentials,
              FetchOrdersOptions }             from '../../interfaces/marketplace-adapter.interface';
import type { StandardOrder }                  from '../../models/standard-order';
import type { StandardShipment,
              StandardFulfillmentResult }      from '../../models/standard-shipment';
import type { ZetpyOrderListResponse,
              ZetpyFulfillBody,
              ZetpyFulfillResponse }           from './zetpy.types';
import { zetpyClient }                         from './zetpy.client';
import { mapZetpyOrder }                       from './zetpy.mapper';
import { auditLogService }                     from '../../audit/audit-log.service';

// ─────────────────────────────────────────────────────────────────────────────
//  ZetpyAdapter — wraps Zetpy multi-channel aggregator API
//  Docs:  https://developers.zetpy.com  (login required)
//  Auth:  Authorization: Bearer <apiKey>
//  Rate:  60 req/min
//
//  ⚠️  SKELETON — all endpoint paths and field names are best-guess.
//  Search this file for TODO and verify against real Zetpy docs.
// ─────────────────────────────────────────────────────────────────────────────

function assertCreds(creds: AdapterCredentials): string {
  const key = String(creds.licenseKey ?? creds.apiKey ?? '');
  if (!key) {
    throw Object.assign(
      new Error('Zetpy requires an API key — obtain one from your Zetpy account settings.'),
      { status: 401 },
    );
  }
  return key;
}

export class ZetpyAdapter implements IMarketplaceAdapter {
  readonly channel         = 'zetpy';
  readonly requiresLicense = true;

  async fetchOrders(
    creds: AdapterCredentials,
    opts: FetchOrdersOptions = {},
  ): Promise<StandardOrder[]> {
    const apiKey     = assertCreds(creds);
    const clientId   = String(creds.storeName ?? 'zetpy');
    const clientName = String(creds.storeName ?? 'Zetpy Store');

    // TODO: confirm endpoint path (may be /orders or /api/orders)
    // TODO: confirm query param names
    const params: Record<string, string> = {
      per_page: String(opts.pageSize ?? 50),
      page:     String(opts.page     ?? 1),
    };
    if (opts.since)  params['created_from'] = opts.since;  // TODO: confirm param name
    if (opts.status) params['status']        = opts.status;

    // ① Fetch raw — Zetpy types stay inside this method
    const raw = await zetpyClient.get<ZetpyOrderListResponse>(
      { apiKey },
      '/orders',   // TODO: confirm endpoint path
      params,
    );

    // ② Persist raw payload before any transformation
    const auditRef = auditLogService.save({
      channel:    'zetpy',
      operation:  'fetchOrders',
      externalId: null,
      rawPayload: raw,
      tenantId:   clientId,
    });

    // ③ Map to Standard Models — ZetpyOrder never crosses this boundary
    const orders = raw.data ?? [];   // TODO: confirm response envelope field
    return orders.map(o =>
      mapZetpyOrder(o, this.channel, clientId, clientName, auditRef),
    );
  }

  async pushShipment(
    creds: AdapterCredentials,
    shipment: StandardShipment,
  ): Promise<StandardFulfillmentResult> {
    const apiKey   = assertCreds(creds);
    const clientId = String(creds.storeName ?? 'zetpy');

    // TODO: confirm endpoint path (may be /orders/:id/ship or /fulfillments)
    const body: ZetpyFulfillBody = {
      tracking_number: shipment.trackingNumber,
      carrier:         shipment.carrier ?? '',
      notify_buyer:    shipment.notifyCustomer ?? true,
    };

    auditLogService.save({
      channel:    'zetpy',
      operation:  'pushShipment',
      externalId: shipment.externalOrderId,
      rawPayload: body,
      tenantId:   clientId,
    });

    const result = await zetpyClient.post<ZetpyFulfillResponse>(
      { apiKey },
      `/orders/${shipment.externalOrderId}/fulfill`,  // TODO: confirm path
      body,
    );

    return {
      ok:      result.success !== false && !result.error,
      message: result.message ?? result.error,
    };
  }
}

export const zetpyAdapter = new ZetpyAdapter();
