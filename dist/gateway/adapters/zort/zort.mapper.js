"use strict";
// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zort/
// Maps raw ZORT API objects → IDEALone Standard Models.
// No ZORT types escape this file's return values.
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapZortOrder = mapZortOrder;
const ZORT_STATUS = {
    'pending': 'pending',
    'waiting': 'confirmed',
    'packed': 'packed',
    'shipping': 'shipped',
    'success': 'delivered',
    'returned': 'returned',
    'voided': 'cancelled',
    'failed shipment': 'pending', // needs re-processing
    'partial transfer': 'processing',
};
function toStatus(raw) {
    return ZORT_STATUS[raw.toLowerCase().trim()] ?? 'pending';
}
function toItems(list) {
    return list.map(i => ({
        sku: String(i.sku ?? ''),
        name: String(i.name ?? 'Item'),
        qty: Number(i.number) || 1,
        unitPrice: Number(i.pricepernumber) || 0,
        discount: Number(i.discount) || 0,
        total: Number(i.totalprice) || 0,
    }));
}
// ZORT returns a single address string — parse best-effort.
// TODO: verify whether ZORT has a structured address endpoint for order detail.
function toAddress(raw, name, phone) {
    return {
        recipient: name,
        phone,
        addressLine1: raw ?? '',
        addressLine2: '',
        city: '', // not available in ZORT single-string address
        state: '',
        zip: '',
        country: '',
    };
}
function mapZortOrder(raw, channel, clientId, clientName, auditRef) {
    const customer = {
        name: String(raw.customername ?? ''),
        phone: String(raw.customerphone ?? ''),
    };
    const items = toItems(raw.list ?? []);
    const shippingAmt = Number(raw.shippingamount ?? 0);
    const vatAmt = Number(raw.vatamount ?? 0);
    const total = Number(raw.amount ?? 0);
    return {
        id: `ZORT-${raw.number}`,
        externalId: String(raw.number),
        externalRef: String(raw.number),
        channel,
        clientId,
        clientName,
        status: toStatus(raw.status ?? ''),
        orderedAt: raw.orderdate
            ? new Date(raw.orderdate).toISOString()
            : new Date().toISOString(),
        currency: String(raw.currency ?? 'THB'),
        subtotal: Math.max(0, total - shippingAmt - vatAmt),
        shippingCost: shippingAmt,
        tax: vatAmt,
        discount: 0, // TODO: confirm if ZORT returns order-level discount
        total,
        items,
        customer,
        shipping: toAddress(raw.customeraddress ?? '', customer.name ?? '', customer.phone ?? ''),
        notes: String(raw.note ?? ''),
        tags: [],
        source: {
            connector: channel,
            rawId: String(raw.number),
            auditRef,
            fetchedAt: new Date().toISOString(),
        },
    };
}
//# sourceMappingURL=zort.mapper.js.map