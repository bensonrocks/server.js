import type { StandardCustomer } from './standard-customer';

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'packed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'returned';

export interface StandardOrderItem {
  sku:        string;
  name:       string;
  qty:        number;
  unitPrice:  number;
  discount:   number;
  total:      number;
  variantId?: string;
  barcode?:   string;
}

export interface StandardShippingAddress {
  recipient:    string;
  phone:        string;
  addressLine1: string;
  addressLine2: string;
  city:         string;
  state:        string;
  zip:          string;
  country:      string;
}

export interface StandardOrderSource {
  connector:  string;   // adapter that produced this: 'zort', 'shopee_direct', …
  rawId:      string;   // order ID in the source system
  auditRef?:  string;   // row ID saved in the audit log
  fetchedAt:  string;   // ISO 8601
}

export interface StandardOrder {
  id:           string;        // IDEALone-generated, e.g. "ZORT-SO-2024-001"
  externalId:   string;        // source system order ID
  externalRef:  string;        // human-readable order number from source
  channel:      string;        // connector channel name, e.g. 'zort'
  clientId:     string;        // IDEALone tenant ID
  clientName:   string;

  status:       OrderStatus;
  orderedAt:    string;        // ISO 8601

  currency:     string;
  subtotal:     number;
  shippingCost: number;
  tax:          number;
  discount:     number;
  total:        number;

  items:        StandardOrderItem[];
  customer:     StandardCustomer;
  shipping:     StandardShippingAddress;

  notes:        string;
  tags:         string[];

  source:       StandardOrderSource;
}
