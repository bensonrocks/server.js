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
    // ── Inventory: pull stock levels from ZORT ──────────────────────────────────
    async fetchInventory(creds) {
        const zortCreds = assertCreds(creds);
        const all = [];
        let page = 1;
        while (true) {
            const raw = await zort_client_1.zortClient.get(zortCreds, '/Product/GetProducts', { page: String(page), limit: '100' });
            const list = raw.list ?? [];
            for (const p of list) {
                all.push((0, zort_mapper_1.mapZortProductToInventory)(p, this.channel));
            }
            if (list.length < 100)
                break;
            page++;
        }
        audit_log_service_1.auditLogService.save({
            channel: 'zort',
            operation: 'fetchInventory',
            externalId: null,
            rawPayload: { count: all.length },
            tenantId: String(creds.storeName ?? creds.storename ?? 'zort'),
        });
        return all;
    }
    // ── Inventory: push OMS stock levels → ZORT ─────────────────────────────────
    async syncInventory(creds, items) {
        const zortCreds = assertCreds(creds);
        for (const item of items) {
            if (!item.sku)
                continue;
            try {
                await zort_client_1.zortClient.postParams(zortCreds, '/Product/AdjustInventory', { sku: item.sku, qty: String(item.qty) });
            }
            catch (err) {
                // Log and continue — a single SKU failure should not abort the whole sync
                audit_log_service_1.auditLogService.save({
                    channel: 'zort',
                    operation: 'syncInventory:error',
                    externalId: item.sku,
                    rawPayload: { error: err.message },
                    tenantId: String(creds.storeName ?? creds.storename ?? 'zort'),
                });
            }
        }
    }
    // ── Products: full product list with pricing ─────────────────────────────────
    async fetchProducts(creds) {
        const zortCreds = assertCreds(creds);
        const all = [];
        let page = 1;
        while (true) {
            const raw = await zort_client_1.zortClient.get(zortCreds, '/Product/GetProducts', { page: String(page), limit: '100' });
            const list = raw.list ?? [];
            all.push(...list);
            if (list.length < 100)
                break;
            page++;
        }
        return all;
    }
    // ── Customers: pull contacts from ZORT ──────────────────────────────────────
    async fetchCustomers(creds) {
        const zortCreds = assertCreds(creds);
        const all = [];
        let page = 1;
        while (true) {
            const raw = await zort_client_1.zortClient.get(zortCreds, '/Contact/GetContacts', { page: String(page), limit: '100' });
            const list = raw.list ?? [];
            for (const c of list)
                all.push((0, zort_mapper_1.mapZortContactToCustomer)(c));
            if (list.length < 100)
                break;
            page++;
        }
        return all;
    }
    // ── Webhooks: register OMS callback URL with ZORT ───────────────────────────
    async registerWebhook(creds, url) {
        const zortCreds = assertCreds(creds);
        const body = {
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
        return zort_client_1.zortClient.post(zortCreds, '/Webhook/UpdateWebhook', body);
    }
}
exports.ZortAdapter = ZortAdapter;
exports.zortAdapter = new ZortAdapter();
//# sourceMappingURL=zort.adapter.js.map