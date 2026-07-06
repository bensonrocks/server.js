// ⚠️  INTERNAL — must never be imported outside src/gateway/adapters/zort/
// Maps raw ZORT API objects → IDEALone Standard Models.
// Field names verified against ZORT Api v4.0 Postman collection (2026-01-01).

import type { ZortOrder, ZortOrderItem } from './zort.types';
import type { StandardOrder, StandardOrderItem,
              StandardShippingAddress, OrderStatus } from '../../models/standard-order';
import type { StandardCustomer }                     from '../../models/standard-customer';

// Status strings returned in GET /Order/GetOrders list response
const ZORT_STATUS: Record<string, OrderStatus> = {
  'pending':          'pending',
  'waiting':          'confirmed',
  'packed':           'packed',
  'shipping':         'shipped',
  'success':          'delivered',
  'returned':         'returned',
  'voided':           'cancelled',
  'failed shipment':  'pending',
  'partial transfer': 'processing',
};

function toStatus(raw: string): OrderStatus {
  return ZORT_STATUS[raw.toLowerCase().trim()] ?? 'pending';
}

function toItems(list: ZortOrderItem[]): StandardOrderItem[] {
  return list.map(i => ({
    sku:       String(i.sku            ?? ''),
    name:      String(i.name           ?? 'Item'),
    qty:       Number(i.number)        || 1,
    unitPrice: Number(i.pricepernumber) || 0,
    discount:  Number(i.discount)      || 0,
    total:     Number(i.totalprice)    || 0,
  }));
}

// ZORT returns customeraddress as a single string — no structured components available.
function toAddress(raw: string | undefined, name: string, phone: string): StandardShippingAddress {
  return {
    recipient:    name,
    phone,
    addressLine1: raw ?? '',
    addressLine2: '',
    city:         '',
    state:        '',
    zip:          '',
    country:      '',
  };
}

export function mapZortOrder(
  raw: ZortOrder,
  channel: string,
  clientId: string,
  clientName: string,
  auditRef?: string,
): StandardOrder {
  const customer: StandardCustomer = {
    name:  String(raw.customername  ?? ''),
    phone: String(raw.customerphone ?? ''),
  };

  const items = toItems(raw.list ?? []);

  const shippingAmt = Number(raw.shippingamount ?? 0);
  const vatAmt      = Number(raw.vatamount      ?? 0);
  const total       = Number(raw.amount         ?? 0);

  return {
    id:           `ZORT-${raw.number}`,
    externalId:   String(raw.number),
    externalRef:  String(raw.number),
    channel,
    clientId,
    clientName,
    status:       toStatus(raw.status ?? ''),
    orderedAt:    raw.orderdate
                    ? new Date(raw.orderdate).toISOString()
                    : new Date().toISOString(),
    currency:     String(raw.currency ?? 'THB'),
    subtotal:     Math.max(0, total - shippingAmt - vatAmt),
    shippingCost: shippingAmt,
    tax:          vatAmt,
    discount:     0,
    total,
    items,
    customer,
    shipping:     toAddress(raw.customeraddress ?? '', customer.name ?? '', customer.phone ?? ''),
    notes:        String(raw.note ?? raw.description ?? ''),
    tags:         [],
    source: {
      connector: channel,
      rawId:     String(raw.number),
      auditRef,
      fetchedAt:  new Date().toISOString(),
    },
  };
}
