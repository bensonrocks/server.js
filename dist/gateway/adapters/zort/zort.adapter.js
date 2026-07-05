"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zortAdapter = exports.ZortAdapter = void 0;
const zort_client_1 = require("./zort.client");
const zort_mapper_1 = require("./zort.mapper");
const audit_log_service_1 = require("../../audit/audit-log.service");
// ─────────────────────────────────────────────────────────────────────────────
//  ZortAdapter — wraps ZORT API V4
//  Docs: https://developers.zortout.com (login required)
//  Base: https://open-api.zortout.com/v4
//  Auth: headers storename / apikey / apisecret
// ─────────────────────────────────────────────────────────────────────────────
function assertCreds(creds) {
    const storename = String(creds.storename ?? creds.storeName ?? '');
    const apikey = String(creds.apikey ?? '');
    const apisecret = String(creds.apisecret ?? '');
    if (!storename || !apikey || !apisecret) {
        throw Object.assign(new Error('ZORT requires storename, apikey and apisecret.'), { status: 401 });
    }
    return { storename, apikey, apisecret };
}
class ZortAdapter {
    channel = 'zort';
    requiresLicense = true;
    async fetchOrders(creds, opts = {}) {
        const zortCreds = assertCreds(creds);
        const clientId = String(creds.storeName ?? creds.storename ?? 'zort');
        const clientName = String(creds.storeName ?? 'ZORT Store');
        const params = {
            page: String(opts.page ?? 1),
            limit: String(opts.pageSize ?? 50),
        };
        if (opts.since)
            params.createdafter = opts.since; // TODO: confirm param name
        if (opts.status)
            params.status = opts.status;
        // ① Fetch raw — ZORT types stay inside this method
        const raw = await zort_client_1.zortClient.get(zortCreds, '/Order/GetOrders', params);
        // ② Persist raw payload before any transformation (audit requirement)
        const auditRef = audit_log_service_1.auditLogService.save({
            channel: 'zort',
            operation: 'fetchOrders',
            externalId: null,
            rawPayload: raw,
            tenantId: clientId,
        });
        // ③ Map to Standard Models — ZortOrder never crosses this boundary
        const orders = raw.list ?? []; // TODO: confirm envelope field name
        return orders.map(o => (0, zort_mapper_1.mapZortOrder)(o, this.channel, clientId, clientName, auditRef));
    }
    async pushShipment(creds, shipment) {
        const zortCreds = assertCreds(creds);
        const clientId = String(creds.storeName ?? creds.storename ?? 'zort');
        const body = {
            ordernumber: shipment.externalOrderId, // TODO: confirm field name
            status: 'Shipping', // TODO: confirm ZORT status string
            trackingnumber: shipment.trackingNumber, // TODO: confirm field name
            shippingprovider: shipment.carrier ?? '', // TODO: confirm field name
        };
        // Audit the outbound push too
        audit_log_service_1.auditLogService.save({
            channel: 'zort',
            operation: 'pushShipment',
            externalId: shipment.externalOrderId,
            rawPayload: body,
            tenantId: clientId,
        });
        const result = await zort_client_1.zortClient.post(zortCreds, '/Order/UpdateOrderStatus', body);
        return { ok: !result.error, message: result.result ?? result.error };
    }
}
exports.ZortAdapter = ZortAdapter;
exports.zortAdapter = new ZortAdapter();
//# sourceMappingURL=zort.adapter.js.map