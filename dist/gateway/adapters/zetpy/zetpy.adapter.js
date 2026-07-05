"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zetpyAdapter = exports.ZetpyAdapter = void 0;
const zetpy_client_1 = require("./zetpy.client");
const zetpy_mapper_1 = require("./zetpy.mapper");
const audit_log_service_1 = require("../../audit/audit-log.service");
// ─────────────────────────────────────────────────────────────────────────────
//  ZetpyAdapter — wraps Zetpy multi-channel aggregator API
//  Base URL: https://api.zetpy.com
//  Auth:     POST /api/account/auth  { email, password } → Bearer JWT (60 min)
//  Docs:     https://developers.zetpy.com  (login required)
//  Rate:     60 req/min
// ─────────────────────────────────────────────────────────────────────────────
function assertCreds(creds) {
    const email = String(creds.email ?? '');
    const password = String(creds.password ?? '');
    if (!email || !password) {
        throw Object.assign(new Error('Zetpy requires an email address and password — log into app.zetpy.com to verify your credentials.'), { status: 401 });
    }
    return { email, password };
}
// Flatten Zetpy's nested { orders: { marketplace: { shop: { ref_no: order } } } }
// into a plain ZetpyOrder[]
function flattenOrders(nested) {
    const result = [];
    for (const shops of Object.values(nested ?? {})) {
        for (const orderMap of Object.values(shops)) {
            for (const order of Object.values(orderMap)) {
                result.push(order);
            }
        }
    }
    return result;
}
class ZetpyAdapter {
    channel = 'zetpy';
    requiresLicense = true;
    async fetchOrders(creds, opts = {}) {
        const auth = assertCreds(creds);
        const clientId = String(creds.storeName ?? 'zetpy');
        const clientName = String(creds.storeName ?? 'Zetpy Store');
        const params = {
            limit: String(opts.pageSize ?? 100),
            page: String(opts.page ?? 1),
            sort_by: 'created_at',
            sort: 'desc',
        };
        if (opts.since)
            params['date_from'] = opts.since.slice(0, 10); // YYYY-MM-DD
        if (opts.status)
            params['status'] = opts.status;
        // ① Fetch raw — Zetpy types stay inside this adapter
        const raw = await zetpy_client_1.zetpyClient.get(auth, '/api/orders/get-paginated', params);
        // ② Persist raw payload before any transformation
        const auditRef = audit_log_service_1.auditLogService.save({
            channel: 'zetpy',
            operation: 'fetchOrders',
            externalId: null,
            rawPayload: raw,
            tenantId: clientId,
        });
        // ③ Flatten nested structure, then map to Standard Models
        const orders = flattenOrders(raw.orders ?? {});
        return orders.map(o => (0, zetpy_mapper_1.mapZetpyOrder)(o, this.channel, clientId, clientName, auditRef));
    }
    async pushShipment(creds, shipment) {
        const auth = assertCreds(creds);
        const clientId = String(creds.storeName ?? 'zetpy');
        const refNo = shipment.externalOrderId;
        // ① Look up the order to get app_name and app_account_identifier
        const searchRaw = await zetpy_client_1.zetpyClient.get(auth, '/api/orders/search_by_ref', { ref_no: refNo });
        const found = flattenOrders(searchRaw.orders ?? {});
        if (!found.length) {
            return { ok: false, message: `Zetpy: order ${refNo} not found` };
        }
        const order = found[0];
        audit_log_service_1.auditLogService.save({
            channel: 'zetpy',
            operation: 'pushShipment',
            externalId: refNo,
            rawPayload: { refNo, order, shipment },
            tenantId: clientId,
        });
        // ② Call Ready-to-Ship with self_deliver + tracking number
        const body = {
            credentials: {
                app_account_identifier: order.app_account_identifier ?? order.app_internal_ref_id,
                app_name: order.app_name,
            },
            shipment_type: 'self_deliver',
            self_deliver_orders: [{ ref_no: refNo, tracking_number: shipment.trackingNumber }],
        };
        const result = await zetpy_client_1.zetpyClient.post(auth, '/api/orders/rts', body);
        const ok = result.success === true &&
            (result.successful_ref ?? []).includes(refNo);
        return {
            ok,
            externalId: refNo,
            message: result.message
                ?? (result.error ? `${result.error.code}: ${result.error.message}` : undefined),
        };
    }
    async fetchWaybill(creds, externalOrderId) {
        const auth = assertCreds(creds);
        const refNo = externalOrderId;
        // Look up the order to get app_name + app_account_identifier
        const searchRaw = await zetpy_client_1.zetpyClient.get(auth, '/api/orders/search_by_ref', { ref_no: refNo });
        const found = flattenOrders(searchRaw.orders ?? {});
        if (!found.length) {
            throw Object.assign(new Error(`Zetpy: order ${refNo} not found — cannot fetch waybill`), { status: 404 });
        }
        const order = found[0];
        const body = {
            credentials: {
                app_account_identifier: order.app_account_identifier ?? order.app_internal_ref_id,
                app_name: order.app_name,
            },
            orders: [refNo],
        };
        const result = await zetpy_client_1.zetpyClient.post(auth, '/api/orders/airway-bill', body);
        const url = result.url ?? result.urls?.[refNo];
        if (!result.success || !url) {
            throw new Error(result.message
                ?? (result.error ? `${result.error.code}: ${result.error.message}` : 'Zetpy AWB fetch failed'));
        }
        return { url };
    }
    async syncInventory(creds, items) {
        const auth = assertCreds(creds);
        const body = {
            products: items.map(i => ({
                sku: i.sku,
                quantity: i.qty,
            })),
        };
        audit_log_service_1.auditLogService.save({
            channel: 'zetpy',
            operation: 'syncInventory',
            externalId: null,
            rawPayload: body,
            tenantId: String(creds.storeName ?? 'zetpy'),
        });
        await zetpy_client_1.zetpyClient.post(auth, '/api/products/update-stock', body);
    }
}
exports.ZetpyAdapter = ZetpyAdapter;
exports.zetpyAdapter = new ZetpyAdapter();
//# sourceMappingURL=zetpy.adapter.js.map