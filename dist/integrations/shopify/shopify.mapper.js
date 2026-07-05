"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapShopifyOrder = mapShopifyOrder;
const FINANCIAL_STATUS = {
    paid: 'processing',
    authorized: 'confirmed',
    pending: 'pending',
    voided: 'cancelled',
    refunded: 'cancelled',
};
function mapShopifyAddress(addr) {
    const recipient = addr.name || [addr.first_name, addr.last_name].filter(Boolean).join(' ');
    return {
        recipient,
        name: recipient,
        addressLine1: addr.address1 ?? '',
        addressLine2: addr.address2 ?? '',
        city: addr.city ?? '',
        state: addr.province_code ?? addr.province ?? '',
        zip: addr.zip ?? '',
        country: addr.country_code ?? addr.country ?? '',
        phone: addr.phone ?? '',
    };
}
function mapShopifyOrder(order, storeName, resolveVariantSku) {
    const addr = (order.shipping_address ?? order.billing_address ?? {});
    const shipping = mapShopifyAddress(addr);
    const items = (order.line_items ?? []).map(i => ({
        sku: resolveVariantSku?.(i.variant_id) ?? String(i.sku ?? ''),
        name: String(i.name ?? 'Item'),
        qty: Number(i.quantity) || 1,
        unitPrice: Number(i.price) || 0,
        variantId: String(i.variant_id ?? ''),
    }));
    let status = FINANCIAL_STATUS[String(order.financial_status)] ?? 'pending';
    if (order.fulfillment_status === 'fulfilled')
        status = 'delivered';
    else if (order.fulfillment_status === 'partial')
        status = 'processing';
    if (order.cancelled_at)
        status = 'cancelled';
    const clientId = storeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const shippingCostRaw = order.total_shipping_price_set;
    const source = {
        type: 'shopify',
        externalId: String(order.id),
        orderName: String(order.name ?? ''),
        shippingName: shipping.recipient,
        ingestedAt: new Date().toISOString(),
    };
    return {
        id: `SHP-${order.id}`,
        clientId,
        clientName: storeName,
        channel: 'shopify',
        orderDate: String(order.created_at ?? new Date().toISOString()),
        status,
        currency: String(order.currency ?? 'USD'),
        notes: String(order.note ?? ''),
        items,
        shipping,
        subtotal: Number(order.subtotal_price ?? 0),
        shippingCost: Number(shippingCostRaw?.shop_money?.amount ?? 0),
        tax: Number(order.total_tax ?? 0),
        total: Number(order.total_price ?? 0),
        source,
    };
}
//# sourceMappingURL=shopify.mapper.js.map