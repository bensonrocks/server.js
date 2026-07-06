"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zortAdapter = exports.ZortAdapter = void 0;
const zort_client_1 = require("./zort.client");
const zort_mapper_1 = require("./zort.mapper");
const audit_log_service_1 = require("../../audit/audit-log.service");
// ─────────────────────────────────────────────────────────────────────────────
//  ZortAdapter — wraps ZORT API V4
//  Base: {{url}} in Postman — defaults to https://open.zortout.com
//        Override per-tenant via creds.baseUrl if needed.
//  Auth: headers storename / apikey / apisecret on every request
// ─────────────────────────────────────────────────────────────────────────────
function assertCreds(creds) {
    const storename = String(creds.storename ?? creds.storeName ?? '');
    const apikey = String(creds.apikey ?? '');
    const apisecret = String(creds.apisecret ?? '');
    if (!storename || !apikey || !apisecret) {
        throw Object.assign(new Error('ZORT requires storename, apikey and apisecret.'), { status: 401 });
    }
    return {
        storename,
        apikey,
        apisecret,
        baseUrl: creds.baseUrl ? String(creds.baseUrl) : undefined,
    };
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
            params.createdafter = opts.since; // confirmed: Postman GetOrders
        if (opts.until)
            params.createdbefore = opts.until;
        if (opts.status)
            params.status = opts.status;
        // ① Fetch raw — ZORT types stay inside this adapter
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
        const orders = raw.list ?? [];
        return orders.map(o => (0, zort_mapper_1.mapZortOrder)(o, this.channel, clientId, clientName, auditRef));
    }
    async pushShipment(creds, shipment) {
        const zortCreds = assertCreds(creds);
        const clientId = String(creds.storeName ?? creds.storename ?? 'zort');
        // Use ReadyToShip when a tracking number is provided; otherwise UpdateOrderStatus.
        // Both use query params only — no JSON body.
        const today = new Date().toISOString().slice(0, 10);
        let result;
        if (shipment.trackingNumber) {
            // POST /Order/ReadyToShip?id=&shipment=&trackingno=
            const params = {
                shipment: shipment.carrier ?? 'other',
                trackingno: shipment.trackingNumber,
                actionDate: today,
            };
            if (shipment.externalOrderId)
                params.number = shipment.externalOrderId;
            audit_log_service_1.auditLogService.save({
                channel: 'zort',
                operation: 'pushShipment:ReadyToShip',
                externalId: shipment.externalOrderId,
                rawPayload: params,
                tenantId: clientId,
            });
            result = await zort_client_1.zortClient.postParams(zortCreds, '/Order/ReadyToShip', params);
        }
        else {
            // POST /Order/UpdateOrderStatus?id=&status=3&actionDate=
            // status 3 = shipping (confirmed: numeric codes used in Postman collection)
            const params = {
                status: '3',
                actionDate: today,
            };
            if (shipment.externalOrderId)
                params.number = shipment.externalOrderId;
            audit_log_service_1.auditLogService.save({
                channel: 'zort',
                operation: 'pushShipment:UpdateOrderStatus',
                externalId: shipment.externalOrderId,
                rawPayload: params,
                tenantId: clientId,
            });
            result = await zort_client_1.zortClient.postParams(zortCreds, '/Order/UpdateOrderStatus', params);
        }
        const ok = result.status === true || (!result.error && result.code !== 0);
        return { ok, message: result.message ?? result.result ?? result.error ?? '' };
    }
}
exports.ZortAdapter = ZortAdapter;
exports.zortAdapter = new ZortAdapter();
//# sourceMappingURL=zort.adapter.js.map