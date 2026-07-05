// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zetpy/
//     Maps raw Zetpy API objects → IDEALone Standard Models.
//     Field names verified against the official Zetpy Postman collection.

import type { ZetpyOrder, ZetpyOrderItem }              from './zetpy.types';
import type { StandardOrder, StandardOrderItem,
              StandardShippingAddress, OrderStatus }    from '../../models/standard-order';
import type { StandardCustomer }                         from '../../models/standard-customer';

// Zetpy status strings  →  IDEALone StandardOrder.status
const ZETPY_STATUS: Record<string, OrderStatus> = {
  new:           'pending',
  unpaid:        'pending',
  ready_to_ship: 'processing',
  shipped:       'shipped',
  completed:     'delivered',
  canceled:      'cancelled',
  cancelled:     'cancelled',
  return:        'returned',
};

function toStatus(raw: string): OrderStatus {
  return ZETPY_STATUS[raw.toLowerCase().trim()] ?? 'pending';
}

function toItems(list: ZetpyOrderItem[]): StandardOrderItem[] {
  return list.map(i => ({
    sku:       String(i.sku         ?? ''),
    name:      String(i.name        ?? 'Item'),
    qty:       Number(i.quantity_sold)   || 1,
    unitPrice: Number(i.unit_price)      || 0,
    discount:  Number(i.discount_given)  || 0,
    total:     Number(i.total)           || 0,
  }));
}

function toAddress(o: ZetpyOrder): StandardShippingAddress {
  return {
    recipient:    String(o.shipping_name     ?? ''),
    phone:        String(o.shipping_phone    ?? ''),
    addressLine1: String(o.shipping_address  ?? ''),
    addressLine2: '',
    city:         String(o.shipping_city     ?? ''),
    state:        String(o.shipping_state    ?? ''),
    zip:          String(o.shipping_postcode ?? ''),
    country:      String(o.shipping_country  ?? ''),
  };
}

export function mapZetpyOrder(
  raw: ZetpyOrder,
  channel: string,
  clientId: string,
  clientName: string,
  auditRef?: string,
): StandardOrder {
  const customer: StandardCustomer = {
    name:  String(raw.shipping_name  ?? raw.billing_name  ?? ''),
    phone: String(raw.shipping_phone ?? raw.billing_phone ?? ''),
  };

  const items    = toItems(raw.items ?? []);
  const total    = Number(raw.total       ?? 0);
  const shipping = Number(raw.shipping_fee ?? 0);
  const subtotal = Number(raw.subtotal    ?? Math.max(0, total - shipping));

  return {
    id:          `ZTP-${raw.ref_no}`,
    externalId:  String(raw.ref_no),
    externalRef: String(raw.ref_no),
    channel,
    clientId,
    clientName,
    status:      toStatus(raw.status ?? ''),
    orderedAt:   raw.created_at
                   ? new Date(raw.created_at).toISOString()
                   : new Date(raw.created_date ?? Date.now()).toISOString(),
    currency:    String(raw.currency ?? 'MYR'),
    subtotal,
    shippingCost: shipping,
    tax:          Number(raw.tax     ?? 0),
    discount:     Number(raw.discount ?? 0),
    total,
    items,
    customer,
    shipping:    toAddress(raw),
    notes:       String(raw.message_to_seller ?? raw.seller_note ?? ''),
    // tag with source marketplace so OMS can show "Shopee Malaysia" etc.
    tags:        raw.app_name ? [raw.app_name] : [],
    source: {
      connector: channel,
      rawId:     String(raw.ref_no),
      auditRef,
      fetchedAt: new Date().toISOString(),
    },
  };
}
