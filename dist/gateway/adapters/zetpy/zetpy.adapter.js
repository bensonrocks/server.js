"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zetpyAdapter = exports.ZetpyAdapter = void 0;
const zetpy_client_1 = require("./zetpy.client");
const zetpy_mapper_1 = require("./zetpy.mapper");
const audit_log_service_1 = require("../../audit/audit-log.service");
// ─────────────────────────────────────────────────────────────────────────────
//  ZetpyAdapter — wraps Zetpy multi-channel aggregator API
//  Docs:  https://developers.zetpy.com  (login required)
//  Auth:  Authorization: Bearer <apiKey>
//  Rate:  60 req/min
//
//  ⚠️  SKELETON — all endpoint paths and field names are best-guess.
//  Search this file for TODO and verify against real Zetpy docs.
// ─────────────────────────────────────────────────────────────────────────────
function assertCreds(creds) {
    const key = String(creds.licenseKey ?? creds.apiKey ?? '');
    if (!key) {
        throw Object.assign(new Error('Zetpy requires an API key — obtain one from your Zetpy account settings.'), { status: 401 });
    }
    return key;
}
class ZetpyAdapter {
    channel = 'zetpy';
    requiresLicense = true;
    async fetchOrders(creds, opts = {}) {
        const apiKey = assertCreds(creds);
        const clientId = String(creds.storeName ?? 'zetpy');
        const clientName = String(creds.storeName ?? 'Zetpy Store');
        // TODO: confirm endpoint path (may be /orders or /api/orders)
        // TODO: confirm query param names
        const params = {
            per_page: String(opts.pageSize ?? 50),
            page: String(opts.page ?? 1),
        };
        if (opts.since)
            params['created_from'] = opts.since; // TODO: confirm param name
        if (opts.status)
            params['status'] = opts.status;
        // ① Fetch raw — Zetpy types stay inside this method
        const raw = await zetpy_client_1.zetpyClient.get({ apiKey }, '/orders', // TODO: confirm endpoint path
        params);
        // ② Persist raw payload before any transformation
        const auditRef = audit_log_service_1.auditLogService.save({
            channel: 'zetpy',
            operation: 'fetchOrders',
            externalId: null,
            rawPayload: raw,
            tenantId: clientId,
        });
        // ③ Map to Standard Models — ZetpyOrder never crosses this boundary
        const orders = raw.data ?? []; // TODO: confirm response envelope field
        return orders.map(o => (0, zetpy_mapper_1.mapZetpyOrder)(o, this.channel, clientId, clientName, auditRef));
    }
    async pushShipment(creds, shipment) {
        const apiKey = assertCreds(creds);
        const clientId = String(creds.storeName ?? 'zetpy');
        // TODO: confirm endpoint path (may be /orders/:id/ship or /fulfillments)
        const body = {
            tracking_number: shipment.trackingNumber,
            carrier: shipment.carrier ?? '',
            notify_buyer: shipment.notifyCustomer ?? true,
        };
        audit_log_service_1.auditLogService.save({
            channel: 'zetpy',
            operation: 'pushShipment',
            externalId: shipment.externalOrderId,
            rawPayload: body,
            tenantId: clientId,
        });
        const result = await zetpy_client_1.zetpyClient.post({ apiKey }, `/orders/${shipment.externalOrderId}/fulfill`, // TODO: confirm path
        body);
        return {
            ok: result.success !== false && !result.error,
            message: result.message ?? result.error,
        };
    }
}
exports.ZetpyAdapter = ZetpyAdapter;
exports.zetpyAdapter = new ZetpyAdapter();
//# sourceMappingURL=zetpy.adapter.js.map