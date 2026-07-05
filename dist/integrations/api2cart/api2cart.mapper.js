"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapApi2CartOrder = mapApi2CartOrder;
const STATUS_MAP = {
    'Pending': 'pending',
    'Processing': 'processing',
    'Shipped': 'shipped',
    'Delivered': 'delivered',
    'Complete': 'delivered',
    'Completed': 'delivered',
    'Cancelled': 'cancelled',
    'Canceled': 'cancelled',
    'Refunded': 'cancelled',
    'On Hold': 'confirmed',
    'Awaiting Payment': 'pending',
    'Awaiting Shipment': 'confirmed',
};
function mapAddress(addr) {
    const recipient = [addr.first_name, addr.last_name].filter(Boolean).join(' ') || addr.name || '';
    return {
        recipient,
        name: recipient,
        addressLine1: addr.address1 ?? addr.address ?? '',
        addressLine2: addr.address2 ?? '',
        city: addr.city ?? '',
        state: addr.state ?? addr.region ?? '',
        zip: addr.postcode ?? addr.zip ?? '',
        country: addr.country ?? '',
        phone: addr.phone ?? '',
    };
}
function mapApi2CartOrder(raw, storeName) {
    const billing = (raw.billing_address ?? {});
    const shippingA = (raw.shipping_address ?? billing);
    const shipping = mapAddress(shippingA);
    const clientId = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const items = (raw.order_products ?? []).map(i => ({
        sku: String(i.model ?? i.sku ?? ''),
        name: String(i.name ?? 'Item'),
        qty: Number(i.quantity) || 1,
        unitPrice: Number(i.price) || 0,
    }));
    return {
        id: `A2C-${raw.id}`,
        clientId,
        clientName: storeName,
        channel: 'api2cart',
        orderDate: String(raw.create_time ?? new Date().toISOString()),
        status: STATUS_MAP[String(raw.status ?? '')] ?? 'pending',
        currency: String(raw.currency ?? 'USD'),
        notes: String(raw.comment ?? ''),
        items,
        shipping,
        subtotal: Number(raw.subtotal ?? 0),
        shippingCost: Number(raw.shipping_price ?? 0),
        tax: Number(raw.tax ?? 0),
        total: Number(raw.total ?? 0),
        source: {
            type: 'api2cart',
            externalId: String(raw.id ?? ''),
            orderName: String(raw.id ?? ''),
            ingestedAt: new Date().toISOString(),
        },
    };
}
//# sourceMappingURL=api2cart.mapper.js.map