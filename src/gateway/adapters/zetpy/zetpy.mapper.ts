// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zetpy/
// Maps raw Zetpy API objects → IDEALone Standard Models.

import type { ZetpyOrder, ZetpyOrderItem, ZetpyAddress } from './zetpy.types';
import type { StandardOrder, StandardOrderItem,
              StandardShippingAddress, OrderStatus }      from '../../models/standard-order';
import type { StandardCustomer }                          from '../../models/standard-customer';

// TODO: verify actual Zetpy status strings once docs are accessible
const ZETPY_STATUS: Record<string, OrderStatus> = {
  pending:          'pending',
  confirmed:        'confirmed',
  processing:       'processing',
  ready_to_ship:    'processing',
  packed:           'packed',
  shipped:          'shipped',
  in_transit:       'shipped',
  delivered:        'delivered',
  completed:        'delivered',
  cancelled:        'cancelled',
  canceled:         'cancelled',
  returned:         'returned',
};

function toStatus(raw: string): OrderStatus {
  return ZETPY_STATUS[raw.toLowerCase().trim()] ?? 'pending';
}

function toItems(list: ZetpyOrderItem[]): StandardOrderItem[] {
  return list.map(i => ({
    sku:       String(i.sku         ?? ''),
    name:      String(i.name        ?? 'Item'),
    qty:       Number(i.quantity)   || 1,
    unitPrice: Number(i.unit_price) || 0,
    discount:  Number(i.discount)   || 0,
    total:     Number(i.total_price) || 0,
  }));
}

function toAddress(addr: ZetpyAddress): StandardShippingAddress {
  return {
    recipient:    String(addr.name     ?? ''),
    phone:        String(addr.phone    ?? ''),
    addressLine1: String(addr.address1 ?? ''),
    addressLine2: String(addr.address2 ?? ''),
    city:         String(addr.city     ?? ''),
    state:        String(addr.state    ?? ''),
    zip:          String(addr.postcode ?? ''),
    country:      String(addr.country  ?? ''),
  };
}

export function mapZetpyOrder(
  raw: ZetpyOrder,
  channel: string,
  clientId: string,
  clientName: string,
  auditRef?: string,
): StandardOrder {
  const addr     = raw.shipping_address ?? ({} as ZetpyAddress);
  const customer: StandardCustomer = {
    name:  String(addr.name  ?? ''),
    phone: String(addr.phone ?? ''),
  };

  const items    = toItems(raw.items ?? []);
  const total    = Number(raw.total        ?? 0);
  const shipping = Number(raw.shipping_fee ?? 0);
  const subtotal = raw.subtotal !== undefined
    ? Number(raw.subtotal)
    : Math.max(0, total - shipping);

  return {
    id:           `ZTP-${raw.id}`,
    externalId:   String(raw.id),
    externalRef:  String(raw.order_number ?? raw.id),
    channel,
    clientId,
    clientName,
    status:       toStatus(raw.status ?? ''),
    orderedAt:    raw.created_at
                    ? new Date(raw.created_at).toISOString()
                    : new Date().toISOString(),
    currency:     String(raw.currency ?? 'MYR'),
    subtotal,
    shippingCost: shipping,
    tax:          0,
    discount:     0,
    total,
    items,
    customer,
    shipping:     toAddress(addr),
    notes:        String(raw.buyer_note ?? ''),
    tags:         raw.channel ? [raw.channel] : [],  // tag with original marketplace
    source: {
      connector: channel,
      rawId:     String(raw.id),
      auditRef,
      fetchedAt: new Date().toISOString(),
    },
  };
}
